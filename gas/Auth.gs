/**
 * ============================================================
 *  Teams Meeting Timer — 会員認証 (Auth.gs)
 * ============================================================
 *  対象：進行役（操作画面を使う人）。発表者・参加者・OBS はログイン不要。
 *
 *  機能
 *   - 新規登録：ニックネーム＋メールアドレス → 仮パスワードをメール送信（24時間有効）
 *   - 初回ログイン（仮パスワード）時はパスワード変更を必須にする
 *   - パスワード忘れ：仮パスワードを再発行してメール送信
 *       ※ 再発行しても元のパスワードは有効なまま（第三者のいたずら再発行で締め出されない）
 *   - ログイン 5 回失敗で 15 分ロック
 *   - パスワードは SHA-256（ソルト＋ペッパー）で保存
 *   - セッションは CacheService（最終操作から 6 時間有効）
 *
 *  Script Properties
 *   MEMBERS_SHEET_ID       : 会員スプレッドシート ID（setup() で自動作成）
 *   PEPPER                 : ハッシュ用の秘密値（setup() で自動生成。変更すると全員ログイン不可になる）
 *   ALLOWED_EMAIL_DOMAINS  : 任意。登録できるメールのドメイン（例 example.co.jp,group.example.com）
 *   APP_URL                : 任意。メール本文に載せるタイマー画面の URL
 * ============================================================
 */

const AUTH = Object.freeze({
  SHEET_NAME: 'members',
  HEADERS: ['email', 'nickname', 'salt', 'hash', 'tempSalt', 'tempHash', 'tempExpiresAt',
    'status', 'failCount', 'lockedUntil', 'createdAt', 'lastLoginAt'],
  SESSION_TTL_SEC: 21600,          // CacheService の上限（6時間）。操作のたびに延長
  MAX_FAIL: 5,
  LOCK_MIN: 15,
  TEMP_VALID_HOURS: 24,
  RESET_INTERVAL_SEC: 300,         // 同じメールへの再発行は 5 分に 1 回まで
  PW_MIN: 8,
  PW_MAX: 64,
  NICK_MAX: 20,
  MAIL_NAME: '会議タイマー',
});

const AUTH_ACTIONS = ['register', 'login', 'forgotPassword', 'changePassword', 'logout', 'me'];

const COMMON_PASSWORDS = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin',
  'abc123', '123456', '12345678', '123456789', 'monkey', 'dragon', 'test', 'guest', 'teams', 'meeting',
  'timer', 'kaigi', 'sunshine', 'master'];

/* ------------------------------------------------------------
 *  エラー（コード付き）
 * ---------------------------------------------------------- */

function authError_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------
 *  ルーティング
 * ---------------------------------------------------------- */

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

/* ------------------------------------------------------------
 *  会員シート
 * ---------------------------------------------------------- */

function membersSheet_() {
  let id = prop_('MEMBERS_SHEET_ID');
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

/* ------------------------------------------------------------
 *  入力チェック・ハッシュ
 * ---------------------------------------------------------- */

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
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    pepper + ':' + salt + ':' + pw, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function generateTempPassword_() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  const chars = [];
  for (let i = 0; i < 10; i++) chars.push(all.charAt((bytes[i] & 0xff) % all.length));
  // 英字と数字を必ず 1 文字以上含める（別々の位置に置く）
  const li = (bytes[10] & 0xff) % 10;
  let di = (bytes[12] & 0xff) % 10;
  if (di === li) di = (di + 1) % 10;
  chars[li] = letters.charAt((bytes[11] & 0xff) % letters.length);
  chars[di] = digits.charAt((bytes[13] & 0xff) % digits.length);
  return chars.join('');
}

/** 新しいパスワードの検査（フロントの解析と同じ必須条件） */
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

/* ------------------------------------------------------------
 *  セッション
 * ---------------------------------------------------------- */

function createSession_(m, mustChange) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const s = { email: m.email, nickname: m.nickname, mustChange: !!mustChange };
  CacheService.getScriptCache().put('sess:' + token, JSON.stringify(s), AUTH.SESSION_TTL_SEC);
  return token;
}

function getSession_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess:' + String(token));
  if (!raw) return null;
  cache.put('sess:' + String(token), raw, AUTH.SESSION_TTL_SEC); // 操作のたびに延長
  const s = JSON.parse(raw);
  s.token = String(token);
  return s;
}

function updateSession_(token, s) {
  CacheService.getScriptCache().put('sess:' + token, JSON.stringify({
    email: s.email, nickname: s.nickname, mustChange: !!s.mustChange,
  }), AUTH.SESSION_TTL_SEC);
}

/** ログイン必須の処理で呼ぶ。allowMustChange=false のとき仮パスワードのままの人を止める */
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

/* ------------------------------------------------------------
 *  メール
 * ---------------------------------------------------------- */

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

/* ------------------------------------------------------------
 *  新規登録
 * ---------------------------------------------------------- */

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
      email: email,
      nickname: nickname,
      salt: '',
      hash: '',
      tempSalt: salt,
      tempHash: hashPassword_(salt, temp),
      tempExpiresAt: Date.now() + AUTH.TEMP_VALID_HOURS * 3600 * 1000,
      status: 'active',
      failCount: 0,
      lockedUntil: '',
      createdAt: new Date(),
      lastLoginAt: '',
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

/* ------------------------------------------------------------
 *  ログイン
 * ---------------------------------------------------------- */

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

/* ------------------------------------------------------------
 *  パスワードを忘れた → 仮パスワード再発行
 *  登録の有無は返答で区別しない（メールアドレスの存在確認に使われないように）
 * ---------------------------------------------------------- */

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

/* ------------------------------------------------------------
 *  パスワード変更
 *  仮パスワードでログイン中（mustChange）の場合は現在のパスワード不要
 * ---------------------------------------------------------- */

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
    if (m.hash && hashPassword_(m.salt, pw) === m.hash) {
      throw authError_('weak_password', '今と同じパスワードは使えません');
    }

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
    console.warn('通知メール送信失敗', e);
  }
  return { ok: true, user: publicUser_(s) };
}

/* ------------------------------------------------------------
 *  管理用（エディタから実行）
 * ---------------------------------------------------------- */

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

/** 会員シートを開く URL をログに出す */
function showMembersSheetUrl() {
  console.log(membersSheet_().getParent().getUrl());
}
