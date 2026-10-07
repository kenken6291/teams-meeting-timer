/* ============================================================
 *  Teams Meeting Timer — config.js
 *  環境ごとの設定はこのファイルだけを書き換えてください。
 *  ※ API キーや Webhook URL などの秘密情報は書かないこと
 *    （それらは GAS のスクリプト プロパティで管理します）
 * ============================================================ */
window.TIMER_CONFIG = {
  /** GAS ウェブアプリの URL（デプロイ時に表示される …/exec） */
  apiUrl: 'https://script.google.com/macros/s/AKfycbwNRRc1Y5NBkOzEUh-63-R_iZ2nuCAh1T7fHp6OZ8MGTSN7UxrqzxHEebVpdl3X34S3sQ/exec',

  /** ルーム名を指定しなかったときの既定値（英数字・- _、40文字まで） */
  defaultRoom: 'default',
};
