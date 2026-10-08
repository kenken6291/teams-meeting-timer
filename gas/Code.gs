/**
 * ============================================================
 *  Teams Meeting Timer — GAS Backend (Code.gs)
 * ============================================================
 *  【社外に文字情報を出さない設計】
 *   このサーバー（Google）が受け取り・保存するのは「数字」と「鍵（ハッシュ）」だけです。
 *     - 持ち時間（分）の並び、議題番号、残り秒数、終了予定時刻、通知しきい値
 *     - ルーム ID（ルーム名のハッシュ。名前そのものは届かない）
 *     - 合言葉のハッシュ（ブラウザでハッシュ化済みのもの）と閲覧キー
 *   議題名・発表者名・会議名・画像・資料は受け取りません。
 *   万一送られてきても、保存する前に数字以外を捨てます。
 *   例外：進行役の会員情報（メールアドレス・ニックネーム）は会員認証のため会員シートに保存します。
 *
 *  役割
 *   1. タイマー状態の保持（ルーム単位 / Script Properties）
 *   2. フロントエンド向け JSON API（doGet / doPost）
 *   3. 残り時間しきい値での Teams 通知（議題名なしの Adaptive Card）
 *
 *  Script Properties
 *   TEAMS_WEBHOOK_URL           : Teams Workflows の Webhook URL
 *   TEAMS_WEBHOOK_URL__<roomId> : 任意。ルーム別の投稿先（roomId は画面の「共有URL」で確認）
 *   MASTER_TOKEN                : 非常鍵（setup() で自動生成）。合言葉を忘れたときの復旧用
 *   MEMBERS_SHEET_ID / PEPPER   : 会員認証用（setup() で自動作成）
 *   ALLOWED_EMAIL_DOMAINS       : 任意。登録できるメールのドメイン（例 azbil.com）
 *   APP_URL                     : 任意。仮パスワードのメールに載せる画面の URL
 *
 *  初回は エディタで setup() を実行 → 権限承認。
 * ============================================================
 */

const CONFIG = Object.freeze({
  DEFAULT_THRESHOLDS: [300, 60, 0],     // 秒。残り5分 / 1分 / 終了
  STALE_SEC: 120,                       // しきい値をこれ以上過ぎていたら通知は送らない
  MAX_ITEMS: 50,
  MAX_STATE_BYTES: 9000,
  TZ: 'Asia/Tokyo',
  ROOM_PREFIX: 'room:',
  AUTH_PREFIX: 'auth:',
  ACTIVE_ROOMS_KEY: 'activeRooms',
  MAX_ROOMS: 200,
  FAIL_LIMIT: 10,
  LOCK_SEC: 600,
});

const VIEWER_ACTIONS = ['state', 'check'];
const COMMAND_ACTIONS = ['start', 'pause', 'toggle', 'reset', 'adjust', 'select',
  'next', 'prev', 'setDuration', 'setAgenda', 'setOptions'];

/* ------------------------------------------------------------
 *  Web API エントリポイント
 * ---------------------------------------------------------- */

function doGet(e) {
  return respond_(safeRoute_((e && e.parameter) || {}, 'GET'));
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return respond_({ ok: false, error: 'invalid_json' });
  }
  return respond_(safeRoute_(body, 'POST'));
}

function respond_(obj) {
  obj.serverNow = Date.now();
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeRoute_(p, method) {
  try {
    return route_(p, method);
  } catch (err) {
    // ログには受け取った内容を書かない（エラーの種類だけ）
    const message = String((err && err.message) || err);
    if (!(err && err.code)) console.error('route error: ' + message);
    return { ok: false, error: (err && err.code) || message, message: message };
  }
}

function route_(p, method) {
  const action = String(p.action || 'state');

  // 会員認証（ルーム指定は不要）
  if (AUTH_ACTIONS.indexOf(action) >= 0) return handleAuthAction_(action, p, method);

  const room = sanitizeRoom_(p.room);
  if (!room) return { ok: false, error: 'invalid_room' };

  // 認証不要：ルームの有無確認と新規作成
  if (action === 'roomInfo') {
    return { ok: true, exists: !!loadAuth_(room) };
  }
  if (action === 'createRoom') {
    if (method !== 'POST') return { ok: false, error: 'method_not_allowed' };
    const user = requireSession_(p.session, false);   // ルーム作成はログインした進行役のみ
    createRoom_(room, p.passToken, user.email);
    return { ok: true, role: 'admin', state: loadState_(room) };
  }

  const auth = authenticate_(room, p.token);
  if (!auth.role) return { ok: false, error: auth.error };
  const role = auth.role;

  // 進行役（合言葉）の操作はログインも必須。閲覧キー（OBS・閲覧画面）は不要。非常鍵は例外
  let user = null;
  if (role === 'admin' && !auth.master) user = requireSession_(p.session, false);

  const isViewerAction = VIEWER_ACTIONS.indexOf(action) >= 0;
  if (!isViewerAction && role !== 'admin') return { ok: false, error: 'forbidden' };
  if (method === 'GET' && !isViewerAction) return { ok: false, error: 'method_not_allowed' };

  const base = { ok: true, role: role };

  if (action === 'state') return Object.assign(base, { state: loadState_(room) });

  if (action === 'check') {
    const notified = runAlertCheck_(room);
    return Object.assign(base, { state: loadState_(room), notified: notified });
  }

  if (COMMAND_ACTIONS.indexOf(action) >= 0) {
    const opId = String(p.opId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    mutate_(room, function (s, now) {
      if (opId && s.ops.indexOf(opId) >= 0) return;   // 再送された同じ操作は無視
      applyCommand_(s, action, p, now);
      if (opId) s.ops = s.ops.concat(opId).slice(-20);
    });
    if (action === 'adjust' || action === 'start' || action === 'toggle') runAlertCheck_(room);
    return Object.assign(base, { state: loadState_(room) });
  }

  switch (action) {
    case 'testNotify': {
      const res = postTeams_(room, buildTestCard_(loadState_(room)));
      if (!res.ok) throw new Error('Teams への送信に失敗しました: ' + (res.error || res.code));
      return Object.assign(base, { sent: true });
    }
    case 'shareInfo':
      return Object.assign(base, {
        info: { viewerToken: (loadAuth_(room) || {}).viewerKey || '', hasWebhook: !!webhookUrl_(room) },
      });
    case 'changePasscode':
      changePasscode_(room, p.newPassToken);
      return Object.assign(base, { changed: true });
    case 'rotateViewerKey':
      return Object.assign(base, { viewerKey: rotateViewerKey_(room) });
    case 'deleteRoom': {
      const owner = (loadAuth_(room) || {}).owner;
      if (!auth.master && owner && (!user || user.email !== owner)) {
        return { ok: false, error: 'not_owner', message: 'ルームを削除できるのは作成した人だけです' };
      }
      deleteRoom_(room);
      return Object.assign(base, { deleted: true });
    }
    default:
      return { ok: false, error: 'unknown_action' };
  }
}

/* ------------------------------------------------------------
 *  共通
 * ---------------------------------------------------------- */

function props_() {
  return PropertiesService.getScriptProperties();
}

function prop_(key, def) {
  const v = props_().getProperty(key);
  return (v === null || v === '') ? (def === undefined ? null : def) : v;
}

/** ルーム ID はブラウザでルーム名をハッシュ化した 32 桁の 16 進数 */
function sanitizeRoom_(room) {
  const r = String(room || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(r) ? r : null;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function toNumber_(v, name) {
  const n = Number(v);
  if (!isFinite(n)) throw new Error(name + ' が数値ではありません');
  return n;
}

function truthy_(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/* ------------------------------------------------------------
 *  ルームと合言葉
 *  ブラウザは「合言葉そのもの」ではなく sha256('tmt-pass:' + roomId + ':' + 合言葉) を送る。
 *  サーバーはそれをさらにソルト付きでハッシュ化して保存する。
 * ---------------------------------------------------------- */

function loadAuth_(room) {
  const raw = props_().getProperty(CONFIG.AUTH_PREFIX + room);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function saveAuth_(room, a) {
  props_().setProperty(CONFIG.AUTH_PREFIX + room, JSON.stringify({
    salt: a.salt, hash: a.hash, viewerKey: a.viewerKey, owner: a.owner || '', createdAt: a.createdAt, updatedAt: Date.now(),
  }));
}

function validPassToken_(t) {
  const s = String(t || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error('合言葉の形式が正しくありません');
  return s;
}

function newViewerKey_() {
  return 'v' + (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 31);
}

function createRoom_(room, passToken, ownerEmail) {
  const t = validPassToken_(passToken);
  withLock_(function () {
    if (loadAuth_(room)) throw new Error('このルーム名はすでに使われています。別の名前にするか、合言葉で入室してください');
    const count = Object.keys(props_().getProperties())
      .filter(function (k) { return k.indexOf(CONFIG.AUTH_PREFIX) === 0; }).length;
    if (count >= CONFIG.MAX_ROOMS) throw new Error('ルーム数が上限に達しています');
    const salt = Utilities.getUuid();
    saveAuth_(room, { salt: salt, hash: sha256Hex_(salt + ':' + t), viewerKey: newViewerKey_(), owner: ownerEmail || '', createdAt: Date.now() });
    saveState_(defaultState_(room));
  });
}

function changePasscode_(room, newPassToken) {
  const t = validPassToken_(newPassToken);
  withLock_(function () {
    const a = loadAuth_(room);
    if (!a) throw new Error('ルームが見つかりません');
    a.salt = Utilities.getUuid();
    a.hash = sha256Hex_(a.salt + ':' + t);
    saveAuth_(room, a);
  });
}

function rotateViewerKey_(room) {
  return withLock_(function () {
    const a = loadAuth_(room);
    if (!a) throw new Error('ルームが見つかりません');
    a.viewerKey = newViewerKey_();
    saveAuth_(room, a);
    return a.viewerKey;
  });
}

function deleteRoom_(room) {
  withLock_(function () {
    props_().deleteProperty(CONFIG.AUTH_PREFIX + room);
    props_().deleteProperty(CONFIG.ROOM_PREFIX + room);
    const rooms = getActiveRooms_();
    const i = rooms.indexOf(room);
    if (i >= 0) { rooms.splice(i, 1); setActiveRooms_(rooms); }
  });
}

function authenticate_(room, token) {
  const t = String(token || '').toLowerCase();
  if (!t) return { role: null, error: 'unauthorized' };

  const master = prop_('MASTER_TOKEN');
  if (master && t === sha256Hex_('tmt-pass:' + room + ':' + master)) return { role: 'admin', master: true };

  const a = loadAuth_(room);
  if (!a) return { role: null, error: 'room_not_found' };

  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + room;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.FAIL_LIMIT) return { role: null, error: 'locked' };

  if (t === String(a.viewerKey).toLowerCase()) return { role: 'viewer' };
  if (/^[a-f0-9]{64}$/.test(t) && sha256Hex_(a.salt + ':' + t) === a.hash) return { role: 'admin' };

  cache.put(failKey, String(fails + 1), CONFIG.LOCK_SEC);
  return { role: null, error: 'unauthorized' };
}

/* ------------------------------------------------------------
 *  タイマー状態（数字のみ）
 *  remaining = running ? (endsAt - now) : remainingSec
 * ---------------------------------------------------------- */

function defaultState_(room) {
  return {
    room: room,
    agenda: [],            // 各議題の持ち時間（分）の配列。議題名は持たない
    index: -1,             // -1 = アジェンダ外のフリータイマー
    status: 'idle',        // idle | running | paused | finished
    durationSec: 600,
    remainingSec: 600,
    endsAt: null,
    thresholds: CONFIG.DEFAULT_THRESHOLDS.slice(),
    fired: [],
    notify: true,
    lastNotice: null,
    ops: [],
    version: 0,
    updatedAt: 0,
  };
}

/** 保存前に、数字と決まった値以外をすべて捨てる */
function sanitizeState_(s) {
  const num = function (v, d) { const n = Number(v); return isFinite(n) ? n : d; };
  const statuses = ['idle', 'running', 'paused', 'finished'];
  const agenda = (Array.isArray(s.agenda) ? s.agenda : []).slice(0, CONFIG.MAX_ITEMS)
    .map(function (m) { return Math.round(Math.min(600, Math.max(0.5, num(m, 0))) * 2) / 2; })
    .filter(function (m) { return m > 0; });
  return {
    room: s.room,
    agenda: agenda,
    index: Math.max(-1, Math.min(agenda.length - 1, Math.round(num(s.index, -1)))),
    status: statuses.indexOf(s.status) >= 0 ? s.status : 'idle',
    durationSec: Math.max(1, num(s.durationSec, 600)),
    remainingSec: num(s.remainingSec, 600),
    endsAt: s.endsAt === null || s.endsAt === undefined ? null : num(s.endsAt, null),
    thresholds: (Array.isArray(s.thresholds) ? s.thresholds : []).map(function (t) { return num(t, -1); })
      .filter(function (t) { return t >= 0 && t <= 3600; }).slice(0, 10),
    fired: (Array.isArray(s.fired) ? s.fired : []).map(function (t) { return num(t, -1); })
      .filter(function (t) { return t >= 0; }).slice(0, 10),
    notify: !!s.notify,
    lastNotice: s.lastNotice ? {
      at: num(s.lastNotice.at, 0),
      threshold: num(s.lastNotice.threshold, 0),
      ok: !!s.lastNotice.ok,
      code: num(s.lastNotice.code, 0),
    } : null,
    ops: (Array.isArray(s.ops) ? s.ops : []).map(function (o) { return String(o).replace(/[^A-Za-z0-9]/g, '').slice(0, 40); }).slice(-20),
    version: num(s.version, 0),
    updatedAt: num(s.updatedAt, 0),
  };
}

function loadState_(room) {
  const raw = props_().getProperty(CONFIG.ROOM_PREFIX + room);
  if (raw) {
    try {
      return sanitizeState_(Object.assign(defaultState_(room), JSON.parse(raw)));
    } catch (e) {
      console.warn('state parse failed');
    }
  }
  return defaultState_(room);
}

function saveState_(s) {
  s.version = (Math.floor(Number(s.version)) || 0) + 1;
  s.updatedAt = Date.now();
  const clean = sanitizeState_(s);
  const json = JSON.stringify(clean);
  if (Utilities.newBlob(json).getBytes().length > CONFIG.MAX_STATE_BYTES) throw new Error('保存データが大きすぎます');
  props_().setProperty(CONFIG.ROOM_PREFIX + s.room, json);

  const rooms = getActiveRooms_();
  const i = rooms.indexOf(s.room);
  if (s.status === 'running' && i < 0) {
    rooms.push(s.room);
    setActiveRooms_(rooms);
  } else if (s.status !== 'running' && i >= 0) {
    rooms.splice(i, 1);
    setActiveRooms_(rooms);
  }
}

function mutate_(room, fn) {
  return withLock_(function () {
    const s = loadState_(room);
    fn(s, Date.now());
    saveState_(s);
    return s;
  });
}

function getActiveRooms_() {
  try {
    return JSON.parse(props_().getProperty(CONFIG.ACTIVE_ROOMS_KEY) || '[]').filter(sanitizeRoom_);
  } catch (e) {
    return [];
  }
}

function setActiveRooms_(rooms) {
  props_().setProperty(CONFIG.ACTIVE_ROOMS_KEY, JSON.stringify(rooms.slice(0, 50)));
}

function remaining_(s, now) {
  return s.status === 'running' ? (s.endsAt - now) / 1000 : Number(s.remainingSec);
}

/* ---------- コマンド ---------- */

function applyCommand_(s, action, p, now) {
  switch (action) {
    case 'toggle':
      if (s.status === 'running') pause_(s, now); else start_(s, now);
      return;
    case 'start':
      start_(s, now);
      return;
    case 'pause':
      pause_(s, now);
      return;
    case 'reset':
      loadItem_(s, s.index);
      return;
    case 'adjust':
      adjust_(s, toNumber_(p.seconds, 'seconds'), now);
      return;
    case 'select':
      loadItem_(s, Math.round(toNumber_(p.index, 'index')));
      if (truthy_(p.autostart)) start_(s, now);
      return;
    case 'next':
      if (s.index < s.agenda.length - 1) {
        loadItem_(s, s.index + 1);
        if (truthy_(p.autostart)) start_(s, now);
      } else {
        pause_(s, now);
        s.status = 'finished';
      }
      return;
    case 'prev':
      loadItem_(s, Math.max(0, s.index - 1));
      return;
    case 'setDuration': {
      const sec = Math.round(Math.min(36000, Math.max(1, toNumber_(p.seconds, 'seconds'))));
      s.index = -1;
      s.durationSec = sec;
      s.remainingSec = sec;
      s.endsAt = null;
      s.status = 'idle';
      s.fired = [];
      return;
    }
    case 'setAgenda': {
      // 受け取るのは「分」の配列だけ
      if (!Array.isArray(p.minutes)) throw new Error('持ち時間の一覧がありません');
      s.agenda = p.minutes.slice(0, CONFIG.MAX_ITEMS).map(function (m) { return toNumber_(m, 'minutes'); })
        .filter(function (m) { return m > 0; });
      loadItem_(s, s.agenda.length ? 0 : -1);
      return;
    }
    case 'setOptions': {
      if (p.notify !== undefined) s.notify = truthy_(p.notify);
      if (Array.isArray(p.thresholds)) {
        const list = p.thresholds.map(function (v) { return Math.round(Number(v)); })
          .filter(function (v) { return isFinite(v) && v >= 0 && v <= 3600; });
        s.thresholds = list.filter(function (v, i) { return list.indexOf(v) === i; })
          .sort(function (a, b) { return b - a; });
        const rem = remaining_(s, now);
        s.fired = s.thresholds.filter(function (t) { return s.status !== 'idle' && rem <= t; });
      }
      return;
    }
  }
}

function start_(s, now) {
  if (s.status === 'running') return;
  s.endsAt = now + Number(s.remainingSec) * 1000;
  s.status = 'running';
}

function pause_(s, now) {
  if (s.status !== 'running') return;
  s.remainingSec = remaining_(s, now);
  s.endsAt = null;
  s.status = 'paused';
}

function adjust_(s, delta, now) {
  const d = Math.max(-3600, Math.min(3600, Math.round(delta)));
  if (s.status === 'running') s.endsAt += d * 1000;
  else s.remainingSec = Number(s.remainingSec) + d;
  s.durationSec = Math.max(1, s.durationSec + d);
  const rem = remaining_(s, now);
  s.fired = s.fired.filter(function (t) { return rem <= t; });
}

function loadItem_(s, idx) {
  if (s.agenda.length) {
    const i = Math.max(0, Math.min(s.agenda.length - 1, idx < 0 ? 0 : idx));
    s.index = i;
    s.durationSec = Math.max(1, Math.round(Number(s.agenda[i]) * 60));
  } else {
    s.index = -1;
  }
  s.remainingSec = s.durationSec;
  s.endsAt = null;
  s.status = 'idle';
  s.fired = [];
}

/* ------------------------------------------------------------
 *  通知判定（クライアントからの check と 1 分トリガーの両方で呼ばれる）
 * ---------------------------------------------------------- */

function collectDueAlert_(s, now) {
  if (s.status !== 'running') return null;
  const rem = remaining_(s, now);
  const due = (s.thresholds || []).filter(function (t) {
    return t < s.durationSec && rem <= t && s.fired.indexOf(t) < 0;
  });
  if (!due.length) return null;
  due.forEach(function (t) { s.fired.push(t); });
  const t = Math.min.apply(null, due);
  return { threshold: t, send: !!s.notify && rem >= t - CONFIG.STALE_SEC, rem: rem };
}

function runAlertCheck_(room) {
  const job = withLock_(function () {
    const s = loadState_(room);
    const due = collectDueAlert_(s, Date.now());
    if (!due) return null;
    saveState_(s);
    return { due: due, state: s };
  });
  if (!job || !job.due.send) return null;

  const res = postTeams_(room, buildAlertCard_(job.state, job.due.threshold, job.due.rem));
  withLock_(function () {
    const s = loadState_(room);
    s.lastNotice = { at: Date.now(), threshold: job.due.threshold, ok: res.ok, code: res.code || 0 };
    saveState_(s);
  });
  if (!res.ok) console.error('Teams post failed: HTTP ' + (res.code || '-'));
  return job.due.threshold;
}

/** 1 分おきのトリガーから実行（ブラウザを閉じていても通知を担保） */
function cronCheckAlerts() {
  getActiveRooms_().forEach(function (room) {
    try {
      runAlertCheck_(room);
    } catch (e) {
      console.error('cron error');
    }
  });
}

/* ------------------------------------------------------------
 *  Teams 通知（議題名・発表者名は入れない）
 * ---------------------------------------------------------- */

function webhookUrl_(room) {
  return prop_('TEAMS_WEBHOOK_URL__' + room) || prop_('TEAMS_WEBHOOK_URL');
}

function postTeams_(room, card) {
  const url = webhookUrl_(room);
  if (!url) return { ok: false, error: 'TEAMS_WEBHOOK_URL が未設定です' };
  const payload = {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
  };
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    return code >= 200 && code < 300 ? { ok: true, code: code } : { ok: false, code: code, error: 'HTTP ' + code };
  } catch (e) {
    return { ok: false, error: '送信できませんでした' };
  }
}

function adaptiveCard_(body) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body: body,
  };
}

function buildAlertCard_(s, t, rem) {
  const hasAgenda = s.index >= 0 && s.agenda.length > 0;
  const nextMin = hasAgenda ? s.agenda[s.index + 1] : undefined;
  let headline;
  let style;
  if (t === 0) {
    headline = '⏰ 持ち時間が終了しました';
    if (rem < -20) headline += '（' + fmtApprox_(-rem) + '超過）';
    style = 'attention';
  } else {
    headline = '⏳ 残り ' + (Math.abs(rem - t) <= 20 ? fmtThreshold_(t) : fmtApprox_(rem));
    style = t <= 60 ? 'warning' : 'accent';
  }
  const facts = [
    { title: '議題', value: hasAgenda ? (s.index + 1) + ' / ' + s.agenda.length : 'アジェンダ外' },
    { title: '持ち時間', value: fmtDuration_(s.durationSec) },
    s.endsAt ? { title: '終了予定', value: fmtClock_(s.endsAt) } : null,
    hasAgenda ? {
      title: '次の議題',
      value: nextMin !== undefined ? (s.index + 2) + ' 番目（' + nextMin + '分）' : 'なし（最終議題）',
    } : null,
  ].filter(Boolean);

  return adaptiveCard_([
    {
      type: 'Container',
      style: style,
      bleed: true,
      items: [{ type: 'TextBlock', text: headline, size: 'ExtraLarge', weight: 'Bolder', wrap: true }],
    },
    { type: 'FactSet', facts: facts },
  ]);
}

function buildTestCard_(s) {
  return adaptiveCard_([
    {
      type: 'Container',
      style: 'good',
      bleed: true,
      items: [
        { type: 'TextBlock', text: '✅ 会議タイマーのテスト通知です', size: 'Large', weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: 'この表示が見えていれば Webhook 設定は完了です。', wrap: true, spacing: 'Small' },
      ],
    },
    {
      type: 'FactSet',
      facts: [
        { title: '通知タイミング', value: (s.thresholds || []).map(fmtThreshold_).join(' / ') || 'なし' },
        { title: '送信時刻', value: fmtClock_(Date.now()) },
      ],
    },
  ]);
}

function fmtThreshold_(t) {
  if (t === 0) return '終了時';
  return t % 60 === 0 ? (t / 60) + '分' : t + '秒';
}

function fmtApprox_(sec) {
  return sec >= 60 ? '約' + Math.round(sec / 60) + '分' : '約' + Math.max(0, Math.round(sec)) + '秒';
}

function fmtDuration_(sec) {
  const m = Math.floor(sec / 60);
  const r = Math.round(sec % 60);
  return r ? m + '分' + r + '秒' : m + '分';
}

function fmtClock_(ms) {
  return Utilities.formatDate(new Date(ms), CONFIG.TZ, 'HH:mm');
}

/* ------------------------------------------------------------
 *  セットアップ・保守（エディタから手動実行）
 * ---------------------------------------------------------- */

/** 初回実行：非常鍵の生成とトリガー登録 */
function setup() {
  const p = props_();
  if (!p.getProperty('MASTER_TOKEN')) p.setProperty('MASTER_TOKEN', randomToken_());
  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', randomToken_());
  const sheet = membersSheet_();   // 会員スプレッドシートを用意（無ければ作成）
  installTrigger();
  console.log('会員シート   : ' + sheet.getParent().getUrl());
  console.log('MASTER_TOKEN : ' + p.getProperty('MASTER_TOKEN') + '（非常用。普段は使わず厳重に保管）');
  console.log('Webhook      : ' + (p.getProperty('TEAMS_WEBHOOK_URL') ? '設定済み' : '未設定'));
}

/**
 * 旧バージョンで保存していた文字情報をすべて削除する（移行時に 1 回実行）。
 * 削除対象：旧形式のルーム（議題名などを含む）、Gemini・Drive 連携の設定値。
 * 会員情報（会員シート）は残す。
 */
function purgeLegacyData() {
  const p = props_();
  // 会員認証の設定（MEMBERS_SHEET_ID・PEPPER など）は削除しない
  const legacyKeys = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'ALLOWED_FOLDER_ID', 'PUBLIC_VIEW_URL',
    'ADMIN_TOKEN', 'VIEWER_TOKEN'];
  let removed = 0;
  Object.keys(p.getProperties()).forEach(function (k) {
    const isRoomKey = k.indexOf(CONFIG.ROOM_PREFIX) === 0 || k.indexOf(CONFIG.AUTH_PREFIX) === 0;
    const legacyRoom = isRoomKey && !/^(room|auth):[a-f0-9]{32}$/.test(k);
    if (legacyRoom || legacyKeys.indexOf(k) >= 0) {
      p.deleteProperty(k);
      removed++;
    }
  });
  p.deleteProperty(CONFIG.ACTIVE_ROOMS_KEY);
  console.log('削除した項目：' + removed + ' 件');
}

/** 非常鍵を作り直す（漏えい時） */
function rotateMasterToken() {
  props_().setProperty('MASTER_TOKEN', randomToken_());
  setup();
}

function randomToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
}

function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('cronCheckAlerts').timeBased().everyMinutes(1).create();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cronCheckAlerts') ScriptApp.deleteTrigger(t);
  });
}

/** Webhook の疎通確認 */
function testWebhook() {
  const res = postTeams_('', buildTestCard_(defaultState_('')));
  console.log(JSON.stringify(res));
}

/** 全ルームを削除。Webhook・非常鍵・会員情報は残す */
function clearAllRooms() {
  const p = props_();
  Object.keys(p.getProperties()).forEach(function (k) {
    if (k.indexOf(CONFIG.ROOM_PREFIX) === 0 || k.indexOf(CONFIG.AUTH_PREFIX) === 0) p.deleteProperty(k);
  });
  p.deleteProperty(CONFIG.ACTIVE_ROOMS_KEY);
}

/* ============================================================
 *  会員認証（進行役）
 *  ※ 会員情報（メールアドレス・ニックネーム）は GAS（Google スプレッドシート）に保存する。
 *    会議の内容（議題名・資料・画像）は従来どおり送らない。
 *
 *  機能
 *   - 新規登録：ニックネーム＋メールアドレス → 仮パスワードをメール送信（24時間有効）
 *   - 初回ログイン（仮パスワード）時はパスワード変更を必須にする
 *   - パスワード忘れ：仮パスワードを再発行してメール送信
 *       ※ 再発行しても元のパスワードは有効なまま（いたずら再発行で締め出されない）
 *   - ログイン 5 回失敗で 15 分ロック
 *   - パスワードは SHA-256（ソルト＋ペッパー）で保存
 *   - セッションは CacheService（最終操作から 6 時間有効）
 *
 *  Script Properties
 *   MEMBERS_SHEET_ID       : 会員スプレッドシート ID（setup() で自動作成）
 *   PEPPER                 : ハッシュ用の秘密値（setup() で自動生成。変更すると全員ログイン不可）
 *   ALLOWED_EMAIL_DOMAINS  : 任意。登録できるメールのドメイン（例 azbil.com）
 *   APP_URL                : 任意。メール本文に載せるタイマー画面の URL
 * ============================================================ */

const AUTH = Object.freeze({
  SHEET_NAME: 'members',
  HEADERS: ['email', 'nickname', 'salt', 'hash', 'tempSalt', 'tempHash', 'tempExpiresAt',
    'status', 'failCount', 'lockedUntil', 'createdAt', 'lastLoginAt'],
  SESSION_TTL_SEC: 21600,
  MAX_FAIL: 5,
  LOCK_MIN: 15,
  TEMP_VALID_HOURS: 24,
  RESET_INTERVAL_SEC: 300,
  PW_MIN: 8,
  PW_MAX: 64,
  NICK_MAX: 20,
  MAIL_NAME: '会議タイマー',
});

const AUTH_ACTIONS = ['register', 'login', 'forgotPassword', 'changePassword', 'logout', 'me'];

const COMMON_PASSWORDS = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin',
  'abc123', '123456', '12345678', '123456789', 'monkey', 'dragon', 'test', 'guest', 'teams', 'meeting',
  'timer', 'kaigi', 'sunshine', 'master'];

function authError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function handleAuthAction_(action, p, method) {
  if (method !== 'POST') return { ok: false, error: 'method_not_allowed' };
  switch (action) {
    case 'register': return registerMember_(p);
    case 'login': return loginMember_(p);
    case 'forgotPassword': return forgotPassword_(p);
    case 'changePassword': return changePassword_(p);
    case 'logout':
      if (p.session) CacheService.getScriptCache().remove('sess:' + String(p.session));
      return { ok: true };
    case 'me': {
      const s = requireSession_(p.session, true);
      return { ok: true, user: publicUser_(s) };
    }
  }
  return { ok: false, error: 'unknown_action' };
}

/* ---------- 会員シート ---------- */

function membersSheet_() {
  const id = prop_('MEMBERS_SHEET_ID');
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('teams-meeting-timer 会員');
    props_().setProperty('MEMBERS_SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName(AUTH.SHEET_NAME);
  if (!sh) {
    sh = ss.getSheets()[0];
    sh.setName(AUTH.SHEET_NAME);
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, AUTH.HEADERS.length).setValues([AUTH.HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rowToMember_(row, values) {
  const m = { row: row };
  AUTH.HEADERS.forEach(function (h, i) { m[h] = values[i]; });
  m.failCount = Number(m.failCount) || 0;
  m.lockedUntil = Number(m.lockedUntil) || 0;
  m.tempExpiresAt = Number(m.tempExpiresAt) || 0;
  return m;
}

function findMember_(email) {
  const sh = membersSheet_();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const values = sh.getRange(2, 1, last - 1, AUTH.HEADERS.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).toLowerCase() === email) return rowToMember_(i + 2, values[i]);
  }
  return null;
}

function saveMember_(m) {
  const sh = membersSheet_();
  const row = AUTH.HEADERS.map(function (h) { return m[h] === undefined || m[h] === null ? '' : m[h]; });
  if (m.row) {
    sh.getRange(m.row, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    m.row = sh.getLastRow();
  }
  return m;
}

/* ---------- 入力チェック・ハッシュ ---------- */

function normalizeEmail_(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) {
    throw authError_('invalid_email', 'メールアドレスの形式が正しくありません');
  }
  const allowed = String(prop_('ALLOWED_EMAIL_DOMAINS', '')).split(',')
    .map(function (d) { return d.trim().toLowerCase(); }).filter(String);
  if (allowed.length) {
    const domain = e.split('@')[1];
    const ok = allowed.some(function (d) { return domain === d || domain.endsWith('.' + d); });
    if (!ok) throw authError_('domain_not_allowed', '社内のメールアドレス（' + allowed.join('、') + '）で登録してください');
  }
  return e;
}

function hashPassword_(salt, pw) {
  const pepper = prop_('PEPPER');
  if (!pepper) throw new Error('PEPPER が未設定です。GAS エディタで setup() を実行してください');
  return sha256Hex_(pepper + ':' + salt + ':' + pw);
}

function generateTempPassword_() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  const chars = [];
  for (let i = 0; i < 10; i++) chars.push(all.charAt((bytes[i] & 0xff) % all.length));
  const li = (bytes[10] & 0xff) % 10;
  let di = (bytes[12] & 0xff) % 10;
  if (di === li) di = (di + 1) % 10;
  chars[li] = letters.charAt((bytes[11] & 0xff) % letters.length);
  chars[di] = digits.charAt((bytes[13] & 0xff) % digits.length);
  return chars.join('');
}

function hasSequence_(s, n) {
  const rows = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  for (let r = 0; r < rows.length; r++) {
    const fw = rows[r];
    const bw = fw.split('').reverse().join('');
    for (let i = 0; i + n <= fw.length; i++) {
      if (s.indexOf(fw.substr(i, n)) >= 0 || s.indexOf(bw.substr(i, n)) >= 0) return true;
    }
  }
  return false;
}

/** 新しいパスワードの検査（画面のパスワード解析と同じ必須条件） */
function validateNewPassword_(pw, m) {
  const p = String(pw || '');
  if (p.length < AUTH.PW_MIN || p.length > AUTH.PW_MAX) {
    throw authError_('weak_password', 'パスワードは ' + AUTH.PW_MIN + '〜' + AUTH.PW_MAX + ' 文字にしてください');
  }
  if (/^\s|\s$/.test(p)) throw authError_('weak_password', 'パスワードの先頭と末尾に空白は使えません');
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) throw authError_('weak_password', 'パスワードには英字と数字の両方を入れてください');
  const lower = p.toLowerCase();
  if (COMMON_PASSWORDS.some(function (w) { return lower.indexOf(w) >= 0; })) {
    throw authError_('weak_password', '推測されやすい単語が含まれています');
  }
  if (/(.)\1{3,}/.test(p) || hasSequence_(lower, 4)) {
    throw authError_('weak_password', '同じ文字や連続した並び（1234、abcd など）が含まれています');
  }
  const local = String(m.email || '').split('@')[0].toLowerCase();
  const nick = String(m.nickname || '').toLowerCase();
  if ((local.length >= 3 && lower.indexOf(local) >= 0) || (nick.length >= 3 && lower.indexOf(nick) >= 0)) {
    throw authError_('weak_password', 'メールアドレスやニックネームを含めないでください');
  }
  return p;
}

/* ---------- セッション ---------- */

function createSession_(m, mustChange) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  CacheService.getScriptCache().put('sess:' + token,
    JSON.stringify({ email: m.email, nickname: m.nickname, mustChange: !!mustChange }), AUTH.SESSION_TTL_SEC);
  return token;
}

function getSession_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess:' + String(token));
  if (!raw) return null;
  cache.put('sess:' + String(token), raw, AUTH.SESSION_TTL_SEC);
  const s = JSON.parse(raw);
  s.token = String(token);
  return s;
}

function updateSession_(token, s) {
  CacheService.getScriptCache().put('sess:' + token,
    JSON.stringify({ email: s.email, nickname: s.nickname, mustChange: !!s.mustChange }), AUTH.SESSION_TTL_SEC);
}

function requireSession_(token, allowMustChange) {
  if (!token) throw authError_('login_required', 'ログインしてください');
  const s = getSession_(token);
  if (!s) throw authError_('session_expired', 'ログインの有効期限が切れました。もう一度ログインしてください');
  if (s.mustChange && !allowMustChange) throw authError_('must_change_password', 'パスワードを変更してから操作してください');
  return s;
}

function publicUser_(s) {
  return { email: s.email, nickname: s.nickname, mustChange: !!s.mustChange };
}

/* ---------- メール ---------- */

function sendAuthMail_(to, subject, lines) {
  const url = prop_('APP_URL');
  const body = lines.concat([
    '',
    url ? '会議タイマー：' + url : '',
    '',
    '※ このメールに心当たりがない場合は破棄してください。',
    '※ このメールは送信専用です。',
  ]).filter(function (l, i, a) { return !(l === '' && a[i - 1] === ''); }).join('\n');
  MailApp.sendEmail({ to: to, subject: '【会議タイマー】' + subject, body: body, name: AUTH.MAIL_NAME });
}

/* ---------- 新規登録 ---------- */

function registerMember_(p) {
  const nickname = String(p.nickname || '').trim();
  if (!nickname || nickname.length > AUTH.NICK_MAX) {
    throw authError_('invalid_nickname', 'ニックネームは 1〜' + AUTH.NICK_MAX + ' 文字で入力してください');
  }
  const email = normalizeEmail_(p.email);
  const temp = generateTempPassword_();

  withLock_(function () {
    if (findMember_(email)) {
      throw authError_('already_registered', 'このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワードを忘れた」から再発行してください');
    }
    const salt = Utilities.getUuid();
    saveMember_({
      email: email, nickname: nickname, salt: '', hash: '',
      tempSalt: salt, tempHash: hashPassword_(salt, temp),
      tempExpiresAt: Date.now() + AUTH.TEMP_VALID_HOURS * 3600 * 1000,
      status: 'active', failCount: 0, lockedUntil: '', createdAt: new Date(), lastLoginAt: '',
    });
  });

  sendAuthMail_(email, '仮パスワードのお知らせ', [
    nickname + ' さん',
    '',
    '会議タイマーへのご登録ありがとうございます。',
    '以下の仮パスワードでログインし、新しいパスワードを設定してください。',
    '',
    '　仮パスワード：' + temp,
    '　有効期限　　：' + AUTH.TEMP_VALID_HOURS + ' 時間',
  ]);
  return { ok: true, message: email + ' に仮パスワードを送りました。メールを確認してログインしてください' };
}

/* ---------- ログイン ---------- */

function loginMember_(p) {
  const email = normalizeEmail_(p.email);
  const pw = String(p.password || '').trim();
  const generic = 'メールアドレスかパスワードが違います';
  if (!pw) throw authError_('bad_credentials', generic);

  return withLock_(function () {
    const m = findMember_(email);
    if (!m) throw authError_('bad_credentials', generic);
    if (m.status === 'suspended') throw authError_('suspended', 'このアカウントは利用停止中です。管理者に連絡してください');

    const now = Date.now();
    if (m.lockedUntil > now) {
      const min = Math.ceil((m.lockedUntil - now) / 60000);
      throw authError_('account_locked', 'ログインに続けて失敗したためロック中です。あと約 ' + min + ' 分お待ちください');
    }

    const mainOk = !!m.hash && hashPassword_(m.salt, pw) === m.hash;
    const tempOk = !mainOk && !!m.tempHash && hashPassword_(m.tempSalt, pw) === m.tempHash;

    if (!mainOk && !tempOk) {
      m.failCount += 1;
      let msg = generic;
      if (m.failCount >= AUTH.MAX_FAIL) {
        m.lockedUntil = now + AUTH.LOCK_MIN * 60000;
        m.failCount = 0;
        msg = 'ログインに ' + AUTH.MAX_FAIL + ' 回失敗したため、' + AUTH.LOCK_MIN + ' 分間ロックしました';
      } else {
        msg += '（あと ' + (AUTH.MAX_FAIL - m.failCount) + ' 回でロックされます）';
      }
      saveMember_(m);
      throw authError_('bad_credentials', msg);
    }
    if (tempOk && m.tempExpiresAt < now) {
      throw authError_('temp_expired', '仮パスワードの有効期限が切れています。「パスワードを忘れた」から再発行してください');
    }

    m.failCount = 0;
    m.lockedUntil = '';
    m.lastLoginAt = new Date();
    saveMember_(m);
    const token = createSession_(m, tempOk);
    return { ok: true, session: token, user: { email: m.email, nickname: m.nickname, mustChange: tempOk } };
  });
}

/* ---------- パスワードを忘れた（登録の有無は返答で区別しない） ---------- */

function forgotPassword_(p) {
  const email = normalizeEmail_(p.email);
  const generic = { ok: true, message: '登録があれば、' + email + ' に仮パスワードを送りました。メールを確認してください' };

  const cache = CacheService.getScriptCache();
  if (cache.get('rst:' + email)) {
    throw authError_('too_many_requests', '再発行は 5 分に 1 回までです。少し待ってからお試しください');
  }
  cache.put('rst:' + email, '1', AUTH.RESET_INTERVAL_SEC);

  const temp = generateTempPassword_();
  const m = withLock_(function () {
    const found = findMember_(email);
    if (!found || found.status === 'suspended') return null;
    found.tempSalt = Utilities.getUuid();
    found.tempHash = hashPassword_(found.tempSalt, temp);
    found.tempExpiresAt = Date.now() + AUTH.TEMP_VALID_HOURS * 3600 * 1000;
    found.failCount = 0;
    found.lockedUntil = '';
    saveMember_(found);
    return found;
  });
  if (!m) return generic;

  sendAuthMail_(email, '仮パスワードの再発行', [
    m.nickname + ' さん',
    '',
    'パスワード再発行の依頼を受け付けました。',
    '以下の仮パスワードでログインし、新しいパスワードを設定してください。',
    '',
    '　仮パスワード：' + temp,
    '　有効期限　　：' + AUTH.TEMP_VALID_HOURS + ' 時間',
    '',
    '依頼に心当たりがない場合は、このメールを無視してください。これまでのパスワードはそのまま使えます。',
  ]);
  return generic;
}

/* ---------- パスワード変更（仮パスワードでログイン中は現在のパスワード不要） ---------- */

function changePassword_(p) {
  const s = requireSession_(p.session, true);
  const result = withLock_(function () {
    const m = findMember_(s.email);
    if (!m) throw authError_('session_expired', 'アカウントが見つかりません。もう一度ログインしてください');
    if (!s.mustChange) {
      const cur = String(p.currentPassword || '');
      if (!m.hash || hashPassword_(m.salt, cur) !== m.hash) {
        throw authError_('bad_current_password', '現在のパスワードが違います');
      }
    }
    const pw = validateNewPassword_(p.newPassword, m);
    if (m.hash && hashPassword_(m.salt, pw) === m.hash) throw authError_('weak_password', '今と同じパスワードは使えません');

    m.salt = Utilities.getUuid();
    m.hash = hashPassword_(m.salt, pw);
    m.tempSalt = '';
    m.tempHash = '';
    m.tempExpiresAt = '';
    m.failCount = 0;
    m.lockedUntil = '';
    saveMember_(m);
    return m;
  });

  s.mustChange = false;
  updateSession_(s.token, s);
  try {
    sendAuthMail_(result.email, 'パスワードを変更しました', [
      result.nickname + ' さん',
      '',
      'パスワードの変更が完了しました（' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM/dd HH:mm') + '）。',
      'ご自身で変更していない場合は、すぐに「パスワードを忘れた」から再発行し、管理者に連絡してください。',
    ]);
  } catch (e) {
    console.warn('通知メール送信失敗');
  }
  return { ok: true, user: publicUser_(s) };
}

/* ---------- 管理用（エディタから実行） ---------- */

/** 会員の利用停止／再開。EMAIL と STATUS を書き換えて実行 */
function setMemberStatus() {
  const EMAIL = 'someone@example.com';
  const STATUS = 'suspended';   // 'suspended' または 'active'
  withLock_(function () {
    const m = findMember_(EMAIL.toLowerCase());
    if (!m) throw new Error('見つかりません: ' + EMAIL);
    m.status = STATUS;
    if (STATUS === 'active') { m.failCount = 0; m.lockedUntil = ''; }
    saveMember_(m);
  });
  console.log(EMAIL + ' を ' + STATUS + ' にしました');
}

/** 会員シートの URL をログに出す */
function showMembersSheetUrl() {
  console.log(membersSheet_().getParent().getUrl());
}
