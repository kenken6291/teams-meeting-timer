/* ============================================================
 *  Teams Meeting Timer — app.js
 *  モード
 *    ?mode=control  操作画面（既定）。管理者トークンで操作可、閲覧トークンなら表示のみ
 *    ?mode=view     閲覧専用の大きな表示
 *    ?mode=overlay  OBS ブラウザソース用の透過オーバーレイ
 *  主な URL パラメータ
 *    room / token / poll(ms)
 *    api … config.js の apiUrl が未設定のときだけ有効
 *    overlay 用: bg(transparent|green|blue|magenta) pos(br|bl|tr|tl|bc|tc)
 *                size(s|m|l|xl) title(0|1) bar(0|1) hideIdle(0|1)
 *  設計メモ
 *    - カウントダウンはブラウザ側で計算し、サーバーとは数秒おきに状態だけ同期する
 *    - サーバー時刻との差（offset）を補正するので、複数端末の表示がずれない
 *    - 通信が切れても表示は止まらない（最後に受け取った状態で進み続ける）
 * ============================================================ */
(() => {
  'use strict';

  /** 接続先は config.js（window.TIMER_CONFIG）で設定する */
  const APP_CONFIG = window.TIMER_CONFIG || {};
  const PLACEHOLDER_API = /X{6,}/;
  const CONFIG_API_URL = (() => {
    const u = String(APP_CONFIG.apiUrl || '').trim();
    return u && !PLACEHOLDER_API.test(u) ? u : '';
  })();
  const API_FIXED = !!CONFIG_API_URL;
  const LS_KEY = 'teamsTimer.config.v1';

  /* ---------- ユーティリティ ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const setText = (sel, text) => { const el = typeof sel === 'string' ? $(sel) : sel; if (el && el.textContent !== text) el.textContent = text; };

  const qs = new URLSearchParams(location.search);
  const MODE = ['control', 'view', 'overlay'].includes(qs.get('mode')) ? qs.get('mode') : 'control';

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }
  function saveSaved(obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(loadSaved(), obj))); } catch { /* 保存できない環境は無視 */ }
  }
  function sanitizeRoom(r) {
    r = String(r || '').trim();
    return /^[A-Za-z0-9_-]{1,40}$/.test(r) ? r : 'default';
  }

  const saved = loadSaved();
  const cfg = {
    // config.js に URL があればそれを最優先（URL パラメータや保存値では上書きしない）
    api: API_FIXED ? CONFIG_API_URL : String(qs.get('api') || saved.api || '').trim(),
    room: sanitizeRoom(qs.get('room') || saved.room || APP_CONFIG.defaultRoom || 'default'),
    token: String(qs.get('token') || saved.token || '').trim(),
    poll: clamp(Number(qs.get('poll')) || (MODE === 'overlay' ? 3000 : 2500), 1000, 30000),
  };

  // 操作・閲覧画面では URL の値を保存し、トークンをアドレスバーから消す（画面共有での漏えい防止）
  if (MODE !== 'overlay' && (qs.has('token') || qs.has('api') || qs.has('room'))) {
    saveSaved({ api: API_FIXED ? '' : cfg.api, room: cfg.room, token: cfg.token });
    qs.delete('token');
    qs.delete('api');
    const rest = qs.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
  }

  /* ---------- 実行時状態 ---------- */
  const st = {
    state: null,
    role: null,
    info: null,
    offset: 0,          // サーバー時刻 − ローカル時刻（ms）
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
   *  API 通信
   *  POST は text/plain で送る（CORS のプリフライトを避けるため）
   * ============================================================ */
  async function api(action, payload = {}, { method = 'POST' } = {}) {
    if (!cfg.api) throw Object.assign(new Error('API の URL が未設定です。config.js の apiUrl に GAS ウェブアプリの URL を設定してください'), { code: 'no_api' });
    if (!cfg.token) throw Object.assign(new Error('アクセストークンが未設定です'), { code: 'unauthorized' });
    const body = Object.assign({ action, room: cfg.room, token: cfg.token }, payload);
    const t0 = Date.now();
    let res;
    if (method === 'GET') {
      res = await fetch(cfg.api + (cfg.api.includes('?') ? '&' : '?') + new URLSearchParams(body).toString(), { cache: 'no-store' });
    } else {
      res = await fetch(cfg.api, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
      });
    }
    const t1 = Date.now();
    if (!res.ok) throw new Error('通信エラー（HTTP ' + res.status + '）');
    let data;
    try { data = await res.json(); } catch { throw new Error('API の応答を読めません。URL が「/exec」で終わっているか確認してください'); }
    if (data.serverNow) syncClock(data.serverNow, t0, t1);
    if (data.role) st.role = data.role;
    if (!data.ok) throw Object.assign(new Error(errorMessage(data.error)), { code: data.error });
    if (data.state) applyState(data.state);
    return data;
  }

  function errorMessage(code) {
    const map = {
      unauthorized: 'トークンが正しくありません。接続設定を確認してください',
      forbidden: 'この操作には管理者トークンが必要です',
      method_not_allowed: '許可されていない呼び出し方です',
    };
    return map[code] || code || '不明なエラー';
  }

  function syncClock(serverNow, t0, t1) {
    const rtt = t1 - t0;
    const sample = serverNow - (t0 + t1) / 2;
    // 往復時間が短いほど精度が高い。60 秒ごとには必ず更新してドリフトを吸収
    if (rtt <= st.bestRtt * 1.5 || Date.now() - st.offsetAt > 60000) {
      st.offset = sample;
      st.bestRtt = Math.min(st.bestRtt, rtt);
      st.offsetAt = Date.now();
    }
  }

  function applyState(s, force = false) {
    const cur = st.state;
    if (!force && cur && cur.room === s.room && s.version < cur.version) return; // 古い応答は捨てる
    if (cur && cur.index !== s.index) st.lastRem = null;
    st.state = s;
    renderStatic();
    render();
  }

  async function pollLoop() {
    clearTimeout(st.pollTimer);
    if (cfg.api && cfg.token) {
      try {
        await api('state', {}, { method: 'GET' });
        st.failCount = 0;
        setOnline(true);
        if (st.role === 'admin' && MODE === 'control' && !st.info) loadShareInfo();
      } catch (e) {
        st.failCount++;
        setOnline(false, e.message);
        if (e.code === 'unauthorized' && MODE !== 'overlay' && st.failCount === 1) openSettings(e.message);
      }
    } else {
      setOnline(false, '未設定');
    }
    const delay = st.failCount ? Math.min(cfg.poll * 2 ** st.failCount, 20000) : cfg.poll;
    st.pollTimer = setTimeout(pollLoop, delay);
  }

  function setOnline(ok, msg) {
    st.online = ok;
    const el = $('#conn');
    if (el) {
      el.classList.toggle('online', ok);
      el.classList.toggle('offline', !ok);
      setText('#connText', ok ? '同期中' : '未接続' + (msg ? '：' + msg : ''));
    }
    $('#ovDot')?.classList.toggle('offline', !ok);
    setText('#roleLabel', st.role === 'admin' ? '管理者' : st.role === 'viewer' ? '閲覧のみ' : '未接続');
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
    } catch { /* 表示だけなので失敗しても続行 */ }
  }

  /* ============================================================
   *  計算・書式
   * ============================================================ */
  function remaining(s = st.state) {
    if (!s) return 0;
    return s.status === 'running' ? (s.endsAt - now()) / 1000 : Number(s.remainingSec);
  }

  function currentItem(s = st.state) {
    if (s && s.index >= 0 && s.agenda[s.index]) return s.agenda[s.index];
    return { title: (s && (s.freeTitle || s.title)) || 'フリータイマー', minutes: s ? s.durationSec / 60 : 0, presenter: '' };
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
   *  renderStatic: 状態が変わったときだけ
   *  render      : 200ms ごと（時計とゲージ）
   * ============================================================ */
  function renderStatic() {
    const s = st.state;
    if (!s) return;
    const isAdmin = st.role === 'admin' && MODE === 'control';
    document.body.classList.toggle('is-admin', isAdmin);
    document.body.dataset.status = s.status;

    const item = currentItem(s);
    const hasAgenda = s.agenda.length > 0 && s.index >= 0;
    setText('#meetingTitle', s.title || '会議タイマー');
    setText('#roomName', s.room);
    setText('#itemTitle', item.title);
    setText('#itemPresenter', item.presenter ? `発表：${item.presenter}` : '');
    setText('#itemIndex', hasAgenda ? `議題 ${s.index + 1} / ${s.agenda.length}` : 'アジェンダ外');
    setText('#statusLabel', { idle: '待機中', running: '進行中', paused: '一時停止中', finished: '全議題終了' }[s.status] || s.status);
    setText('#allotted', fmtMinutes(s.durationSec / 60));

    const next = s.index >= 0 ? s.agenda[s.index + 1] : s.agenda[0];
    setText('#nextTitle', next ? `${next.title}（${fmtMinutes(next.minutes)}）${next.presenter ? '　' + next.presenter : ''}` : 'なし');

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
        const t = new Date(s.lastNotice.at);
        ln.textContent = s.lastNotice.ok
          ? `最後の Teams 通知：${fmtTime(t.getTime() - st.offset)}（${thresholdLabel(s.lastNotice.threshold)}）`
          : `Teams 通知に失敗しました：${s.lastNotice.error}`;
        ln.classList.toggle('bad', !s.lastNotice.ok);
      } else {
        ln.textContent = '';
      }
    }

    // ゲージの目盛り（残り5分・1分の位置）
    placeMark('#markWarn', 300, s.durationSec);
    placeMark('#markDanger', 60, s.durationSec);

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
        ? '「資料から取り込む」で会議資料からアジェンダを作れます。'
        : 'アジェンダはまだありません。'}</li>`;
      setText('#agendaFoot', '');
      return;
    }
    list.innerHTML = s.agenda.map((it, i) => {
      const cls = i === s.index ? 'current' : (s.index >= 0 && i < s.index) || s.status === 'finished' ? 'done' : '';
      return `<li class="${cls}" data-index="${i}" tabindex="${st.role === 'admin' ? 0 : -1}">
        <span class="num">${i + 1}</span>
        <span class="ttl">${esc(it.title)}${it.presenter ? `<span class="who">${esc(it.presenter)}</span>` : ''}</span>
        <span class="min">${esc(fmtMinutes(it.minutes))}</span>
      </li>`;
    }).join('');
    const total = s.agenda.reduce((a, it) => a + Number(it.minutes), 0);
    setText('#agendaFoot', `合計 ${fmtMinutes(total)}（${s.agenda.length} 議題）`);
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
    if (MODE !== 'overlay') document.title = `${text}｜${currentItem(s).title}`;

    const frac = s.durationSec > 0 ? clamp(rem / s.durationSec, 0, 1) : 0;
    const fill = $('#barFill');
    if (fill) fill.style.transform = `scaleX(${frac})`;
    const ovb = $('#ovBar');
    if (ovb) ovb.style.transform = `scaleX(${frac})`;

    // 終了予定（ローカル時刻で表示）
    const endLocal = s.status === 'running' ? s.endsAt - st.offset : Date.now() + Math.max(0, rem) * 1000;
    setText('#endsAt', s.status === 'finished' ? '—' : fmtTime(endLocal) + (s.status === 'running' ? '' : '（開始した場合）'));
    if (s.agenda.length && s.index >= 0 && s.status !== 'finished') {
      const restMin = s.agenda.slice(s.index + 1).reduce((a, it) => a + Number(it.minutes), 0);
      setText('#meetingEnd', fmtTime(endLocal + restMin * 60000));
    } else {
      setText('#meetingEnd', '—');
    }

    detectCrossing(s, rem);
  }

  /* ---------- しきい値の通過検知 ---------- */
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

    // サーバーに通知判定を依頼（重複はサーバー側で排除される）
    if (s.notify) {
      clearTimeout(st.checkTimer);
      st.checkTimer = setTimeout(async () => {
        try {
          const r = await api('check', {}, { method: 'GET' });
          if (r.notified !== null && r.notified !== undefined && st.role === 'admin' && MODE === 'control') {
            toast(`Teams に「${thresholdLabel(r.notified)}」を通知しました`);
          }
        } catch { /* 1 分トリガーが拾うので無視 */ }
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
    } catch { /* 音が出せない環境は無視 */ }
  }

  function renderSoundButton() {
    setText('#btnSound', st.sound ? '音 オン' : '音 オフ');
  }

  /* ============================================================
   *  操作
   * ============================================================ */
  async function act(action, payload = {}) {
    if (st.busy) return;
    st.busy = true;
    document.body.classList.add('is-busy');
    optimistic(action, payload);
    try {
      await api(action, payload);
    } catch (e) {
      toast(e.message, true);
      try { const r = await api('state', {}, { method: 'GET' }); applyState(r.state, true); } catch { /* 次回ポーリングで回復 */ }
    } finally {
      st.busy = false;
      document.body.classList.remove('is-busy');
    }
  }

  /** 開始・停止・時間調整は通信を待たずに画面へ反映（応答で正式な状態に置き換わる） */
  function optimistic(action, payload) {
    const cur = st.state;
    if (!cur || !['toggle', 'adjust'].includes(action)) return;
    const s = JSON.parse(JSON.stringify(cur));
    const n = now();
    if (action === 'toggle') {
      if (s.status === 'running') {
        s.remainingSec = (s.endsAt - n) / 1000;
        s.endsAt = null;
        s.status = 'paused';
      } else {
        s.endsAt = n + Number(s.remainingSec) * 1000;
        s.status = 'running';
      }
    } else {
      const d = Number(payload.seconds) || 0;
      if (s.status === 'running') s.endsAt += d * 1000; else s.remainingSec = Number(s.remainingSec) + d;
      s.durationSec = Math.max(1, s.durationSec + d);
    }
    s.version = cur.version + 0.5; // 送信前に届いた古いポーリング結果で上書きされないように
    st.state = s;
    renderStatic();
    render();
  }

  function bindControls() {
    $$('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = btn.dataset.act;
        if (a === 'reset' && !confirm('この議題の残り時間を最初に戻します。よろしいですか？')) return;
        const payload = a === 'adjust' ? { seconds: Number(btn.dataset.sec) } : {};
        if (a === 'toggle') requestWakeLock();
        act(a, payload);
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
      act('setDuration', { seconds: Math.round(min * 60), title: $('#quickTitle').value.trim() });
    });

    $('#optNotify').addEventListener('change', (e) => act('setOptions', { notify: e.target.checked }));
    $('#thrChips').addEventListener('change', () => {
      const list = $$('#thrChips input:checked').map((cb) => Number(cb.value));
      act('setOptions', { thresholds: list });
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

    // キーボード操作
    document.addEventListener('keydown', (e) => {
      if (st.role !== 'admin' || MODE !== 'control') return;
      if (document.querySelector('dialog[open]')) return;
      if (e.target.closest('input, textarea, select, button')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map = { ' ': ['toggle'], ArrowRight: ['next'], ArrowLeft: ['prev'], '+': ['adjust', 60], ';': ['adjust', 60], '=': ['adjust', 60], '-': ['adjust', -60] };
      const m = map[e.key];
      if (!m) return;
      e.preventDefault();
      act(m[0], m[0] === 'adjust' ? { seconds: m[1] } : {});
    });
  }

  /* ---------- 画面スリープ防止 ---------- */
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !st.wakeLock) {
        st.wakeLock = await navigator.wakeLock.request('screen');
        st.wakeLock.addEventListener('release', () => { st.wakeLock = null; });
      }
    } catch { /* 未対応ブラウザ */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.state?.status === 'running' && MODE !== 'overlay') requestWakeLock();
  });

  /* ============================================================
   *  接続設定
   * ============================================================ */
  function openSettings(message) {
    const dlg = $('#settingsDlg');
    if (!dlg || dlg.open) return;
    $('#fieldApi').hidden = API_FIXED;
    $('#setApi').value = cfg.api;
    $('#setRoom').value = cfg.room;
    $('#setToken').value = cfg.token;
    setText('#setResult', message || '');
    dlg.showModal();
  }

  function bindSettings() {
    $('#btnSettings').addEventListener('click', () => openSettings());
    $('#btnShowToken').addEventListener('click', (e) => {
      const input = $('#setToken');
      input.type = input.type === 'password' ? 'text' : 'password';
      e.target.textContent = input.type === 'password' ? '表示' : '隠す';
    });
    $('#btnSaveSettings').addEventListener('click', async () => {
      if (!API_FIXED) cfg.api = $('#setApi').value.trim();
      cfg.room = sanitizeRoom($('#setRoom').value);
      cfg.token = $('#setToken').value.trim();
      saveSaved({ api: API_FIXED ? '' : cfg.api, room: cfg.room, token: cfg.token });
      st.state = null;
      st.info = null;
      st.role = null;
      st.failCount = 0;
      setText('#setResult', '接続を確認しています…');
      try {
        const r = await api('state', {}, { method: 'GET' });
        applyState(r.state, true);
        setOnline(true);
        $('#settingsDlg').close();
        toast(st.role === 'admin' ? '管理者として接続しました' : '閲覧のみで接続しました');
        if (st.role === 'admin') loadShareInfo();
        pollLoop();
      } catch (e) {
        setText('#setResult', e.message);
      }
    });
  }

  /* ============================================================
   *  アジェンダの取り込み・編集
   * ============================================================ */
  let draft = { title: '', agenda: [] };
  const MAX_ROWS = 30;

  function openImport(useCurrent) {
    const s = st.state;
    if (useCurrent && s) {
      draft = { title: s.title || '', agenda: s.agenda.map((it) => ({ ...it })) };
    } else if (!draft.agenda.length && s && s.agenda.length) {
      draft = { title: s.title || '', agenda: s.agenda.map((it) => ({ ...it })) };
    }
    $('#parseNotes').hidden = true;
    renderDraft();
    $('#importDlg').showModal();
  }

  function renderDraft() {
    $('#draftTitle').value = draft.title || '';
    const body = $('#draftBody');
    if (!draft.agenda.length) {
      body.innerHTML = '<tr><td colspan="5" class="hint" style="text-align:center;padding:16px">まだ議題がありません。資料を解析するか「行を追加」で入力してください。</td></tr>';
    } else {
      body.innerHTML = draft.agenda.map((it, i) => `
        <tr data-i="${i}" class="${it.estimated ? 'est' : ''}">
          <td>${i + 1}</td>
          <td><input type="text" data-k="title" maxlength="50" value="${esc(it.title)}" aria-label="議題 ${i + 1}"></td>
          <td class="min"><input type="number" data-k="minutes" min="0.5" max="600" step="0.5" value="${esc(it.minutes)}" aria-label="分">${it.estimated ? '<span class="est-tag">推定値</span>' : ''}</td>
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

  function setImportLoading(on) {
    $('#importLoading').hidden = !on;
    $$('#importDlg .btn').forEach((b) => { if (b.value !== 'close') b.disabled = on; });
  }

  async function runParse(action, payload) {
    setImportLoading(true);
    try {
      const r = await api(action, payload);
      if (!r.agenda.length) {
        toast('議題を見つけられませんでした。資料の内容を確認してください', true);
        return;
      }
      draft = { title: r.meetingTitle || (r.source && r.source.name) || draft.title, agenda: r.agenda };
      const notes = [r.notes, r.agenda.some((x) => x.estimated) ? '黄色の枠は Gemini が推定した持ち時間です。確認してください。' : '']
        .filter(Boolean).join(' ');
      $('#parseNotes').hidden = !notes;
      $('#parseNotes').textContent = notes;
      renderDraft();
      toast(`${r.agenda.length} 件の議題を読み取りました`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      setImportLoading(false);
    }
  }

  function bindImport() {
    $('#btnImport').addEventListener('click', () => openImport(false));
    $('#btnEditAgenda').addEventListener('click', () => openImport(true));

    $$('#importDlg .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('#importDlg .tab').forEach((t) => t.classList.toggle('is-active', t === tab));
        $$('#importDlg .tab-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab));
      });
    });

    $('#btnParseDrive').addEventListener('click', () => {
      const ref = $('#driveRef').value.trim();
      if (!ref) { toast('ファイルの URL か ID を入れてください', true); return; }
      runParse('parseFile', { file: ref });
    });

    $('#btnParseText').addEventListener('click', () => {
      const text = $('#pasteText').value.trim();
      if (!text) { toast('解析するテキストを貼り付けてください', true); return; }
      runParse('parseText', { text });
    });

    $('#btnListFiles').addEventListener('click', async () => {
      const ul = $('#fileList');
      ul.innerHTML = '<li class="hint">読み込んでいます…</li>';
      try {
        const r = await api('listFiles');
        ul.innerHTML = r.files.length
          ? r.files.map((f) => `<li><button type="button" data-id="${esc(f.id)}"><span>${esc(f.name)}</span><small>${esc(new Date(f.updated).toLocaleDateString('ja-JP'))}</small></button></li>`).join('')
          : '<li class="hint">対応形式のファイルがありません</li>';
      } catch (e) {
        ul.innerHTML = `<li class="hint">${esc(e.message)}</li>`;
      }
    });
    $('#fileList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      $('#driveRef').value = b.dataset.id;
      runParse('parseFile', { file: b.dataset.id });
    });

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
        .map((it) => ({ title: String(it.title || '').trim(), minutes: Number(it.minutes), presenter: String(it.presenter || '').trim() }))
        .filter((it) => it.title && it.minutes > 0);
      if (!agenda.length) { toast('議題名と 0 より大きい分を入れた行が 1 つ以上必要です', true); return; }
      if (st.state?.status === 'running' && !confirm('進行中のタイマーを止めて、新しいアジェンダの 1 番目から始めます。よろしいですか？')) return;
      try {
        await api('setAgenda', { title: draft.title.trim(), agenda });
        $('#importDlg').close();
        toast('アジェンダを反映しました。「開始」で計測を始めます');
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  /* ============================================================
   *  オーバーレイ・共有 URL
   * ============================================================ */
  function buildUrl(mode, extra = {}) {
    const p = new URLSearchParams({ mode, room: cfg.room });
    // config.js で URL を固定している場合は、共有 URL に api を含めない
    if (!API_FIXED) p.set('api', cfg.api);
    p.set('token', (st.info && st.info.viewerToken) || '');
    Object.entries(extra).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') p.set(k, v); });
    return location.origin + location.pathname + '?' + p.toString();
  }

  function updateShareUrls() {
    const ov = buildUrl('overlay', {
      bg: $('#ovBg').value,
      pos: $('#ovPos').value,
      size: $('#ovSize').value,
      title: $('#ovShowTitle').checked ? '' : '0',
      bar: $('#ovShowBar').checked ? '' : '0',
      hideIdle: $('#ovHideIdle').checked ? '1' : '',
    });
    $('#ovUrl').value = ov;
    $('#viewUrl').value = buildUrl('view');
    const frame = $('#ovPreview');
    if (frame.src !== ov) frame.src = ov;
  }

  function bindShare() {
    $('#btnShare').addEventListener('click', async () => {
      if (!st.info) await loadShareInfo();
      if (!st.info || !st.info.viewerToken) { toast('閲覧用トークンを取得できません。GAS で setup() を実行してください', true); return; }
      updateShareUrls();
      $('#shareDlg').showModal();
    });
    ['#ovBg', '#ovPos', '#ovSize', '#ovShowTitle', '#ovShowBar', '#ovHideIdle'].forEach((sel) => $(sel).addEventListener('change', updateShareUrls));
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
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 6000 : 3000);
  }

  /* ============================================================
   *  起動
   * ============================================================ */
  function init() {
    document.body.classList.add('mode-' + MODE);
    document.documentElement.classList.add('mode-' + MODE);

    if (MODE === 'overlay') {
      const pick = (key, allowed, def) => (allowed.includes(qs.get(key)) ? qs.get(key) : def);
      document.body.classList.add(
        'bg-' + pick('bg', ['transparent', 'green', 'blue', 'magenta'], 'transparent'),
        'pos-' + pick('pos', ['br', 'bl', 'tr', 'tl', 'bc', 'tc'], 'br'),
        'size-' + pick('size', ['s', 'm', 'l', 'xl'], 'm'),
      );
      if (qs.get('title') === '0') document.body.classList.add('no-title');
      if (qs.get('bar') === '0') document.body.classList.add('no-bar');
      if (qs.get('hideIdle') === '1') document.body.classList.add('hide-idle');
      if (!cfg.api || !cfg.token) setText('#ovTitle', cfg.api ? 'URL に token を指定してください' : 'config.js の apiUrl を設定してください');
    } else {
      bindControls();
      bindSettings();
      bindImport();
      bindShare();
      renderSoundButton();
      setText('#roomName', cfg.room);
      if (!cfg.api || !cfg.token) openSettings('最初に接続先を設定してください');
    }

    pollLoop();
    setInterval(render, 200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
