/* ============================================================
 *  Teams Meeting Timer — app.js
 *
 *  【社外に文字情報を出さない設計】
 *   - 議題名・発表者名・会議名は、この PC のブラウザの中（localStorage）だけに置く
 *   - サーバー（Google Apps Script）へ送るのは数字と鍵、そして進行役の会員情報（ログイン用）だけ
 *       持ち時間（分）の並び、議題番号、残り時間の操作、ルーム ID（ルーム名のハッシュ）、
 *       合言葉のハッシュ、閲覧キー
 *   - 画像の文字認識・テキストの読み取りは、すべてこのブラウザの中で行う
 *     （画像も文字も外部へ送信しない。文字認識プログラムのダウンロードのみ発生）
 *   - 共有 URL のルーム ID と閲覧キーは「#」の後ろに置く（# 以降はサーバーへ送られない）
 *
 *  モード
 *    ?mode=control  操作画面（既定）
 *    ?mode=view     閲覧専用の大きな表示
 *    ?mode=overlay  OBS ブラウザソース用の透過オーバーレイ
 * ============================================================ */
(() => {
  'use strict';

  /* ---------- 設定 ---------- */
  const APP_CONFIG = window.TIMER_CONFIG || {};
  const CONFIG_API_URL = (() => {
    const u = String(APP_CONFIG.apiUrl || '').trim();
    return u && !/X{6,}/.test(u) ? u : '';
  })();
  const API_FIXED = !!CONFIG_API_URL;
  const LS_KEY = 'teamsTimer.config.v2';
  const LABEL_PREFIX = 'teamsTimer.labels.';
  const TESSERACT_URL = APP_CONFIG.tesseractUrl || 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  /* ---------- ユーティリティ ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const setText = (sel, text) => { const el = typeof sel === 'string' ? $(sel) : sel; if (el && el.textContent !== text) el.textContent = text; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const qs = new URLSearchParams(location.search);
  const hs = new URLSearchParams(location.hash.replace(/^#/, ''));
  const MODE = ['control', 'view', 'overlay'].includes(qs.get('mode')) ? qs.get('mode') : 'control';

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }
  function saveSaved(obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(loadSaved(), obj))); } catch { /* 無視 */ }
  }

  /* ---------- ハッシュ（ルーム名・合言葉はハッシュにしてから送る） ---------- */
  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const roomIdOf = async (name) => (await sha256Hex('tmt-room:' + name)).slice(0, 32);
  const passTokenOf = (roomId, pass) => sha256Hex('tmt-pass:' + roomId + ':' + pass);
  const ROOM_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const ROOM_ID_RE = /^[a-f0-9]{32}$/;

  function getStoredToken(roomId) {
    return (loadSaved().tokens || {})[roomId] || '';
  }
  function storeToken(roomId, token) {
    const tokens = Object.assign({}, loadSaved().tokens);
    if (token) tokens[roomId] = token; else delete tokens[roomId];
    saveSaved({ tokens });
  }

  /* ---------- 議題名など（この端末だけに保存） ---------- */
  function loadLabels(roomId = cfg.roomId) {
    if (!roomId) return null;
    try { return JSON.parse(localStorage.getItem(LABEL_PREFIX + roomId) || 'null'); } catch { return null; }
  }
  function saveLabels(data, roomId = cfg.roomId) {
    try {
      if (data) localStorage.setItem(LABEL_PREFIX + roomId, JSON.stringify(data));
      else localStorage.removeItem(LABEL_PREFIX + roomId);
    } catch { /* 無視 */ }
  }
  /** サーバーの持ち時間の並びと一致するときだけ議題名を使う（別のアジェンダに付け替わるのを防ぐ） */
  function labelsFor(s) {
    const L = loadLabels();
    if (!L || !s) return { title: '', freeTitle: L ? L.freeTitle || '' : '', items: null };
    const items = Array.isArray(L.items) && L.items.length === s.agenda.length &&
      L.items.every((it, i) => Number(it.minutes) === Number(s.agenda[i])) ? L.items : null;
    return { title: L.title || '', freeTitle: L.freeTitle || '', items };
  }

  /* ---------- 接続先 ---------- */
  const saved = loadSaved();
  const cfg = {
    api: API_FIXED ? CONFIG_API_URL : String(hs.get('api') || qs.get('api') || saved.api || '').trim(),
    roomName: '',
    roomId: '',
    token: '',
    poll: clamp(Number(qs.get('poll')) || (MODE === 'overlay' ? 3000 : 2500), 1000, 30000),
  };

  /* ---------- 実行時状態 ---------- */
  const st = {
    state: null,
    role: null,
    info: null,
    offset: 0,
    bestRtt: Infinity,
    offsetAt: 0,
    online: false,
    failCount: 0,
    lastRem: null,
    lastIndex: null,
    checkTimer: null,
    pollTimer: null,
    busy: false,
    sound: saved.sound !== undefined ? !!saved.sound : MODE === 'control',
    wakeLock: null,
  };
  const now = () => Date.now() + st.offset;

  /* ============================================================
   *  API 通信（数字と鍵だけを送る）
   * ============================================================ */
  const AUTH_ACTIONS = ['register', 'login', 'forgotPassword', 'changePassword', 'logout', 'me'];
  const NO_AUTH_ACTIONS = ['roomInfo', 'createRoom'].concat(AUTH_ACTIONS);
  const LOGIN_ERRORS = ['login_required', 'session_expired'];
  const sessionToken = () => (MODE === 'control' && window.TimerAuth ? window.TimerAuth.token() : '');
  const COMMAND_ACTIONS = ['start', 'pause', 'toggle', 'reset', 'adjust', 'select', 'next', 'prev',
    'setDuration', 'setAgenda', 'setOptions'];
  const RETRY_STATUS = [404, 408, 429, 500, 502, 503, 504];
  const newOpId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  async function api(action, payload = {}) {
    if (!cfg.api) throw Object.assign(new Error('API の URL が未設定です。config.js の apiUrl を設定してください'), { code: 'no_api' });
    if (!cfg.roomId && !AUTH_ACTIONS.includes(action)) throw Object.assign(new Error('ルームが未設定です'), { code: 'unauthorized' });
    if (!cfg.token && !NO_AUTH_ACTIONS.includes(action)) throw Object.assign(new Error('合言葉が未設定です'), { code: 'unauthorized' });
    const body = Object.assign({ action, room: cfg.roomId, token: cfg.token, session: sessionToken() }, payload);
    if (COMMAND_ACTIONS.includes(action) && !body.opId) body.opId = newOpId();

    const MAX_TRY = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      const t0 = Date.now();
      let res;
      try {
        res = await fetch(cfg.api, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body),
          redirect: 'follow',
          cache: 'no-store',
        });
      } catch {
        lastErr = new Error('サーバーに接続できません（ネットワークを確認してください）');
        if (attempt < MAX_TRY) { await sleep(400 * attempt); continue; }
        throw lastErr;
      }
      const t1 = Date.now();
      if (!res.ok) {
        lastErr = new Error('通信エラー（HTTP ' + res.status + '）');
        if (RETRY_STATUS.includes(res.status) && attempt < MAX_TRY) { await sleep(400 * attempt); continue; }
        throw lastErr;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        lastErr = new Error('API の応答を読めません。config.js の URL とデプロイ設定を確認してください');
        if (attempt < MAX_TRY) { await sleep(400 * attempt); continue; }
        throw lastErr;
      }
      if (data.serverNow) syncClock(data.serverNow, t0, t1);
      if (data.role) st.role = data.role;
      if (!data.ok) {
        const err = Object.assign(new Error(errorMessage(data.error, data.message)), { code: data.error });
        // ログイン切れ・仮パスワードのままなら会員認証の画面へ（ログイン操作そのものは除く）
        if (MODE === 'control' && window.TimerAuth && !['login', 'register', 'forgotPassword'].includes(action)) {
          if (LOGIN_ERRORS.includes(data.error)) window.TimerAuth.requireLogin(err.message);
          if (data.error === 'must_change_password') window.TimerAuth.forceChange();
        }
        throw err;
      }
      if (data.state) applyState(data.state);
      if (cfg.token) markSuccess();
      return data;
    }
    throw lastErr || new Error('通信エラー');
  }

  function errorMessage(code, serverMessage) {
    const map = {
      unauthorized: '合言葉（または閲覧キー）が違います',
      room_not_found: 'このルームはまだありません。ルーム名を確認するか、新しく作成してください',
      locked: '合言葉を続けて間違えたため、このルームは 10 分間入れません',
      forbidden: 'この操作には進行役の合言葉が必要です',
      invalid_room: 'ルームの指定が正しくありません',
      method_not_allowed: '許可されていない呼び出し方です',
    };
    return map[code] || serverMessage || code || '不明なエラー';
  }

  function syncClock(serverNow, t0, t1) {
    const rtt = t1 - t0;
    const sample = serverNow - (t0 + t1) / 2;
    if (rtt <= st.bestRtt * 1.5 || Date.now() - st.offsetAt > 60000) {
      st.offset = sample;
      st.bestRtt = Math.min(st.bestRtt, rtt);
      st.offsetAt = Date.now();
    }
  }

  function applyState(s, force = false) {
    const cur = st.state;
    if (!force && cur && cur.room === s.room && s.version < cur.version) return;
    if (cur && cur.index !== s.index) st.lastRem = null;
    st.state = s;
    renderStatic();
    render();
  }

  /* ---------- 定期同期 ---------- */
  let polling = false;
  function schedulePoll(delay) {
    clearTimeout(st.pollTimer);
    st.pollTimer = setTimeout(pollLoop, delay);
  }
  async function pollLoop() {
    clearTimeout(st.pollTimer);
    if (polling) return;
    polling = true;
    try {
      if (cfg.api && cfg.roomId && cfg.token) {
        try {
          await api('state');
          if (st.role === 'admin' && MODE === 'control' && !st.info) loadShareInfo();
        } catch (e) {
          markFailure(e);
        }
      } else {
        setOnline(false, '未設定');
      }
    } finally {
      polling = false;
    }
    schedulePoll(st.failCount ? Math.min(cfg.poll * 2 ** st.failCount, 20000) : cfg.poll);
  }
  function markSuccess() {
    const wasFailing = st.failCount > 0 || !st.online;
    st.failCount = 0;
    setOnline(true);
    if (wasFailing && !polling) schedulePoll(cfg.poll);
  }
  function markFailure(e) {
    st.failCount++;
    if (['unauthorized', 'room_not_found', 'locked'].includes(e.code)) {
      setOnline(false, e.message);
      if (MODE === 'control' && st.failCount === 1) openSettings(e.message);
      return;
    }
    if (st.failCount >= 2) setOnline(false, e.message);
    else setText('#connText', '再接続しています');
  }
  function setOnline(ok, msg) {
    st.online = ok;
    const el = $('#conn');
    if (el) {
      el.classList.toggle('online', ok);
      el.classList.toggle('offline', !ok);
      setText('#connText', ok ? '同期中' : '未接続' + (msg ? '：' + msg : ''));
      el.title = ok ? 'サーバーと同期しています（送っているのは数字だけです）' : (msg || '');
    }
    $('#ovDot')?.classList.toggle('offline', !ok);
    setText('#roleLabel', st.role === 'admin' ? '進行役' : st.role === 'viewer' ? '閲覧のみ' : '未接続');
  }
  async function loadShareInfo() {
    try {
      const r = await api('shareInfo');
      st.info = r.info;
      const b = $('#webhookBadge');
      if (b) {
        b.hidden = false;
        b.textContent = st.info.hasWebhook ? 'Teams 連携済み' : 'Teams 未設定';
        b.className = 'badge admin-only ' + (st.info.hasWebhook ? 'good' : 'bad');
      }
    } catch { /* 表示だけ */ }
  }

  /* ============================================================
   *  計算・書式
   * ============================================================ */
  function remaining(s = st.state) {
    if (!s) return 0;
    return s.status === 'running' ? (s.endsAt - now()) / 1000 : Number(s.remainingSec);
  }

  /** 表示用の議題情報。議題名はこの端末に保存されているときだけ出す */
  function currentItem(s = st.state) {
    if (!s) return { title: '', presenter: '', minutes: 0, short: '' };
    const L = labelsFor(s);
    if (s.index >= 0 && s.agenda[s.index] !== undefined) {
      const label = L.items ? L.items[s.index] : null;
      const short = `議題 ${s.index + 1} / ${s.agenda.length}`;
      return {
        title: (label && label.title) || short,
        presenter: (label && label.presenter) || '',
        minutes: s.agenda[s.index],
        short,
      };
    }
    return { title: L.freeTitle || 'フリータイマー', presenter: '', minutes: s.durationSec / 60, short: 'アジェンダ外' };
  }

  function warnAt(s) { return s.durationSec > 300 ? 300 : s.durationSec * 0.3; }

  function levelOf(s, rem) {
    if (s.status === 'finished') return 'finished';
    if (s.status === 'idle') return 'idle';
    if (rem <= 0) return 'over';
    if (rem <= 60) return 'danger';
    if (rem <= warnAt(s)) return 'warn';
    return 'ok';
  }

  function fmtClock(rem) {
    let sec;
    let sign = '';
    if (rem > 0) {
      sec = Math.ceil(rem - 1e-6);
    } else {
      sec = Math.floor(-rem);
      if (sec > 0) sign = '+';
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const x = sec % 60;
    return sign + (h ? `${h}:${pad2(m)}:${pad2(x)}` : `${pad2(m)}:${pad2(x)}`);
  }

  function fmtMinutes(min) {
    const total = Math.round(Number(min) * 60);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}分${s}秒` : `${m}分`;
  }

  const fmtTime = (ms) => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  const thresholdLabel = (t) => (t === 0 ? '終了時' : t % 60 === 0 ? `残り${t / 60}分` : `残り${t}秒`);

  /* ============================================================
   *  描画
   * ============================================================ */
  function renderStatic() {
    const s = st.state;
    if (!s) return;
    const isAdmin = st.role === 'admin' && MODE === 'control';
    document.body.classList.toggle('is-admin', isAdmin);
    document.body.dataset.status = s.status;

    const L = labelsFor(s);
    const item = currentItem(s);
    const hasAgenda = s.agenda.length > 0 && s.index >= 0;
    setText('#meetingTitle', L.title || '会議タイマー');
    setText('#roomName', cfg.roomName || '（共有表示）');
    setText('#itemTitle', item.title);
    setText('#itemPresenter', item.presenter ? `発表：${item.presenter}` : '');
    setText('#itemIndex', hasAgenda ? item.short : 'アジェンダ外');
    setText('#statusLabel', { idle: '待機中', running: '進行中', paused: '一時停止中', finished: '全議題終了' }[s.status] || s.status);
    setText('#allotted', fmtMinutes(s.durationSec / 60));

    const nextIdx = s.index >= 0 ? s.index + 1 : 0;
    const nextMin = s.agenda[nextIdx];
    const nextLabel = L.items ? L.items[nextIdx] : null;
    setText('#nextTitle', nextMin !== undefined
      ? `${(nextLabel && nextLabel.title) || `議題 ${nextIdx + 1}`}（${fmtMinutes(nextMin)}）${nextLabel && nextLabel.presenter ? '　' + nextLabel.presenter : ''}`
      : 'なし');

    const btn = $('#btnToggle');
    if (btn) {
      btn.textContent = s.status === 'running' ? '一時停止' : s.status === 'paused' ? '再開' : '開始';
      btn.classList.toggle('is-running', s.status === 'running');
    }
    const notify = $('#optNotify');
    if (notify) notify.checked = !!s.notify;
    $$('#thrChips input').forEach((cb) => { cb.checked = s.thresholds.includes(Number(cb.value)); });

    const ln = $('#lastNotice');
    if (ln) {
      if (s.lastNotice) {
        ln.textContent = s.lastNotice.ok
          ? `最後の Teams 通知：${fmtTime(s.lastNotice.at - st.offset)}（${thresholdLabel(s.lastNotice.threshold)}）`
          : `Teams 通知に失敗しました（HTTP ${s.lastNotice.code || '-'}）`;
        ln.classList.toggle('bad', !s.lastNotice.ok);
      } else {
        ln.textContent = '';
      }
    }

    placeMark('#markWarn', 300, s.durationSec);
    placeMark('#markDanger', 60, s.durationSec);

    // オーバーレイ：この端末に議題名があれば名前、なければ「議題 2 / 5」
    setText('#ovTitle', item.title);
    renderAgenda();
  }

  function placeMark(sel, t, duration) {
    const el = $(sel);
    if (!el) return;
    if (t >= duration) { el.hidden = true; return; }
    el.hidden = false;
    el.style.left = `calc(${(t / duration) * 100}% - 1px)`;
  }

  function renderAgenda() {
    const s = st.state;
    const list = $('#agendaList');
    if (!list || !s) return;
    if (!s.agenda.length) {
      list.innerHTML = `<li class="agenda-empty">${st.role === 'admin' && MODE === 'control'
        ? '「アジェンダを取り込む」で、画像や文章から議題を作れます。'
        : 'アジェンダはまだありません。'}</li>`;
      setText('#agendaFoot', '');
      return;
    }
    const L = labelsFor(s);
    list.innerHTML = s.agenda.map((min, i) => {
      const label = L.items ? L.items[i] : null;
      const cls = i === s.index ? 'current' : (s.index >= 0 && i < s.index) || s.status === 'finished' ? 'done' : '';
      return `<li class="${cls}" data-index="${i}" tabindex="${st.role === 'admin' ? 0 : -1}">
        <span class="num">${i + 1}</span>
        <span class="ttl">${esc((label && label.title) || `議題 ${i + 1}`)}${label && label.presenter ? `<span class="who">${esc(label.presenter)}</span>` : ''}</span>
        <span class="min">${esc(fmtMinutes(min))}</span>
      </li>`;
    }).join('');
    const total = s.agenda.reduce((a, m) => a + Number(m), 0);
    setText('#agendaFoot', `合計 ${fmtMinutes(total)}（${s.agenda.length} 議題）` +
      (L.items || MODE !== 'control' ? '' : '　※議題名はこの端末に保存されていません'));
  }

  function render() {
    const s = st.state;
    if (!s) return;
    const rem = remaining(s);
    const lvl = levelOf(s, rem);
    if (document.body.dataset.level !== lvl) document.body.dataset.level = lvl;

    const text = s.status === 'finished' ? '終了' : fmtClock(rem);
    setText('#clock', text);
    setText('#ovTime', text);
    if (MODE !== 'overlay') document.title = `${text}｜会議タイマー`;

    const frac = s.durationSec > 0 ? clamp(rem / s.durationSec, 0, 1) : 0;
    const fill = $('#barFill');
    if (fill) fill.style.transform = `scaleX(${frac})`;
    const ovb = $('#ovBar');
    if (ovb) ovb.style.transform = `scaleX(${frac})`;

    const endLocal = s.status === 'running' ? s.endsAt - st.offset : Date.now() + Math.max(0, rem) * 1000;
    setText('#endsAt', s.status === 'finished' ? '—' : fmtTime(endLocal) + (s.status === 'running' ? '' : '（開始した場合）'));
    if (s.agenda.length && s.index >= 0 && s.status !== 'finished') {
      const restMin = s.agenda.slice(s.index + 1).reduce((a, m) => a + Number(m), 0);
      setText('#meetingEnd', fmtTime(endLocal + restMin * 60000));
    } else {
      setText('#meetingEnd', '—');
    }
    detectCrossing(s, rem);
  }

  function detectCrossing(s, rem) {
    if (s.status !== 'running') { st.lastRem = rem; st.lastIndex = s.index; return; }
    if (st.lastRem !== null && st.lastIndex === s.index) {
      const crossed = s.thresholds.filter((t) => t < s.durationSec && st.lastRem > t && rem <= t);
      if (crossed.length) onCross(Math.min(...crossed), s);
    }
    st.lastRem = rem;
    st.lastIndex = s.index;
  }

  function onCross(t, s) {
    document.body.classList.remove('flash');
    void document.body.offsetWidth;
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), 2000);
    beep(t === 0 ? 'end' : t <= 60 ? 'danger' : 'warn');
    if (s.notify) {
      clearTimeout(st.checkTimer);
      st.checkTimer = setTimeout(async () => {
        try {
          const r = await api('check');
          if (r.notified !== null && r.notified !== undefined && st.role === 'admin' && MODE === 'control') {
            toast(`Teams に「${thresholdLabel(r.notified)}」を通知しました`);
          }
        } catch { /* 1 分トリガーが拾う */ }
      }, 1200 + Math.random() * 800);
    }
  }

  /* ---------- 音 ---------- */
  let audioCtx = null;
  function beep(kind) {
    if (!st.sound || MODE === 'overlay') return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const pattern = kind === 'end' ? [880, 660, 880, 660] : kind === 'danger' ? [880, 880] : [660];
      pattern.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        const t = audioCtx.currentTime + i * 0.3;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
        o.connect(g).connect(audioCtx.destination);
        o.start(t);
        o.stop(t + 0.26);
      });
    } catch { /* 無視 */ }
  }
  function renderSoundButton() { setText('#btnSound', st.sound ? '音 オン' : '音 オフ'); }

  /* ============================================================
   *  操作
   * ============================================================ */
  async function act(action, payload = {}) {
    if (st.busy) return;
    if (action === 'toggle') action = st.state && st.state.status === 'running' ? 'pause' : 'start';
    st.busy = true;
    document.body.classList.add('is-busy');
    optimistic(action, payload);
    try {
      await api(action, payload);
    } catch (e) {
      toast(e.message, true);
      try { const r = await api('state'); applyState(r.state, true); } catch { /* 次回同期で回復 */ }
    } finally {
      st.busy = false;
      document.body.classList.remove('is-busy');
    }
  }

  function optimistic(action, payload) {
    const cur = st.state;
    if (!cur || !['start', 'pause', 'adjust'].includes(action)) return;
    const s = JSON.parse(JSON.stringify(cur));
    const n = now();
    if (action === 'start') {
      if (s.status === 'running') return;
      s.endsAt = n + Number(s.remainingSec) * 1000;
      s.status = 'running';
    } else if (action === 'pause') {
      if (s.status !== 'running') return;
      s.remainingSec = (s.endsAt - n) / 1000;
      s.endsAt = null;
      s.status = 'paused';
    } else {
      const d = Number(payload.seconds) || 0;
      if (s.status === 'running') s.endsAt += d * 1000; else s.remainingSec = Number(s.remainingSec) + d;
      s.durationSec = Math.max(1, s.durationSec + d);
    }
    s.version = cur.version + 0.5;
    st.state = s;
    renderStatic();
    render();
  }

  function bindControls() {
    $$('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = btn.dataset.act;
        if (a === 'reset' && !confirm('この議題の残り時間を最初に戻します。よろしいですか？')) return;
        if (a === 'toggle') requestWakeLock();
        act(a, a === 'adjust' ? { seconds: Number(btn.dataset.sec) } : {});
      });
    });

    $('#agendaList').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-index]');
      if (!li || st.role !== 'admin' || MODE !== 'control') return;
      const idx = Number(li.dataset.index);
      if (idx === st.state.index) return;
      if (st.state.status === 'running' && !confirm('進行中のタイマーを止めて、この議題に切り替えますか？')) return;
      act('select', { index: idx });
    });
    $('#agendaList').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.closest('li[data-index]')?.click();
    });

    $('#btnQuickSet').addEventListener('click', () => {
      const min = Number($('#quickMin').value);
      if (!(min > 0)) { toast('分には 0 より大きい数を入れてください', true); return; }
      // タイトルはこの端末にだけ保存し、サーバーには秒数だけ送る
      const L = loadLabels() || {};
      saveLabels(Object.assign({}, L, { freeTitle: $('#quickTitle').value.trim() }));
      act('setDuration', { seconds: Math.round(min * 60) });
    });

    $('#optNotify').addEventListener('change', (e) => act('setOptions', { notify: e.target.checked }));
    $('#thrChips').addEventListener('change', () => {
      act('setOptions', { thresholds: $$('#thrChips input:checked').map((cb) => Number(cb.value)) });
    });

    $('#btnTestNotify').addEventListener('click', async () => {
      try {
        await api('testNotify');
        toast('テスト通知を送りました。Teams を確認してください');
      } catch (e) {
        toast(e.message, true);
      }
    });

    $('#btnSound').addEventListener('click', () => {
      st.sound = !st.sound;
      saveSaved({ sound: st.sound });
      renderSoundButton();
      if (st.sound) beep('warn');
    });

    $('#btnFullscreen').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    });

    document.addEventListener('keydown', (e) => {
      if (st.role !== 'admin' || MODE !== 'control') return;
      if (document.querySelector('dialog[open]') || document.body.classList.contains('auth-open')) return;
      if (e.target.closest('input, textarea, select, button')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map = { ' ': ['toggle'], ArrowRight: ['next'], ArrowLeft: ['prev'], '+': ['adjust', 60], ';': ['adjust', 60], '=': ['adjust', 60], '-': ['adjust', -60] };
      const m = map[e.key];
      if (!m) return;
      e.preventDefault();
      act(m[0], m[0] === 'adjust' ? { seconds: m[1] } : {});
    });
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !st.wakeLock) {
        st.wakeLock = await navigator.wakeLock.request('screen');
        st.wakeLock.addEventListener('release', () => { st.wakeLock = null; });
      }
    } catch { /* 未対応 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.state?.status === 'running' && MODE !== 'overlay') requestWakeLock();
  });

  /* ============================================================
   *  ルームと合言葉
   *  ルーム名・合言葉はハッシュ化してから送る（名前そのものはサーバーに届かない）
   * ============================================================ */
  function openSettings(message) {
    const dlg = $('#settingsDlg');
    if (!dlg || dlg.open) return;
    $('#fieldApi').hidden = API_FIXED;
    $('#setApi').value = cfg.api;
    $('#setRoom').value = cfg.roomName;
    $('#setToken').value = '';
    $('#setTokenConfirm').value = '';
    $('#fieldConfirm').hidden = true;
    $('#newPass').value = '';
    $('#newPassConfirm').value = '';
    setText('#passResult', '');
    setText('#btnSaveSettings', '入る');
    setText('#setResult', message || (cfg.token ? '合言葉は保存済みです。別のルームに入るときだけ入力してください' : ''));
    dlg.showModal();
  }

  async function enterRoom() {
    if (!API_FIXED) cfg.api = $('#setApi').value.trim();
    const name = $('#setRoom').value.trim();
    const pass = $('#setToken').value;
    if (!ROOM_RE.test(name)) { setText('#setResult', 'ルーム名は半角英数字と - _ の 40 文字以内にしてください'); return; }
    const roomId = await roomIdOf(name);
    let token = pass ? await passTokenOf(roomId, pass) : getStoredToken(roomId);
    if (pass && (pass.length < 4 || pass.length > 64)) { setText('#setResult', '合言葉は 4〜64 文字で入力してください'); return; }
    if (!token) { setText('#setResult', '合言葉を入力してください'); return; }
    if (!API_FIXED) saveSaved({ api: cfg.api });

    const btn = $('#btnSaveSettings');
    btn.disabled = true;
    const prev = { roomName: cfg.roomName, roomId: cfg.roomId, token: cfg.token };
    try {
      cfg.roomName = name;
      cfg.roomId = roomId;
      const creating = !$('#fieldConfirm').hidden;
      if (creating) {
        if ($('#setTokenConfirm').value !== pass) { setText('#setResult', '確認用の合言葉が一致しません'); Object.assign(cfg, prev); return; }
        cfg.token = '';
        await api('createRoom', { passToken: token });
        cfg.token = token;
        toast(`ルーム「${name}」を作りました`);
      } else {
        const info = await api('roomInfo');
        if (!info.exists) {
          if (!pass) { setText('#setResult', 'このルームはまだありません。合言葉を入力してください'); Object.assign(cfg, prev); return; }
          $('#fieldConfirm').hidden = false;
          $('#setTokenConfirm').focus();
          setText('#btnSaveSettings', 'この合言葉でルームを作る');
          setText('#setResult', `「${name}」はまだありません。合言葉をもう一度入力すると作成します`);
          Object.assign(cfg, prev);
          return;
        }
        cfg.token = token;
        await api('state');
      }
      storeToken(roomId, token);
      saveSaved({ room: name });
      st.state = null;
      st.info = null;
      st.failCount = 0;
      const r = await api('state');
      applyState(r.state, true);
      setOnline(true);
      $('#settingsDlg').close();
      if (!creating) toast(st.role === 'admin' ? '進行役として入室しました' : '閲覧のみで入室しました');
      if (st.role === 'admin') loadShareInfo();
      pollLoop();
    } catch (e) {
      Object.assign(cfg, prev);
      setText('#setResult', e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function changePass() {
    const np = $('#newPass').value;
    if (np.length < 4 || np.length > 64) { setText('#passResult', '4〜64 文字で入力してください'); return; }
    if (np !== $('#newPassConfirm').value) { setText('#passResult', '確認用と一致しません'); return; }
    try {
      const newToken = await passTokenOf(cfg.roomId, np);
      await api('changePasscode', { newPassToken: newToken });
      cfg.token = newToken;
      storeToken(cfg.roomId, newToken);
      $('#newPass').value = '';
      $('#newPassConfirm').value = '';
      setText('#passResult', '');
      toast('合言葉を変更しました');
    } catch (e) {
      setText('#passResult', e.message);
    }
  }

  async function deleteRoom() {
    const name = cfg.roomName;
    const typed = prompt(`ルーム「${name}」を削除します。確認のためルーム名を入力してください`);
    if (typed === null) return;
    if (typed.trim() !== name) { toast('ルーム名が一致しないため削除しませんでした', true); return; }
    try {
      await api('deleteRoom');
      storeToken(cfg.roomId, '');
      saveLabels(null);
      cfg.token = '';
      st.state = null;
      st.role = null;
      st.info = null;
      $('#settingsDlg').close();
      toast(`ルーム「${name}」を削除しました`);
      openSettings('別のルームに入るか、新しく作成してください');
    } catch (e) {
      toast(e.message, true);
    }
  }

  function bindSettings() {
    $('#btnSettings').addEventListener('click', () => openSettings());
    $$('[data-reveal]').forEach((b) => {
      b.addEventListener('click', () => {
        const input = $('#' + b.dataset.reveal);
        input.type = input.type === 'password' ? 'text' : 'password';
        b.textContent = input.type === 'password' ? '表示' : '隠す';
      });
    });
    ['#setRoom', '#setToken'].forEach((sel) => $(sel).addEventListener('input', () => {
      if (!$('#fieldConfirm').hidden) {
        $('#fieldConfirm').hidden = true;
        setText('#btnSaveSettings', '入る');
        setText('#setResult', '');
      }
    }));
    ['#setRoom', '#setToken', '#setTokenConfirm'].forEach((sel) => $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); enterRoom(); }
    }));
    $('#btnSaveSettings').addEventListener('click', enterRoom);
    $('#btnChangePass').addEventListener('click', changePass);
    $('#btnDeleteRoom').addEventListener('click', deleteRoom);
    $('#btnClearLabels').addEventListener('click', () => {
      if (!confirm('この端末に保存している議題名・発表者名・会議名を消去します。タイマーと持ち時間はそのまま残ります。よろしいですか？')) return;
      saveLabels(null);
      renderStatic();
      toast('この端末の議題名を消去しました');
    });
  }

  /* ============================================================
   *  アジェンダの読み取り（すべてこのブラウザの中で処理）
   * ============================================================ */

  /**
   * 文章からアジェンダを読み取る（ルールベース）。
   *  - 「10:00-10:15」「10時〜10時15分」→ 差分を分に
   *  - 「15分」「15min」「1時間」「0.5h」→ 分に
   *  - 開始時刻だけの行が並ぶ場合は、次の行の開始時刻との差を分に
   *  - 「（佐藤）」「担当：佐藤」「発表：佐藤」→ 発表者
   *  - 時間の書かれていない番号付きの行 → 5分（推定）として黄色表示
   */
  function parseAgendaText(raw) {
    const text = String(raw || '').normalize('NFKC').replace(/\r/g, '');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const T = '(\\d{1,2})\\s*[:時]\\s*(\\d{1,2})?\\s*分?';
    const rangeRe = new RegExp(T + '\\s*(?:-|~|〜|～|ー|―|−|–|—|から)\\s*' + T);
    const startRe = new RegExp('^(?:\\d+[.)]\\s*)?' + T + '(?=\\s|[^\\d]|$)');
    const durRe = /(\d+(?:\.\d+)?)\s*(時間|h(?:ours?|rs?)?\b|分|min(?:utes?|s)?\b|m\b)/i;
    const bulletRe = /^(?:\d{1,2}\s*[.)、．]|[①-⑳]|[・•●○◆◇■□▶►\-*]|第\s*\d+\s*部?)/;
    const toMin = (h, m) => Number(h) * 60 + Number(m || 0);

    const items = [];
    let meetingTitle = '';
    const notes = [];

    lines.forEach((line) => {
      let rest = line;
      let minutes = null;
      let start = null;
      let estimated = false;

      const r = rest.match(rangeRe);
      if (r) {
        const a = toMin(r[1], r[2]);
        let b = toMin(r[3], r[4]);
        if (b < a) b += 12 * 60;     // 12時間表記のまたぎ（例 11:50-0:10 は稀なので 12h 補正のみ）
        minutes = b - a;
        start = a;
        rest = rest.replace(r[0], ' ');
      } else {
        const sm = rest.match(startRe);
        if (sm) { start = toMin(sm[1], sm[2]); rest = rest.replace(sm[0], ' '); }
        const d = rest.match(durRe);
        if (d) {
          const n = Number(d[1]);
          minutes = /時間|^h/i.test(d[2]) ? n * 60 : n;
          rest = rest.replace(d[0], ' ');
        }
      }

      // 発表者
      let presenter = '';
      const p1 = rest.match(/[（(]\s*([^（）()]{1,20}?)\s*[）)]\s*$/);
      const p2 = rest.match(/(?:担当|発表者?|説明|報告者|司会)\s*[:：]?\s*([^\s、,／/]{1,20})/);
      if (p2) { presenter = p2[1]; rest = rest.replace(p2[0], ' '); } else if (p1) { presenter = p1[1]; rest = rest.replace(p1[0], ' '); }
      presenter = presenter.replace(/(さん|様|氏)$/, '').trim();

      const isBullet = bulletRe.test(line);
      let title = rest.replace(bulletRe, ' ')
        .replace(/[\s　]*[|｜:：\-–—・]+[\s　]*$/, '')
        .replace(/^[\s　|｜:：\-–—・]+/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      if (minutes === null && start === null) {
        if (isBullet && title) {
          items.push({ title, minutes: null, presenter, estimated: true, start: null });
        } else if (!meetingTitle && !items.length && title) {
          meetingTitle = title.slice(0, 60);
        }
        return;
      }
      if (!title) title = `議題 ${items.length + 1}`;
      items.push({ title, minutes, presenter, estimated, start });
    });

    // 最後の「14:30 終了」のような締めの行（開始時刻だけで次が無い）は議題に含めない
    const last = items[items.length - 1];
    if (last && last.minutes === null && last.start !== null && /^(終了|閉会|解散|散会|おわり|end|close)$/i.test(last.title)) items.pop();

    // 開始時刻だけの行：次の行の開始時刻との差
    items.forEach((it, i) => {
      if (it.minutes === null && it.start !== null) {
        const next = items.slice(i + 1).find((x) => x.start !== null);
        if (next) {
          let d = next.start - it.start;
          if (d < 0) d += 12 * 60;
          it.minutes = d;
        } else {
          it.estimated = true;
        }
      }
    });
    let estimatedCount = 0;
    items.forEach((it) => {
      if (it.minutes === null || !(it.minutes > 0)) { it.minutes = 5; it.estimated = true; }
      if (it.estimated) estimatedCount++;
      it.minutes = clamp(Math.round(it.minutes * 2) / 2, 0.5, 600);
      it.title = it.title.slice(0, 50);
      it.presenter = (it.presenter || '').slice(0, 20);
      delete it.start;
    });
    if (estimatedCount) notes.push(`持ち時間が読み取れなかった ${estimatedCount} 件は 5 分にしています（黄色の枠）。`);
    return { meetingTitle, agenda: items.slice(0, 50), notes: notes.join(' ') };
  }

  /* ---------- Copilot などの表を読み取る（ブラウザ内） ---------- */

  /** 社内 Copilot に渡す指示文 */
  const COPILOT_PROMPT = [
    '次の会議資料（貼り付けた文章・画像・ファイル）から、会議のアジェンダを作ってください。',
    '出力は、下の形式の「コードブロック」1つだけにしてください（表や説明文は不要です）。',
    '',
    '```',
    '順|議題|分|発表者',
    '1|開会|5|司会',
    '2|売上報告|20|佐藤',
    '```',
    '',
    'ルール',
    '・1行目は必ず「順|議題|分|発表者」',
    '・「分」は持ち時間を半角数字だけで書く（例：15）',
    '・「10:00-10:15」のような時刻は差を分で計算する。開始時刻だけなら次の議題との差にする',
    '・持ち時間が書かれていない議題は推定し、数字の後ろに「?」を付ける（例：10?）',
    '・発表者が分からなければ「-」と書く',
    '・議題は40文字以内に要約し、「|」は使わない',
    '・休憩・質疑応答も時間があれば1行にする。会議の終了時刻だけの行は入れない',
  ].join('\n');

  /** HTML の表（Copilot・Excel・Word・Teams からコピーしたもの）を行×列の配列に */
  function rowsFromHtml(html) {
    if (!html || !/<table/i.test(html)) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;
    return Array.from(table.querySelectorAll('tr'))
      .map((tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => c.textContent.replace(/\s+/g, ' ').trim()))
      .filter((r) => r.some(Boolean));
  }

  /** 文字の表（Markdown の | 区切り・タブ区切り・カンマ区切り）を行×列の配列に */
  function rowsFromText(text) {
    const lines = String(text || '').normalize('NFKC').replace(/\r/g, '').replace(/\u00a0/g, ' ')
      .split('\n').map((l) => l.trim())
      .filter((l) => l && !/^```/.test(l));                    // コードブロックの ``` 行は無視
    if (!lines.length) return null;

    // 1) | 区切り（Markdown の表・Copilot のコードブロック）
    const pipeLines = lines.filter((l) => l.includes('|'));
    if (pipeLines.length >= 2) {
      const rows = pipeLines
        .filter((l) => !/^\|?\s*:?-{2,}/.test(l))             // 区切り行 |---|---|
        .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
      if (rows.length >= 1 && rows.some((r) => r.length >= 2)) return rows;
    }
    // 2) タブ区切り（Excel・Teams・ブラウザの表をコピーしたとき）
    const tabLines = lines.filter((l) => l.includes('\t'));
    if (tabLines.length >= 2) return tabLines.map((l) => l.split('\t').map((c) => c.trim()));
    // 3) 1 マス 1 行（ブラウザによっては表がこの形でコピーされる）
    const HEAD = /^(順|no\.?|#|番号|議題|項目|内容|タイトル|テーマ|分|時間|所要時間|持ち時間|発表者|担当|担当者|報告者)$/i;
    let k = 0;
    while (k < lines.length && HEAD.test(lines[k])) k++;
    if (k >= 2 && (lines.length - k) % k === 0 && lines.length > k) {
      const rows = [];
      for (let i = 0; i < lines.length; i += k) rows.push(lines.slice(i, i + k));
      return rows;
    }
    // 4) 空白 2 つ以上・全角空白区切り
    const spaceRows = lines.map((l) => l.split(/\s{2,}|　+/).map((c) => c.trim()).filter(Boolean)).filter((r) => r.length >= 2);
    if (spaceRows.length >= 2) return spaceRows;
    // 5) カンマ区切り
    const commaLines = lines.filter((l) => l.includes(','));
    if (commaLines.length >= 2) return commaLines.map((l) => l.split(',').map((c) => c.trim()));
    return null;
  }

  /** 「15」「15分」「約15分」「15?」「0:15」「10:00-10:15」「1時間」などを分に */
  function minutesFromCell(cell) {
    const c = String(cell || '').normalize('NFKC').trim();
    if (!c) return { minutes: null, estimated: false };
    const estimated = /[?？]|約|推定|目安|程度|くらい/.test(c);
    const range = c.match(/(\d{1,2})\s*[:時]\s*(\d{1,2})?\s*分?\s*(?:-|~|〜|～|ー|―|−|–|—|から)\s*(\d{1,2})\s*[:時]\s*(\d{1,2})?/);
    if (range) {
      let d = (Number(range[3]) * 60 + Number(range[4] || 0)) - (Number(range[1]) * 60 + Number(range[2] || 0));
      if (d < 0) d += 12 * 60;
      return { minutes: d, estimated };
    }
    const hm = c.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) return { minutes: Number(hm[1]) * 60 + Number(hm[2]), estimated };
    const h = c.match(/(\d+(?:\.\d+)?)\s*(?:時間|h(?:ours?|rs?)?\b)/i);
    const m = c.match(/(\d+(?:\.\d+)?)\s*(?:分|min(?:utes?|s)?\b)/i);
    let total = 0;
    if (h || m) {
      total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
    } else {
      const n = c.match(/(\d+(?:\.\d+)?)/);   // 「15」「15?」など数字だけ
      total = n ? Number(n[1]) : 0;
    }
    return { minutes: total > 0 ? total : null, estimated };
  }

  /** 行×列の配列からアジェンダを作る。見出しの言葉で列を判定し、無ければ中身から推測する */
  function agendaFromRows(rows) {
    if (!rows || !rows.length) return null;
    const KEYS = {
      title: /議題|項目|内容|タイトル|テーマ|件名|アジェンダ|agenda|title|topic|item/i,
      minutes: /^分$|分数|時間|所要|持ち時間|予定時間|min|duration|time/i,
      presenter: /発表|担当|報告者|説明者|presenter|owner|speaker|講師|司会/i,
      no: /^(順|no\.?|#|番号|項番)$/i,
    };
    const head = rows[0].map((c) => String(c || '').normalize('NFKC').trim());
    const col = { title: -1, minutes: -1, presenter: -1 };
    head.forEach((h, i) => {
      if (KEYS.no.test(h)) return;
      if (col.presenter < 0 && KEYS.presenter.test(h)) col.presenter = i;
      else if (col.title < 0 && KEYS.title.test(h)) col.title = i;
      else if (col.minutes < 0 && KEYS.minutes.test(h)) col.minutes = i;
    });
    const hasHeader = col.title >= 0 || col.minutes >= 0;
    const body = hasHeader ? rows.slice(1) : rows;

    if (!hasHeader || col.title < 0 || col.minutes < 0) {
      // 見出しが無い・足りない場合：数字が多い列＝分、文字が長い列＝議題、残りの短い列＝発表者
      const width = Math.max(...body.map((r) => r.length));
      const stats = Array.from({ length: width }, (_, i) => {
        const cells = body.map((r) => String(r[i] || '').trim());
        const filled = cells.filter(Boolean);
        return {
          i,
          numeric: filled.filter((c) => minutesFromCell(c).minutes !== null && c.replace(/[\d\s:時間分min?？約〜~\-.]/gi, '').length === 0).length / Math.max(1, filled.length),
          seqNo: filled.every((c, k) => Number(c.replace(/[.)、．]/g, '')) === k + 1),
          len: filled.reduce((a, c) => a + c.length, 0) / Math.max(1, filled.length),
        };
      });
      const cand = stats.filter((x) => !x.seqNo);
      if (col.minutes < 0) col.minutes = (cand.filter((x) => x.numeric >= 0.6).sort((a, b) => b.numeric - a.numeric)[0] || {}).i ?? -1;
      if (col.title < 0) col.title = (cand.filter((x) => x.i !== col.minutes).sort((a, b) => b.len - a.len)[0] || {}).i ?? -1;
      if (col.presenter < 0) col.presenter = (cand.filter((x) => x.i !== col.minutes && x.i !== col.title)[0] || {}).i ?? -1;
    }
    if (col.title < 0) return null;

    const items = [];
    let estimatedCount = 0;
    body.forEach((r) => {
      const title = String(r[col.title] || '').replace(/^\d{1,2}\s*[.)、．]\s*/, '').trim();
      if (!title || /^(合計|計|小計|total)$/i.test(title)) return;
      const mm = col.minutes >= 0 ? minutesFromCell(r[col.minutes]) : { minutes: null, estimated: false };
      let minutes = mm.minutes;
      let estimated = mm.estimated;
      if (!(minutes > 0)) { minutes = 5; estimated = true; }
      if (estimated) estimatedCount++;
      items.push({
        title: title.slice(0, 50),
        minutes: clamp(Math.round(minutes * 2) / 2, 0.5, 600),
        presenter: col.presenter >= 0 ? String(r[col.presenter] || '').replace(/(さん|様|氏)$/, '').replace(/^(-|－|ー|—|―|なし|未定|不明|n\/a)$/i, '').trim().slice(0, 20) : '',
        estimated,
      });
    });
    if (!items.length) return null;
    return {
      meetingTitle: '',
      agenda: items.slice(0, 50),
      notes: estimatedCount ? `推定の持ち時間（「?」付き、または空欄）が ${estimatedCount} 件あります（黄色の枠）。確認してください。` : '',
    };
  }

  function parseAgendaTable(text, html) {
    return agendaFromRows(rowsFromHtml(html)) || agendaFromRows(rowsFromText(text)) || null;
  }

  /* ---------- 画像の文字認識（ブラウザ内で実行） ---------- */
  let tesseractLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractLoading) return tesseractLoading;
    tesseractLoading = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = TESSERACT_URL;
      sc.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('文字認識の準備に失敗しました')));
      sc.onerror = () => { tesseractLoading = null; reject(new Error('文字認識プログラムを読み込めません（社内ネットワークで制限されている可能性があります）')); };
      document.head.appendChild(sc);
    });
    return tesseractLoading;
  }

  async function ocrImages(list, onProgress) {
    const T = await loadTesseract();
    const worker = await T.createWorker(['jpn', 'eng'], 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress(`文字を読み取っています ${Math.round((m.progress || 0) * 100)}%`);
        else if (/load|initializ/i.test(m.status)) onProgress('文字認識の準備をしています（初回は 1 分ほどかかります）');
      },
    });
    try {
      const texts = [];
      for (let i = 0; i < list.length; i++) {
        onProgress(`${i + 1} / ${list.length} 枚目を読み取っています`);
        const { data } = await worker.recognize(list[i].dataUrl);
        texts.push(data.text || '');
      }
      // 日本語の文字の間に入りがちな空白を詰める
      return texts.join('\n')
        .replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, '$1')
        .replace(/[ \t]+\n/g, '\n');
    } finally {
      await worker.terminate();
    }
  }

  /* ============================================================
   *  アジェンダの取り込み・編集
   * ============================================================ */
  let draft = { title: '', agenda: [] };
  const MAX_ROWS = 50;
  const MAX_IMAGES = 3;
  const IMG_LONG_SIDE = 2400;
  let images = [];

  function switchImportTab(name) {
    $$('#importDlg .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
    $$('#importDlg .tab-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === name));
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('この画像は読み込めません（JPEG か PNG で保存し直してください）')); };
      img.src = url;
    });
  }

  async function prepareImage(file) {
    const img = await loadImage(file);
    const scale = Math.min(1, IMG_LONG_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL('image/png'), w, h };
  }

  async function addImageFiles(files) {
    const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type));
    if (!list.length) { toast('画像ファイルが見つかりませんでした', true); return; }
    for (const f of list) {
      if (images.length >= MAX_IMAGES) { toast(`画像は ${MAX_IMAGES} 枚までです`, true); break; }
      try { images.push(await prepareImage(f)); } catch (e) { toast(e.message, true); }
    }
    renderThumbs();
  }

  function renderThumbs() {
    $('#imgThumbs').innerHTML = images.map((im, i) => `
      <li>
        <img src="${im.dataUrl}" alt="アジェンダ画像 ${i + 1}">
        <button type="button" class="thumb-del" data-del="${i}" aria-label="画像 ${i + 1} を外す">外す</button>
        <small>${i + 1}枚目　${im.w}×${im.h}</small>
      </li>`).join('');
    setText('#imgInfo', images.length ? `${images.length} 枚` : '');
    $('#btnParseImage').disabled = images.length === 0;
  }

  /** 画像を完全に破棄する（どこにも保存しない） */
  function clearImages() {
    images.forEach((im) => { im.dataUrl = ''; });
    images = [];
    $$('#imgThumbs img').forEach((img) => img.removeAttribute('src'));
    const input = $('#imgFile');
    if (input) input.value = '';
    renderThumbs();
  }

  function clipboardImages(e) {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    return items.filter((it) => it.kind === 'file' && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
  }

  function openImport(useCurrent) {
    const s = st.state;
    if (s && (useCurrent || !draft.agenda.length)) {
      const L = labelsFor(s);
      draft = {
        title: L.title || '',
        agenda: s.agenda.map((m, i) => ({
          title: (L.items && L.items[i] && L.items[i].title) || '',
          minutes: m,
          presenter: (L.items && L.items[i] && L.items[i].presenter) || '',
        })),
      };
    }
    $('#parseNotes').hidden = true;
    renderDraft();
    $('#importDlg').showModal();
  }

  function renderDraft() {
    $('#draftTitle').value = draft.title || '';
    const body = $('#draftBody');
    if (!draft.agenda.length) {
      body.innerHTML = '<tr><td colspan="5" class="hint" style="text-align:center;padding:16px">まだ議題がありません。画像や文章を読み取るか「行を追加」で入力してください。</td></tr>';
    } else {
      body.innerHTML = draft.agenda.map((it, i) => `
        <tr data-i="${i}" class="${it.estimated ? 'est' : ''}">
          <td>${i + 1}</td>
          <td><input type="text" data-k="title" maxlength="50" value="${esc(it.title)}" aria-label="議題 ${i + 1}"></td>
          <td class="min"><input type="number" data-k="minutes" min="0.5" max="600" step="0.5" value="${esc(it.minutes)}" aria-label="分">${it.estimated ? '<span class="est-tag">要確認</span>' : ''}</td>
          <td class="who"><input type="text" data-k="presenter" maxlength="20" value="${esc(it.presenter || '')}" aria-label="発表者"></td>
          <td class="ops">
            <button type="button" class="icon-btn" data-op="up" aria-label="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-op="down" aria-label="下へ" ${i === draft.agenda.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-op="del" aria-label="削除">✕</button>
          </td>
        </tr>`).join('');
    }
    updateDraftTotal();
  }

  function updateDraftTotal() {
    const total = draft.agenda.reduce((a, it) => a + (Number(it.minutes) || 0), 0);
    setText('#draftTotal', draft.agenda.length ? `合計 ${fmtMinutes(total)}（${draft.agenda.length} 議題）` : '');
  }

  function setImportBusy(on, message = '') {
    $('#importLoading').hidden = !on;
    setText('#importLoadingText', message);
    $$('#importDlg .btn').forEach((b) => { if (b.value !== 'close') b.disabled = on; });
    if (!on) renderThumbs();
  }

  function applyParsed(r) {
    if (!r.agenda.length) {
      toast('議題を読み取れませんでした。文章を直すか、手で入力してください', true);
      return false;
    }
    draft = { title: r.meetingTitle || draft.title, agenda: r.agenda };
    $('#parseNotes').hidden = !r.notes;
    $('#parseNotes').textContent = r.notes;
    renderDraft();
    toast(`${r.agenda.length} 件の議題を読み取りました。内容を確認してください`);
    return true;
  }

  function bindImport() {
    $('#btnImport').addEventListener('click', () => openImport(false));
    $('#btnEditAgenda').addEventListener('click', () => openImport(true));
    $$('#importDlg .tab').forEach((tab) => tab.addEventListener('click', () => switchImportTab(tab.dataset.tab)));

    // 画像
    const drop = $('#imgDrop');
    $('#btnPickImage').addEventListener('click', (e) => { e.stopPropagation(); $('#imgFile').click(); });
    drop.addEventListener('click', () => $('#imgFile').click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#imgFile').click(); } });
    $('#imgFile').addEventListener('change', (e) => { addImageFiles(e.target.files); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
    drop.addEventListener('drop', (e) => addImageFiles(e.dataTransfer && e.dataTransfer.files));
    $('#imgThumbs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]');
      if (!b) return;
      images.splice(Number(b.dataset.del), 1);
      renderThumbs();
    });
    $('#importDlg').addEventListener('close', clearImages);

    $('#btnParseImage').addEventListener('click', async () => {
      if (!images.length) return;
      setImportBusy(true, '文字認識の準備をしています');
      try {
        const text = await ocrImages(images, (msg) => setText('#importLoadingText', msg));
        $('#pasteText').value = text.trim();
        const ok = applyParsed(parseAgendaText(text));
        if (!ok) switchImportTab('text');
      } catch (e) {
        toast(e.message, true);
      } finally {
        clearImages();            // 成否にかかわらず画像は消去
        setImportBusy(false);
      }
    });

    // Copilot の表
    setText('#copilotPrompt', COPILOT_PROMPT);
    $('#btnCopyPrompt').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(COPILOT_PROMPT);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = COPILOT_PROMPT;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('指示文をコピーしました。Copilot に貼り付けて、会議資料と一緒に送ってください');
    });
    /** 何を受け取ったかを表示（読み取れなかったときの手がかり） */
    const describe = (text, html) => {
      const parts = [];
      parts.push(html && /<table/i.test(html) ? 'HTML の表：あり' : 'HTML の表：なし');
      const t = String(text || '');
      const lines = t.split('\n').filter((l) => l.trim()).length;
      parts.push(`文字：${t.length} 文字・${lines} 行`);
      parts.push(t.includes('|') ? '区切り：|' : t.includes('\t') ? '区切り：タブ' : '区切り：見つからない');
      return parts.join(' ／ ');
    };
    const showDiag = (msg) => {
      const el = $('#tableDiag');
      el.hidden = !msg;
      el.textContent = msg || '';
    };
    const tryTable = (text, html) => {
      const r = parseAgendaTable(text, html);
      if (!r) return false;
      showDiag('');
      applyParsed(r);
      $('#tablePaste').value = '';
      return true;
    };

    $('#tablePaste').addEventListener('paste', (e) => {
      const html = (e.clipboardData && e.clipboardData.getData('text/html')) || '';
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (!html && !text) {
        // 会社のポリシー等で貼り付けの中身が渡されない場合
        setTimeout(() => {
          if (!$('#tablePaste').value) showDiag('貼り付けた内容を受け取れませんでした。社内の設定でこのサイトへの貼り付けが制限されている可能性があります。下の「手で入力」をお使いください。');
        }, 50);
        return;
      }
      if (tryTable(text, html)) { e.preventDefault(); return; }
      // 読み取れなかったときは、そのまま欄に入れて中身を確認できるようにする
      setTimeout(() => {
        showDiag('表として読み取れませんでした（' + describe(text, html) + '）。Copilot の回答のコードブロック右上の「コピー」ボタンでコピーし直してください。');
      }, 0);
    });

    $('#btnParseTable').addEventListener('click', () => {
      const v = $('#tablePaste').value.trim();
      if (!v) { toast('Copilot の回答を貼り付けてください', true); return; }
      if (!tryTable(v, '')) showDiag('表として読み取れませんでした（' + describe(v, '') + '）。1 行目が「順|議題|分|発表者」になっているか確認してください。');
    });

    // クリップボードから直接読み込む（貼り付け操作がうまくいかない場合）
    $('#btnReadClipboard').addEventListener('click', async () => {
      let html = '';
      let text = '';
      try {
        if (navigator.clipboard && navigator.clipboard.read) {
          const items = await navigator.clipboard.read();
          for (const it of items) {
            if (!html && it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
            if (!text && it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
          }
        } else if (navigator.clipboard && navigator.clipboard.readText) {
          text = await navigator.clipboard.readText();
        }
      } catch {
        showDiag('クリップボードを読めませんでした。ブラウザの「クリップボードへのアクセス」を許可するか、欄に Ctrl+V で貼り付けてください。');
        return;
      }
      if (!html && !text) { showDiag('クリップボードが空か、内容を受け取れませんでした。'); return; }
      if (!tryTable(text, html)) {
        $('#tablePaste').value = text;
        showDiag('表として読み取れませんでした（' + describe(text, html) + '）。');
      }
    });

    // テキスト
    $('#btnParseText').addEventListener('click', () => {
      const text = $('#pasteText').value.trim();
      if (!text) { toast('読み取る文章を貼り付けてください', true); return; }
      applyParsed(parseAgendaText(text));
    });
    $('#btnClearText').addEventListener('click', () => { $('#pasteText').value = ''; });

    // どこで Ctrl+V しても画像なら取り込む
    document.addEventListener('paste', (e) => {
      if (st.role !== 'admin' || MODE !== 'control' || document.body.classList.contains('auth-open')) return;
      if (e.target.closest && e.target.closest('input, textarea')) return;   // 入力欄への貼り付けはそのまま
      const dlg = $('#importDlg');
      if (Array.from(document.querySelectorAll('dialog[open]')).some((d) => d !== dlg)) return;

      // 表（Copilot・Excel など）を貼り付けた場合は、そのまま読み取る
      const html = e.clipboardData && e.clipboardData.getData('text/html');
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if ((html && /<table/i.test(html)) || (text && rowsFromText(text))) {
        const r = parseAgendaTable(text, html);
        if (r) {
          e.preventDefault();
          if (!dlg.open) openImport(false);
          switchImportTab('copilot');
          applyParsed(r);
          return;
        }
      }

      const files = clipboardImages(e);
      if (!files.length) return;
      e.preventDefault();
      if (!dlg.open) openImport(false);
      switchImportTab('image');
      addImageFiles(files);
    });

    // 下書きの編集
    $('#draftTitle').addEventListener('input', (e) => { draft.title = e.target.value; });
    $('#draftBody').addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const it = draft.agenda[Number(tr.dataset.i)];
      const k = e.target.dataset.k;
      it[k] = k === 'minutes' ? Number(e.target.value) : e.target.value;
      if (k === 'minutes') { it.estimated = false; tr.classList.remove('est'); }
      updateDraftTotal();
    });
    $('#draftBody').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-op]');
      if (!b) return;
      const i = Number(b.closest('tr').dataset.i);
      const a = draft.agenda;
      if (b.dataset.op === 'del') a.splice(i, 1);
      if (b.dataset.op === 'up' && i > 0) [a[i - 1], a[i]] = [a[i], a[i - 1]];
      if (b.dataset.op === 'down' && i < a.length - 1) [a[i + 1], a[i]] = [a[i], a[i + 1]];
      renderDraft();
    });
    $('#btnAddRow').addEventListener('click', () => {
      if (draft.agenda.length >= MAX_ROWS) { toast(`議題は ${MAX_ROWS} 件までです`, true); return; }
      draft.agenda.push({ title: '', minutes: 10, presenter: '' });
      renderDraft();
      $$('#draftBody input[data-k="title"]').pop()?.focus();
    });

    $('#btnApplyAgenda').addEventListener('click', async () => {
      const agenda = draft.agenda
        .map((it) => ({ title: String(it.title || '').trim(), minutes: Math.round(Number(it.minutes) * 2) / 2, presenter: String(it.presenter || '').trim() }))
        .filter((it) => it.minutes > 0);
      if (!agenda.length) { toast('0 より大きい分を入れた行が 1 つ以上必要です', true); return; }
      if (st.state?.status === 'running' && !confirm('進行中のタイマーを止めて、新しいアジェンダの 1 番目から始めます。よろしいですか？')) return;
      // 議題名はこの端末へ、持ち時間（数字）だけをサーバーへ
      const L = loadLabels() || {};
      saveLabels({ title: draft.title.trim(), freeTitle: L.freeTitle || '', items: agenda });
      try {
        await api('setAgenda', { minutes: agenda.map((it) => it.minutes) });
        $('#importDlg').close();
        $('#pasteText').value = '';
        toast('アジェンダを反映しました。「開始」で計測を始めます');
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  /* ============================================================
   *  オーバーレイ・共有 URL
   *  ルーム ID と閲覧キーは「#」の後ろへ（# 以降はどのサーバーにも送られない）
   * ============================================================ */
  function buildUrl(mode, extra = {}) {
    const q = new URLSearchParams({ mode });
    Object.entries(extra).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') q.set(k, v); });
    const h = new URLSearchParams({ r: cfg.roomId, k: (st.info && st.info.viewerToken) || '' });
    if (!API_FIXED) h.set('api', cfg.api);
    return location.origin + location.pathname + '?' + q.toString() + '#' + h.toString();
  }

  function updateShareUrls() {
    const ov = buildUrl('overlay', {
      bg: $('#ovBg').value,
      pos: $('#ovPos').value,
      size: $('#ovSize').value,
      bar: $('#ovShowBar').checked ? '' : '0',
      hideIdle: $('#ovHideIdle').checked ? '1' : '',
    });
    $('#ovUrl').value = ov;
    $('#viewUrl').value = buildUrl('view');
    setText('#roomIdText', cfg.roomId);
    const frame = $('#ovPreview');
    if (frame.src !== ov) frame.src = ov;
  }

  function bindShare() {
    $('#btnShare').addEventListener('click', async () => {
      if (!st.info) await loadShareInfo();
      if (!st.info || !st.info.viewerToken) { toast('閲覧キーを取得できません。入り直してから再度お試しください', true); return; }
      updateShareUrls();
      $('#shareDlg').showModal();
    });
    ['#ovBg', '#ovPos', '#ovSize', '#ovShowBar', '#ovHideIdle'].forEach((sel) => $(sel).addEventListener('change', updateShareUrls));
    $('#btnRotateViewer').addEventListener('click', async () => {
      if (!confirm('閲覧キーを作り直すと、配布済みのオーバーレイ URL と閲覧用 URL は使えなくなります。続けますか？')) return;
      try {
        const r = await api('rotateViewerKey');
        st.info = Object.assign({}, st.info, { viewerToken: r.viewerKey });
        updateShareUrls();
        toast('閲覧キーを作り直しました。新しい URL を配布してください');
      } catch (e) {
        toast(e.message, true);
      }
    });
    $$('[data-copy]').forEach((b) => {
      b.addEventListener('click', async () => {
        const input = $('#' + b.dataset.copy);
        try {
          await navigator.clipboard.writeText(input.value);
        } catch {
          input.select();
          document.execCommand('copy');
        }
        toast('コピーしました');
      });
    });
  }

  /* ---------- トースト ---------- */
  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 6000 : 3500);
  }

  /* ============================================================
   *  起動
   * ============================================================ */
  async function init() {
    document.body.classList.add('mode-' + MODE);
    document.documentElement.classList.add('mode-' + MODE);

    if (MODE === 'overlay') {
      const pick = (key, allowed, def) => (allowed.includes(qs.get(key)) ? qs.get(key) : def);
      document.body.classList.add(
        'bg-' + pick('bg', ['transparent', 'green', 'blue', 'magenta'], 'transparent'),
        'pos-' + pick('pos', ['br', 'bl', 'tr', 'tl', 'bc', 'tc'], 'br'),
        'size-' + pick('size', ['s', 'm', 'l', 'xl'], 'm'),
      );
      if (qs.get('bar') === '0') document.body.classList.add('no-bar');
      if (qs.get('hideIdle') === '1') document.body.classList.add('hide-idle');
    }

    if (MODE === 'control') {
      bindControls();
      bindSettings();
      bindImport();
      bindShare();
      renderSoundButton();
      const name = loadSaved().room || APP_CONFIG.defaultRoom || '';
      if (name && ROOM_RE.test(name)) {
        cfg.roomName = name;
        cfg.roomId = await roomIdOf(name);
        cfg.token = getStoredToken(cfg.roomId);
      }
      setText('#roomName', cfg.roomName || '未設定');
      setInterval(render, 200);
      if (!cfg.api) { openSettings('config.js の apiUrl を設定してください'); return; }
      // 操作画面は進行役のログインが必要。ログイン後に同期を始める
      window.TimerAuth.init(api, () => {
        if (!cfg.token) openSettings('ルーム名と合言葉を入力してください');
        pollLoop();
      });
      return;
    } else {
      // 閲覧・オーバーレイ：URL の # の後ろからルーム ID と閲覧キーを読む
      const r = String(hs.get('r') || '').toLowerCase();
      if (ROOM_ID_RE.test(r)) {
        cfg.roomId = r;
        cfg.token = String(hs.get('k') || '');
      } else if (MODE === 'view') {
        const name = loadSaved().room || '';
        if (ROOM_RE.test(name)) {
          cfg.roomName = name;
          cfg.roomId = await roomIdOf(name);
          cfg.token = getStoredToken(cfg.roomId);
        }
      }
      if (MODE === 'view') bindControls();
      if (!cfg.roomId || !cfg.token) {
        setText('#ovTitle', '共有ダイアログの URL を使ってください');
        setText('#itemTitle', '共有ダイアログの閲覧用 URL を使ってください');
      }
    }

    pollLoop();
    setInterval(render, 200);
  }

  // 動作確認用（ブラウザ内の読み取り関数）
  window.TimerParse = { parseAgendaText, parseAgendaTable };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
