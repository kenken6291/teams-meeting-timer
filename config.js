/* ============================================================
 *  Teams Meeting Timer — config.js
 *  環境ごとの設定はこのファイルだけを書き換えてください。
 *  ※ API キーや Webhook URL などの秘密情報は書かないこと
 *    （それらは GAS のスクリプト プロパティで管理します）
 * ============================================================ */
window.TIMER_CONFIG = {
  /** GAS ウェブアプリの URL（デプロイ時に表示される …/exec） */
  apiUrl: 'https://script.google.com/macros/s/AKfycbwNRRc1Y5NBkOzEUh-63-R_iZ2nuCAh1T7fHp6OZ8MGTSN7UxrqzxHEebVpdl3X34S3sQ/exec',

  /** ルーム名を指定しなかったときの既定値（英数字・- _、40文字まで）。空なら毎回入力 */
  defaultRoom: '',

  /**
   * 画像の文字認識プログラム（Tesseract.js）の読み込み先。
   * 画像そのものは送信されず、プログラムをダウンロードするだけです。
   * 社内ネットワークで CDN が使えない場合は、ファイルを社内サーバーに置いてその URL を指定してください。
   */
  tesseractUrl: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
};
