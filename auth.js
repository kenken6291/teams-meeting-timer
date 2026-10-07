/* ============================================================
 *  Teams Meeting Timer — auth.js（進行役の会員認証）
 *  - ログイン／新規登録（仮パスワードをメール送信）／パスワード再発行
 *  - 仮パスワードでログインしたらパスワード変更を必須にする
 *  - 新しいパスワードをその場で解析（強さメーター＋条件チェック）
 *  - パスワードの表示・非表示切替
 *  通信は app.js の api() を借りる（TimerAuth.init で受け取る）
 * ============================================================ */
(() => {
  'use strict';

  const LS_KEY = 'teamsTimer.session.v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let apiFn = null;
  let onReady = null;
  let readyCalled = false;
  let sess = loadSession();

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
  }
  function saveSession(s) {
    sess = s;
    try {
      if (s) localStorage.setItem(LS_KEY, JSON.stringify(s)); else localStorage.removeItem(LS_KEY);
    } catch { /* 保存できない環境は無視 */ }
    renderUser();
  }

  /* ============================================================
   *  パスワード解析
   *  必須条件（サーバーと同じ）を満たし、確認欄と一致したときだけ変更ボタンが押せる
   * ============================================================ */
  const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'abc123',
    '123456', '12345678', '123456789', 'monkey', 'dragon', 'test', 'guest', 'teams', 'meeting', 'timer',
    'kaigi', 'sunshine', 'master'];
  const SEQ_ROWS = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

  function hasSequence(s, n) {
    return SEQ_ROWS.some((fw) => {
      const bw = fw.split('').reverse().join('');
      for (let i = 0; i + n <= fw.length; i++) {
        if (s.includes(fw.substr(i, n)) || s.includes(bw.substr(i, n))) return true;
      }
      return false;
    });
  }

  function analyzePassword(pw, ctx = {}) {
    const lower = pw.toLowerCase();
    const local = String(ctx.email || '').split('@')[0].toLowerCase();
    const nick = String(ctx.nickname || '').toLowerCase();
    const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;

    const checks = [
      { key: 'len', label: '8文字以上', ok: pw.length >= 8 && pw.length <= 64, required: true },
      { key: 'mix', label: '英字と数字の両方を含む', ok: /[A-Za-z]/.test(pw) && /[0-9]/.test(pw), required: true },
      { key: 'common', label: '推測されやすい単語を含まない（password、qwerty など）', ok: pw.length > 0 && !COMMON.some((w) => lower.includes(w)), required: true },
      { key: 'seq', label: '同じ文字や連続した並びがない（aaaa、1234、abcd など）', ok: pw.length > 0 && !/(.)\1{3,}/.test(pw) && !hasSequence(lower, 4), required: true },
      { key: 'self', label: 'メールアドレスやニックネームを含まない', ok: pw.length > 0 && !((local.length >= 3 && lower.includes(local)) || (nick.length >= 3 && lower.includes(nick))), required: true },
      { key: 'space', label: '先頭と末尾に空白がない', ok: pw.length > 0 && !/^\s|\s$/.test(pw), required: true },
      { key: 'long', label: '12文字以上（より安全）', ok: pw.length >= 12, required: false },
      { key: 'variety', label: '大文字・小文字・数字・記号のうち3種類以上（より安全）', ok: kinds >= 3, required: false },
    ];

    const valid = checks.filter((c) => c.required).every((c) => c.ok);
    let score = 0;
    if (pw.length) {
      score = valid ? 2 : 1;
      if (valid && checks.find((c) => c.key === 'long').ok) score++;
      if (valid && checks.find((c) => c.key === 'variety').ok) score++;
    }
    const labels = ['', '弱い', '普通', '強い', 'とても強い'];
    const levels = ['none', 'weak', 'fair', 'good', 'strong'];
    return { valid, score, label: labels[score], level: levels[score], checks };
  }

  /* ============================================================
   *  画面
   * ============================================================ */
  function showScreen(tab = 'login', message = '') {
    document.body.classList.add('auth-open');
    $('#authScreen').hidden = false;
    switchTab(tab);
    if (message) setMsg('#authMsg-' + tab, message, 'info');
    setTimeout(() => $(`#authScreen [data-auth-pane="${tab}"] input`)?.focus(), 50);
  }
  function hideScreen() {
    $('#authScreen').hidden = true;
    document.body.classList.remove('auth-open');
  }
  function switchTab(tab) {
    $$('#authScreen [data-auth-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.authTab === tab));
    $$('#authScreen [data-auth-pane]').forEach((p) => p.classList.toggle('is-active', p.dataset.authPane === tab));
  }
  function setMsg(sel, text, kind = 'error') {
    const el = $(sel);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'auth-msg ' + (text ? kind : '');
  }
  function setBusy(form, on) {
    $$('button, input', form).forEach((el) => { el.disabled = on; });
  }

  function renderUser() {
    const logged = !!(sess && sess.token);
    document.body.classList.toggle('is-logged-in', logged);
    const chip = $('#userName');
    if (chip) chip.textContent = logged ? sess.nickname + ' さん' : '';
  }

  /* ---------- パスワード変更ダイアログ ---------- */
  let forcedChange = false;

  function openChange(forced) {
    forcedChange = !!forced;
    const dlg = $('#pwDlg');
    $('#pwCurrentField').hidden = forcedChange;
    $('#pwDlgClose').hidden = forcedChange;
    $('#pwForcedNote').hidden = !forcedChange;
    $('#pwCurrent').value = '';
    $('#pwNew').value = '';
    $('#pwConfirm').value = '';
    setMsg('#pwMsg', '');
    renderAnalysis();
    if (!dlg.open) dlg.showModal();
    setTimeout(() => (forcedChange ? $('#pwNew') : $('#pwCurrent')).focus(), 50);
  }

  function renderAnalysis() {
    const pw = $('#pwNew').value;
    const confirm = $('#pwConfirm').value;
    const a = analyzePassword(pw, sess || {});
    const meter = $('#pwMeter');
    meter.dataset.level = a.level;
    $('#pwMeterLabel').textContent = pw ? `強さ：${a.label}` : '強さ：—';
    $('#pwChecks').innerHTML = a.checks.map((c) =>
      `<li class="${c.ok ? 'ok' : 'ng'} ${c.required ? 'req' : 'opt'}"><span aria-hidden="true">${c.ok ? '✓' : c.required ? '×' : '・'}</span>${c.label}</li>`).join('');
    const match = confirm.length > 0 && pw === confirm;
    const mm = $('#pwMatch');
    mm.textContent = confirm.length === 0 ? '' : match ? '確認用と一致しています' : '確認用と一致しません';
    mm.className = 'pw-match ' + (confirm.length === 0 ? '' : match ? 'ok' : 'ng');
    const needCurrent = !forcedChange && !$('#pwCurrent').value;
    $('#pwSubmit').disabled = !(a.valid && match) || needCurrent;
  }

  /* ============================================================
   *  通信
   * ============================================================ */
  async function call(action, payload) {
    if (!apiFn) throw new Error('初期化されていません');
    return apiFn(action, payload);
  }

  function errText(e) {
    return (e && e.message) || '通信に失敗しました';
  }

  function afterLogin() {
    hideScreen();
    if (sess && sess.mustChange) {
      openChange(true);
      return;
    }
    if (!readyCalled) {
      readyCalled = true;
      if (onReady) onReady();
    }
  }

  /* ============================================================
   *  イベント
   * ============================================================ */
  function bind() {
    $$('#authScreen [data-auth-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.authTab)));
    $$('[data-goto-tab]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); switchTab(a.dataset.gotoTab); }));

    // パスワードの表示・非表示
    $$('[data-auth-reveal]').forEach((b) => {
      b.addEventListener('click', () => {
        const input = $('#' + b.dataset.authReveal);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.textContent = show ? '隠す' : '表示';
        b.setAttribute('aria-pressed', String(show));
        b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
        input.focus();
      });
    });

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const email = $('#loginEmail').value.trim();
      const password = $('#loginPassword').value.trim();
      if (!email || !password) { setMsg('#authMsg-login', 'メールアドレスとパスワードを入力してください'); return; }
      setMsg('#authMsg-login', 'ログインしています…', 'info');
      setBusy(form, true);
      try {
        const r = await call('login', { email, password });
        saveSession({ token: r.session, email: r.user.email, nickname: r.user.nickname, mustChange: r.user.mustChange });
        try { localStorage.setItem('teamsTimer.lastEmail', r.user.email); } catch { /* 無視 */ }
        $('#loginPassword').value = '';
        setMsg('#authMsg-login', '');
        afterLogin();
      } catch (err) {
        setMsg('#authMsg-login', errText(err));
      } finally {
        setBusy(form, false);
      }
    });

    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const nickname = $('#regNickname').value.trim();
      const email = $('#regEmail').value.trim();
      if (!nickname || !email) { setMsg('#authMsg-register', 'ニックネームとメールアドレスを入力してください'); return; }
      setMsg('#authMsg-register', '登録しています…', 'info');
      setBusy(form, true);
      try {
        const r = await call('register', { nickname, email });
        form.reset();
        $('#loginEmail').value = email;
        switchTab('login');
        setMsg('#authMsg-login', r.message + '（仮パスワードの有効期限は24時間）', 'success');
        $('#loginPassword').focus();
      } catch (err) {
        setMsg('#authMsg-register', errText(err));
      } finally {
        setBusy(form, false);
      }
    });

    $('#forgotForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const email = $('#forgotEmail').value.trim();
      if (!email) { setMsg('#authMsg-forgot', 'メールアドレスを入力してください'); return; }
      setMsg('#authMsg-forgot', '送信しています…', 'info');
      setBusy(form, true);
      try {
        const r = await call('forgotPassword', { email });
        $('#loginEmail').value = email;
        switchTab('login');
        setMsg('#authMsg-login', r.message + '。届いた仮パスワードでログインしてください。今までのパスワードもそのまま使えます', 'success');
      } catch (err) {
        setMsg('#authMsg-forgot', errText(err));
      } finally {
        setBusy(form, false);
      }
    });

    // パスワード変更
    ['#pwNew', '#pwConfirm', '#pwCurrent'].forEach((sel) => $(sel).addEventListener('input', renderAnalysis));
    $('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      renderAnalysis();
      if ($('#pwSubmit').disabled) return;
      setMsg('#pwMsg', '変更しています…', 'info');
      $('#pwSubmit').disabled = true;
      try {
        const r = await call('changePassword', {
          currentPassword: $('#pwCurrent').value,
          newPassword: $('#pwNew').value,
        });
        saveSession(Object.assign({}, sess, r.user));
        $('#pwDlg').close();
        flash('パスワードを変更しました');
        afterLogin();
      } catch (err) {
        setMsg('#pwMsg', errText(err));
        renderAnalysis();
      }
    });
    // 仮パスワードのままでは閉じられない
    $('#pwDlg').addEventListener('cancel', (e) => { if (forcedChange) e.preventDefault(); });
    $('#pwDlgClose').addEventListener('click', () => $('#pwDlg').close());

    $('#btnChangePw').addEventListener('click', () => openChange(false));
    $('#btnLogout').addEventListener('click', logout);
    $('#authBtnForcedLogout').addEventListener('click', logout);

    const last = (() => { try { return localStorage.getItem('teamsTimer.lastEmail') || ''; } catch { return ''; } })();
    if (last) $('#loginEmail').value = last;
  }

  function flash(text) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = text;
    t.classList.remove('error');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  async function logout() {
    if (!confirm('ログアウトしますか？')) return;
    try { await call('logout', {}); } catch { /* 期限切れでも続行 */ }
    saveSession(null);
    location.reload();
  }

  /* ============================================================
   *  公開 API（app.js から使う）
   * ============================================================ */
  window.TimerAuth = {
    /** 起動。ログイン済みなら ready をすぐ呼び、未ログインならログイン画面を出す */
    async init(api, ready) {
      apiFn = api;
      onReady = ready;
      bind();
      renderUser();
      if (sess && sess.token) {
        try {
          const r = await call('me', {});
          saveSession(Object.assign({}, sess, r.user));
          afterLogin();
          return;
        } catch (e) {
          if (['session_expired', 'login_required'].includes(e.code)) {
            saveSession(null);
            showScreen('login', 'ログインの有効期限が切れました。もう一度ログインしてください');
            return;
          }
          // 通信エラーのときは手元のセッションで続行（次の通信で再確認される）
          afterLogin();
          return;
        }
      }
      showScreen('login');
    },
    token() { return (sess && sess.token) || ''; },
    user() { return sess; },
    /** サーバーから「ログインが必要」と返ってきたとき */
    requireLogin(message) {
      if (!$('#authScreen').hidden) return;
      saveSession(null);
      showScreen('login', message || 'もう一度ログインしてください');
    },
    /** サーバーから「パスワード変更が必要」と返ってきたとき */
    forceChange() {
      if (sess) saveSession(Object.assign({}, sess, { mustChange: true }));
      if (!$('#pwDlg').open) openChange(true);
    },
    analyzePassword,
  };
})();
