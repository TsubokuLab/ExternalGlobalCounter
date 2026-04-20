// ============================================================
// 🌐 External Global Counter
// ============================================================
// 
// Google Apps Script と GitHub Gist を活用した、それなりのアクセス数に耐えうる多用途カウンターシステムです
// キー名をURLに付けてアクセスするだけでカウントできるので、GitHub PagesやVRChatなど幅広い環境で利用可能です。
// 
// 【はじめてのセットアップ手順】
//
// ① GoogleドライブにGoogle Apps Scriptを新規作成し、このコード全文をコピペする
//
// ② GitHubでPersonal Access Tokenを作成する
//      GitHub → Settings（右上アイコン）
//      → Developer settings（左メニュー最下部）
//      → Personal access tokens → Fine-grained tokens
//      → 「Generate new token」ボタン
//      → Token nameは何でもOK（例: gas-to-gist）
//      → Permissions → Gists → 「Read and write」を選択
//      → 「Generate token」→ 表示されたトークンをコピー
//         ⚠️ この画面を閉じると二度と表示されません！
//
// ③ GASエディタ右上「デプロイ」→「新しいデプロイ」
//      種類: ウェブアプリ
//      次のユーザーとして実行: 自分
//      アクセスできるユーザー: 全員
//      → 「デプロイ」→ 表示されたウェブアプリのURLをクリックして開く
//
// ④ セットアップ画面で初期設定
//      → デプロイURLを開くとセットアップ画面が開くので
//        「GitHub Token」と「プロジェクト名」を入力して送信
//
// ⑤ 完了！同じURLがカウンターAPIとして使えます
//      GET https://.../exec?keys=stage1_play
//      GET https://.../exec?keys=stage1_play,stage1_clear
//
// 【集計の確認方法】
//      セットアップ完了画面に表示されるGist URLをブラウザで開く
//      Raw URLは、直接JSONファイルにアクセスしたい場合にご使用下さい
//      ※Gistは5分毎に自動更新されます（GASの実行時間制限を回避する為）
//
// ============================================================

const CACHE_PREFIX   = 'gc_';
const CACHE_KEYS_KEY = 'gc_active_keys';
const CACHE_TTL      = 3600; // 60分

// -------------------------------------------
// GETリクエストの振り分け
// セットアップ済み → カウントAPI
// 未セットアップ  → セットアップ画面
// -------------------------------------------
function doGet(e) {
  const props = PropertiesService.getScriptProperties();
  const isSetup = props.getProperty('GIST_ID');

  // keysパラメータがあればカウントAPIとして動作
  if (isSetup && e.parameter.keys) {
    return handleCount(e);
  }

  // keysパラメータなし → セットアップ画面 or 完了画面
  if (!isSetup) {
    return HtmlService.createHtmlOutput(getSetupHtml())
      .setTitle('🌐 External Global Counter — セットアップ');
  }

  // セットアップ済みでkeysなし → ステータス画面
  return HtmlService.createHtmlOutput(getStatusHtml(props))
    .setTitle('🌐 External Global Counter — ステータス');
}

// -------------------------------------------
// カウントアップ処理
// -------------------------------------------
function handleCount(e) {
  const raw  = (e.parameter.keys || '').toString();
  const keys = raw
    .split(',')
    .map(k => k.trim())
    .filter(k => /^[a-zA-Z0-9_]{1,100}$/.test(k));

  if (keys.length === 0) {
    return jsonResponse({ status: 'error', message: 'No valid keys' });
  }

  const cache = CacheService.getScriptCache();
  const lock  = LockService.getScriptLock();

  try {
    lock.waitLock(5000);
    for (const key of keys) {
      const cacheKey = CACHE_PREFIX + key;
      const current  = parseInt(cache.get(cacheKey) || '0', 10);
      cache.put(cacheKey, (current + 1).toString(), CACHE_TTL);
    }
    addActiveKeys(cache, keys);
    lock.releaseLock();
  } catch (_) {
    return jsonResponse({ status: 'error', message: 'Server busy' });
  }

  return jsonResponse({ status: 'ok', keys: keys });
}

// -------------------------------------------
// セットアップ実行
// HTMLフォームから google.script.run で呼ばれる
// -------------------------------------------
function runSetup(token, projectName) {
  if (!token || token.trim() === '') {
    throw new Error('GitHub Tokenが入力されていません');
  }
  if (!projectName || projectName.trim() === '') {
    throw new Error('プロジェクト名が入力されていません');
  }

  const cleanToken   = token.trim();
  const cleanProject = projectName.trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_');
  const fileName     = cleanProject + '.json';

  // 1. デプロイURL取得（Gist descriptionに含める）
  const scriptUrl = ScriptApp.getService().getUrl();

  // 2. Tokenの有効性チェック
  const authCheck = UrlFetchApp.fetch('https://api.github.com/user', {
    headers: {
      'Authorization': 'token ' + cleanToken,
      'Accept': 'application/vnd.github.v3+json'
    },
    muteHttpExceptions: true
  });

  if (authCheck.getResponseCode() !== 200) {
    throw new Error('GitHub Tokenが無効です。Gistsの Read and write 権限があるか確認してください。');
  }

  const githubUser = JSON.parse(authCheck.getContentText()).login;

  // 3. Gist新規作成
  const gistPayload = {
    description: 'External Global Counter — ' + cleanProject + ' | ' + scriptUrl,
    public: false,
    files: {}
  };
  gistPayload.files[fileName] = {
    content: JSON.stringify({ last_updated: new Date().toISOString() }, null, 2)
  };

  const gistRes = UrlFetchApp.fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': 'token ' + cleanToken,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(gistPayload),
    muteHttpExceptions: true
  });

  if (gistRes.getResponseCode() !== 201) {
    throw new Error('Gistの作成に失敗しました: ' + gistRes.getContentText());
  }

  const gist    = JSON.parse(gistRes.getContentText());
  const gistId  = gist.id;
  const gistUrl = gist.html_url;
  const rawUrl  = 'https://gist.githubusercontent.com/'
    + githubUser + '/' + gistId + '/raw/' + fileName;

  // 4. PropertiesServiceに保存
  PropertiesService.getScriptProperties().setProperties({
    'GITHUB_TOKEN':  cleanToken,
    'GIST_ID':       gistId,
    'GIST_FILENAME': fileName,
    'PROJECT_NAME':  cleanProject,
    'GITHUB_USER':   githubUser,
    'GIST_URL':      gistUrl,
    'RAW_URL':       rawUrl
  });

  // 5. 5分トリガー登録
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'flushToGist') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('flushToGist').timeBased().everyMinutes(5).create();

  return {
    projectName: cleanProject,
    fileName:    fileName,
    gistId:      gistId,
    gistUrl:     gistUrl,
    rawUrl:      rawUrl,
    apiUrl:      scriptUrl
  };
}

// -------------------------------------------
// バッチ書き込み: CacheService → GitHub Gist
// 5分毎のトリガーから呼ばれる
// -------------------------------------------
function flushToGist() {
  const cache = CacheService.getScriptCache();
  const lock  = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
  } catch (_) {
    return;
  }

  try {
    const raw  = cache.get(CACHE_KEYS_KEY) || '[]';
    const keys = JSON.parse(raw);
    if (keys.length === 0) return;

    const increments = {};
    for (const key of keys) {
      const val = parseInt(cache.get(CACHE_PREFIX + key) || '0', 10);
      if (val > 0) {
        increments[key] = val;
        cache.remove(CACHE_PREFIX + key);
      }
    }
    cache.remove(CACHE_KEYS_KEY);

    if (Object.keys(increments).length === 0) return;

    const gistData = getGistData();
    for (const [key, inc] of Object.entries(increments)) {
      gistData[key] = (gistData[key] || 0) + inc;
    }
    gistData.last_updated = new Date().toISOString();

    updateGist(gistData);

  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------
// アクティブキー管理
// -------------------------------------------
function addActiveKeys(cache, newKeys) {
  const raw      = cache.get(CACHE_KEYS_KEY) || '[]';
  const existing = JSON.parse(raw);
  const merged   = [...new Set([...existing, ...newKeys])];
  cache.put(CACHE_KEYS_KEY, JSON.stringify(merged), CACHE_TTL);
}

// -------------------------------------------
// GitHub Gist 操作
// -------------------------------------------
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    token:    props.getProperty('GITHUB_TOKEN'),
    gistId:   props.getProperty('GIST_ID'),
    fileName: props.getProperty('GIST_FILENAME') || 'counter.json'
  };
}

function getGistData() {
  const cfg = getConfig();
  const res = UrlFetchApp.fetch(
    'https://api.github.com/gists/' + cfg.gistId,
    {
      headers: {
        'Authorization': 'token ' + cfg.token,
        'Accept': 'application/vnd.github.v3+json'
      },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() !== 200) {
    Logger.log('Gist GET failed: ' + res.getContentText());
    return {};
  }

  try {
    const gist    = JSON.parse(res.getContentText());
    const content = gist.files[cfg.fileName]?.content || '{}';
    const parsed  = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (err) {
    Logger.log('Gist parse failed: ' + err.message);
    return {};
  }
}

function updateGist(data) {
  const cfg     = getConfig();
  const payload = { files: {} };
  payload.files[cfg.fileName] = {
    content: JSON.stringify(data, null, 2)
  };

  const res = UrlFetchApp.fetch(
    'https://api.github.com/gists/' + cfg.gistId,
    {
      method: 'PATCH',
      headers: {
        'Authorization': 'token ' + cfg.token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() !== 200) {
    Logger.log('Gist PATCH failed: ' + res.getContentText());
  }
}

// -------------------------------------------
// ヘルパー: JSONレスポンス
// -------------------------------------------
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// -------------------------------------------
// セットアップ画面HTML
// -------------------------------------------
function getSetupHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🌐 External Global Counter セットアップ</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Arial, 'Hiragino Sans', sans-serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    color: #fff;
  }
  .container {
    width: 100%;
    max-width: 480px;
  }
  .header {
    text-align: center;
    margin-bottom: 24px;
  }
  .header .icon { font-size: 48px; margin-bottom: 8px; }
  .header h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .header p { color: #94a3b8; font-size: 14px; }

  .card {
    background: rgba(255,255,255,0.07);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    padding: 28px;
    margin-bottom: 16px;
  }

  .steps {
    margin-bottom: 24px;
  }
  .steps-title {
    font-size: 12px;
    font-weight: 700;
    color: #94a3b8;
    letter-spacing: 1px;
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  .step {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
    align-items: flex-start;
  }
  .step:last-child { margin-bottom: 0; }
  .step-num {
    width: 26px; height: 26px;
    background: linear-gradient(135deg, #6c63ff, #48c6ef);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700;
    flex-shrink: 0;
  }
  .step-text { font-size: 13px; color: #cbd5e1; line-height: 1.6; padding-top: 2px; }
  .step-text strong { color: #fff; }
  .step-text .sub {
    display: block; font-size: 11px; color: #64748b; margin-top: 2px;
  }

  .divider {
    border: none; border-top: 1px solid rgba(255,255,255,0.08);
    margin: 20px 0;
  }

  .field { margin-bottom: 16px; }
  .label {
    display: block; font-size: 13px; font-weight: 600;
    color: #e2e8f0; margin-bottom: 8px;
  }
  .label .emoji { margin-right: 6px; }

  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 12px 16px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 12px;
    font-size: 14px;
    color: #fff;
    outline: none;
    transition: border-color 0.2s, background 0.2s;
    font-family: monospace;
  }
  input::placeholder { color: #475569; }
  input:focus {
    border-color: #6c63ff;
    background: rgba(108,99,255,0.1);
  }

  .hint {
    font-size: 11px; color: #64748b; margin-top: 6px;
    display: flex; align-items: center; gap: 4px;
  }

  .btn {
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, #6c63ff, #48c6ef);
    color: white;
    border: none;
    border-radius: 14px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.2s, transform 0.1s;
    margin-top: 4px;
  }
  .btn:hover { opacity: 0.9; }
  .btn:active { transform: scale(0.98); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ローディング */
  .status { display: none; margin-top: 16px; border-radius: 14px; padding: 16px; }

  .loading-box {
    background: rgba(56,189,248,0.1);
    border: 1px solid rgba(56,189,248,0.2);
    align-items: center; gap: 12px;
    font-size: 14px; color: #7dd3fc;
  }
  .spinner {
    width: 20px; height: 20px;
    border: 2px solid rgba(56,189,248,0.3);
    border-top-color: #38bdf8;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-box {
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.25);
    color: #fca5a5;
    font-size: 13px;
  }

  /* 完了画面 */
  .success-box {
    background: rgba(110,231,183,0.08);
    border: 1px solid rgba(110,231,183,0.2);
  }
  .success-title {
    font-size: 20px; font-weight: 700; margin-bottom: 6px;
    display: flex; align-items: center; gap: 8px;
  }
  .success-sub { font-size: 13px; color: #94a3b8; margin-bottom: 16px; }

  .result-card {
    background: rgba(0,0,0,0.25);
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 14px;
  }
  .result-row {
    display: flex; justify-content: space-between;
    align-items: center; gap: 8px; margin-bottom: 10px;
    font-size: 12px;
  }
  .result-row:last-child { margin-bottom: 0; }
  .result-label { color: #94a3b8; font-weight: 600; white-space: nowrap; }
  .result-val {
    font-family: monospace; font-size: 11px;
    color: #e2e8f0; word-break: break-all; text-align: right;
  }
  .copy-btn {
    background: linear-gradient(135deg, #6c63ff, #48c6ef);
    color: white; border: none; border-radius: 8px;
    padding: 4px 10px; font-size: 11px; cursor: pointer;
    white-space: nowrap; flex-shrink: 0; font-weight: 600;
  }
  .copy-btn:hover { opacity: 0.85; }

  .code-block {
    display: block;
    background: rgba(0,0,0,0.3);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    padding: 10px 14px;
    font-family: monospace;
    font-size: 11px;
    color: #6ee7b7;
    word-break: break-all;
    margin: 6px 0 4px;
    white-space: pre;
    overflow-x: auto;
    line-height: 1.7;
  }

  .raw-card {
    background: rgba(167,139,250,0.08);
    border: 1px solid rgba(167,139,250,0.2);
    border-radius: 12px;
    padding: 14px;
    margin-top: 12px;
  }
  .raw-title {
    font-size: 13px; font-weight: 700; color: #c4b5fd;
    margin-bottom: 8px;
  }
  .raw-desc { font-size: 12px; color: #94a3b8; line-height: 1.7; }
  .raw-note { font-size: 11px; color: #64748b; margin-top: 8px; }

  .next-card {
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.2);
    border-radius: 12px;
    padding: 14px;
  }
  .next-title {
    font-size: 13px; font-weight: 700; color: #fcd34d;
    margin-bottom: 10px;
    display: flex; align-items: center; gap: 6px;
  }
  .next-item {
    display: flex; gap: 8px; margin-bottom: 8px;
    font-size: 12px; color: #cbd5e1; align-items: flex-start;
  }
  .next-item:last-child { margin-bottom: 0; }
  .next-num {
    background: rgba(245,158,11,0.3);
    color: #fcd34d; border-radius: 50%;
    width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; flex-shrink: 0;
  }
  .next-icon {
    font-size: 18px; flex-shrink: 0; margin-top: 1px;
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="icon">🌐</div>
    <h1>External Global Counter</h1>
    <p>アクセス数やゲームのプレイ統計等をGist上に記録</p>
  </div>

  <!-- セットアップカード -->
  <div class="card" id="setupCard">
    <div class="steps">
      <div class="steps-title">📋 事前準備</div>
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">
          <strong>GitHub Personal Access Token</strong> を作成
          <span class="sub">
            GitHub → Settings → Developer settings<br>
            → Fine-grained tokens → Generate new token<br>
            → Permissions: <strong>Gists → Read and write</strong>
          </span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">
          下のフォームに入力して <strong>「セットアップ開始」</strong>
        </div>
      </div>
    </div>

    <hr class="divider">

    <div class="field">
      <label class="label"><span class="emoji">🔑</span>GitHub Personal Access Token</label>
      <input type="text" id="token" placeholder="github_pat_xxxx または ghp_xxxx">
      <p class="hint">⚠️ このTokenは他の人に教えないでください</p>
    </div>

    <div class="field">
      <label class="label"><span class="emoji">📁</span>プロジェクト名</label>
      <input type="text" id="projectName" placeholder="例: my_game / roguelike_2026">
      <p class="hint">💡 英数字・アンダースコア・ハイフンが使えます</p>
    </div>

    <button class="btn" id="submitBtn" onclick="handleSubmit()">
      ✨ セットアップ開始
    </button>

    <!-- ローディング -->
    <div class="status loading-box" id="loadingStatus">
      <div class="spinner"></div>
      <span id="loadingText">GitHubへ接続しています...</span>
    </div>

    <!-- エラー -->
    <div class="status error-box" id="errorStatus"></div>
  </div>

  <!-- 完了カード -->
  <div class="card success-box status" id="successCard">
    <div class="success-title">🎉 セットアップ完了！</div>
    <p class="success-sub" id="successSub"></p>

    <div class="result-card" id="resultBox"></div>

    <div class="raw-card" style="margin-top:12px;margin-bottom:12px;">
      <div class="raw-title">📊 集計データの取得方法</div>
      <p class="raw-desc">
        以下のJSON Raw URLをゲーム内の表示やアクセス解析にご利用ください。<br>
        カウントデータが5分毎に自動更新されます。
      </p>
      <div class="result-row" style="margin-top:10px;">
        <span class="result-label">📡 Raw URL</span>
        <span class="result-val" id="rawUrlDisplay"></span>
        <button class="copy-btn" onclick="copyText(document.getElementById('rawUrlDisplay').textContent)">コピー</button>
      </div>
      <p class="raw-note">VRChatのVRCStringDownloaderやUnityのUnityWebRequestで直接取得できます</p>
    </div>

    <div class="next-card">
      <div class="next-title">🚀 カウントアップの方法</div>
      <div class="next-item">
        <div class="next-icon">🔗</div>
        <div>
          ゲームイベント発生時に現在のURLの最後にキーを付けてアクセスするだけ！<br>
          複数キーはカンマ区切りで同時送信できます。<br>
          例）stage1_play と weapon2_select のカウンタを進めるURL：<br>
          <div class="result-row" style="margin-top:8px;background:rgba(0,0,0,0.2);padding:8px 12px;border-radius:10px;">
            <a id="sampleLink1" href="#" target="_blank" style="font-family:monospace;font-size:11px;color:#6ee7b7;word-break:break-all;text-decoration:underline;flex:1;" id="sampleUrl1">（セットアップ完了後に自動生成）</a>
            <button class="copy-btn" onclick="copyText(document.getElementById('sampleLink1').textContent)">コピー</button>
          </div>
        </div>
      </div>
      <div class="next-item">
        <div class="next-icon">🎮</div>
        <div>
          <strong>Unity C#</strong> の場合<br>
          <code class="code-block">StartCoroutine(SendCount("stage1_play,stage1_clear"));

IEnumerator SendCount(string keys) {
    using var req = UnityWebRequest.Get(API_URL + "?keys=" + keys);
    yield return req.SendWebRequest();
}</code>
        </div>
      </div>
      <div class="next-item">
        <div class="next-icon">🌐</div>
        <div>
          <strong>VRChat UdonSharp</strong> の場合（VRCStringDownloader）<br>
          <code class="code-block">VRCStringDownloader.LoadUrl(
    new VRCUrl(API_URL + "?keys=stage1_play"),
    (IUdonEventReceiver)this
);</code>
        </div>
      </div>
      <div class="next-item">
        <div class="next-icon">🌍</div>
        <div>
          <strong>Web（HTML/JS）</strong> の場合<br>
          <code class="code-block">// imgタグ方式（CORSを気にせず使える）
const img = new Image();
img.src = API_URL + "?keys=stage1_play";

// fetch方式
fetch(API_URL + "?keys=stage1_play", { mode: "no-cors" });</code>
        </div>
      </div>
    </div>
  </div>

</div>

<script>
  function handleSubmit() {
    const token       = document.getElementById('token').value.trim();
    const projectName = document.getElementById('projectName').value.trim();

    if (!token) { showError('⚠️ GitHub Tokenを入力してください'); return; }
    if (!projectName) { showError('⚠️ プロジェクト名を入力してください'); return; }

    document.getElementById('submitBtn').disabled = true;
    hideStatus();
    setLoading('GitHubへ接続しています...');

    google.script.run
      .withSuccessHandler(onSuccess)
      .withFailureHandler(onError)
      .runSetup(token, projectName);
  }

  function onSuccess(r) {
    hideStatus();
    document.getElementById('submitBtn').disabled = false;

    document.getElementById('successSub').textContent =
      'プロジェクト「' + r.projectName + '」のGistが作成されました！';

    document.getElementById('resultBox').innerHTML =
      row('📄 ファイル名', r.fileName, null) +
      row('🔗 Gist URL', r.gistUrl, r.gistUrl, true);

    // デプロイURLをサンプルURLに設定
    var sampleUrl = r.apiUrl + '?keys=stage1_play,weapon2_select';
    var linkEl = document.getElementById('sampleLink1');
    linkEl.textContent = sampleUrl;
    linkEl.href = sampleUrl;
    document.getElementById('rawUrlDisplay').textContent = r.rawUrl;

    document.getElementById('setupCard').style.display = 'none';
    document.getElementById('successCard').style.display = 'block';
  }

  function row(label, val, copyVal, isLink) {
    const valHtml = isLink
      ? '<a href="' + val + '" target="_blank" style="color:#6ee7b7;font-size:11px;word-break:break-all;">' + val + '</a>'
      : '<span class="result-val">' + val + '</span>';
    const copyHtml = copyVal && !isLink
      ? '<button class="copy-btn" onclick="copyText(\\''+copyVal+'\\')">コピー</button>'
      : '';
    return '<div class="result-row"><span class="result-label">'+label+'</span>'+valHtml+copyHtml+'</div>';
  }

  function onError(err) {
    hideStatus();
    document.getElementById('submitBtn').disabled = false;
    showError('❌ ' + (err.message || err));
  }

  function setLoading(text) {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingStatus').style.display = 'flex';
  }

  function showError(msg) {
    const el = document.getElementById('errorStatus');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function hideStatus() {
    document.getElementById('loadingStatus').style.display = 'none';
    document.getElementById('errorStatus').style.display   = 'none';
  }

  function copyText(text) {
    navigator.clipboard.writeText(text)
      .then(() => alert('✅ コピーしました！'))
      .catch(() => prompt('URLをコピーしてください:', text));
  }
</script>
</body>
</html>`;
}

// -------------------------------------------
// セットアップ済みステータス画面HTML
// -------------------------------------------
function getStatusHtml(props) {
  const project = props.getProperty('PROJECT_NAME') || '(不明)';
  const gistUrl = props.getProperty('GIST_URL')     || '';
  const rawUrl  = props.getProperty('RAW_URL')      || '';
  const fileName= props.getProperty('GIST_FILENAME')|| '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🌐 External Global Counter</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family:'Helvetica Neue',Arial,'Hiragino Sans',sans-serif;
    background: linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);
    min-height:100vh; display:flex; align-items:center;
    justify-content:center; padding:20px; color:#fff;
  }
  .card {
    background:rgba(255,255,255,0.07);
    backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,0.1);
    border-radius:20px; padding:32px;
    width:100%; max-width:480px; text-align:center;
  }
  .icon { font-size:48px; margin-bottom:12px; }
  h1 { font-size:22px; font-weight:700; margin-bottom:6px; }
  .badge {
    display:inline-block;
    background:rgba(110,231,183,0.15);
    color:#6ee7b7; border-radius:20px;
    padding:4px 14px; font-size:12px; font-weight:600;
    margin-bottom:24px;
  }
  .info-row {
    background:rgba(0,0,0,0.2); border-radius:12px;
    padding:12px 16px; margin-bottom:10px;
    display:flex; justify-content:space-between;
    align-items:center; gap:8px; font-size:13px;
  }
  .info-label { color:#94a3b8; font-weight:600; white-space:nowrap; }
  .info-val { font-family:monospace; font-size:12px; color:#e2e8f0; word-break:break-all; text-align:right; }
  a { color:#6ee7b7; }
  .copy-btn {
    background:linear-gradient(135deg,#6c63ff,#48c6ef);
    color:white; border:none; border-radius:8px;
    padding:4px 10px; font-size:11px; cursor:pointer;
    white-space:nowrap; flex-shrink:0; font-weight:600;
  }
  .note { font-size:12px; color:#64748b; margin-top:16px; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>セットアップ済み</h1>
  <div class="badge">🟢 稼働中</div>

  <div class="info-row">
    <span class="info-label">📁 プロジェクト</span>
    <span class="info-val">${project}</span>
  </div>
  <div class="info-row">
    <span class="info-label">📄 ファイル</span>
    <span class="info-val">${fileName}</span>
  </div>
  <div class="info-row">
    <span class="info-label">🔗 Gist</span>
    <a href="${gistUrl}" target="_blank" style="font-size:11px;">${gistUrl}</a>
  </div>
  <div class="info-row">
    <span class="info-label">📡 Raw URL</span>
    <span class="info-val">${rawUrl}</span>
    <button class="copy-btn" onclick="copyText('${rawUrl}')">コピー</button>
  </div>

  <p class="note">⏱ Gistは5分毎に自動更新されます</p>
</div>
<script>
  function copyText(text) {
    navigator.clipboard.writeText(text)
      .then(() => alert('✅ コピーしました！'))
      .catch(() => prompt('URLをコピーしてください:', text));
  }
<\/script>
</body>
</html>`;
}
