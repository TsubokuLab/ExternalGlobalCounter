# 🌐 External Global Counter

Google Apps Script（GAS）と GitHub Gist を組み合わせた、**完全無料・サーバーレス**で動作する汎用カウンターAPIです。

URLにアクセスするだけでカウントできるため、Unity / VRChat / Web など幅広い環境で利用可能です。

---

## 特徴

- **完全無料** — GAS無料枠 + GitHub Gist無料枠で運営
- **GETリクエストのみ** — POSTやCORSの設定不要
- **複数キー同時カウント** — カンマ区切りで一度に複数のイベントを記録
- **高速・低負荷** — CacheServiceへの書き込みのみで即レスポンス。Gistへの書き込みは5分毎のバッチ処理
- **セットアップUI内蔵** — フォームに入力するだけで設定完了

---

## システム構成

```
[クライアント（ゲーム/Web）]
    ↓ GET ?keys=stage1_play,stage1_clear
[GAS Webアプリ（doGet）]
    ↓ CacheService に +1（高速・スプレッドシート不使用）
[CacheService（インメモリKVS）]
    ↓ 5分毎トリガー（flushToGist）
[GitHub Gist（counter.json）]
    ↑ Raw URL で直接取得
[ゲーム内表示・集計]
```

---

## セットアップ手順

### 1. GitHub Personal Access Token を取得

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
2. **「Generate new token」** をクリック
3. **Permissions → Gists → Read and write** を選択してトークンを生成
4. 表示されたトークンをコピー（このページを閉じると再表示されません）

### 2. GASプロジェクトを作成してデプロイ

1. [Google Apps Script](https://script.google.com/) で新規プロジェクトを作成
2. `Code.gs` の内容を全文コピペ
3. **「デプロイ」→「新しいデプロイ」** をクリック
   - 種類: **ウェブアプリ**
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
4. 「デプロイ」→ 表示されたWebアプリのURLを開く

### 3. セットアップ画面で初期設定

表示されたセットアップ画面に **GitHub Token** と **プロジェクト名** を入力して送信。

自動的に以下が実行されます:
- GitHubにGist（Secret）を新規作成
- 5分毎の自動同期トリガーを登録
- 設定をPropertiesServiceに保存

### 4. 完了 🎉

同じURLがそのままカウンターAPIとして使えます。

---

## API

### カウントアップ

```
GET https://script.google.com/macros/s/{DEPLOY_ID}/exec?keys={key1},{key2},...
```

**パラメータ:**

| パラメータ | 説明 |
|-----------|------|
| `keys` | カウントするキー名（カンマ区切りで複数指定可） |

**キー名の制約:** `^[a-zA-Z0-9_]{1,100}$`（英数字・アンダースコア、100文字以内）

**レスポンス:**

```json
// 成功
{"status": "ok", "keys": ["stage1_play", "stage1_clear"]}

// エラー（無効なキー）
{"status": "error", "message": "No valid keys"}

// エラー（サーバービジー）
{"status": "error", "message": "Server busy"}
```

### カウントデータの取得

集計データはGistのRaw URLから直接JSON形式で取得できます。

```
GET https://gist.githubusercontent.com/{user}/{gist_id}/raw/{filename}.json
```

**データ形式:**

```json
{
  "stage1_play": 4521,
  "stage1_clear": 2103,
  "stage2_play": 1876,
  "last_updated": "2026-04-21T10:30:00.000Z"
}
```

- キーは動的に追加されます（事前定義不要）
- `last_updated` は5分毎に自動更新されます

---

## クライアント実装例

### Unity C#（WebGL・スタンドアロン対応）

```csharp
const string API_URL = "https://script.google.com/macros/s/{DEPLOY_ID}/exec";

// 単一カウント
StartCoroutine(SendCount("stage1_play"));

// 複数同時カウント
StartCoroutine(SendCount("stage1_play,stage1_clear"));

IEnumerator SendCount(string keys) {
    using var req = UnityWebRequest.Get(API_URL + "?keys=" + keys);
    req.timeout = 10;
    yield return req.SendWebRequest();
    // Fire & Forget: エラーがあってもゲーム進行に影響させない
}
```

### VRChat UdonSharp（VRCStringDownloader）

```csharp
VRCStringDownloader.LoadUrl(
    new VRCUrl(API_URL + "?keys=stage1_play"),
    (IUdonEventReceiver)this
);
```

### Web（HTML/JavaScript）

```javascript
// imgタグ方式（CORSプリフライト不要・最もポータブル）
const img = new Image();
img.src = API_URL + "?keys=stage1_play";

// fetch方式
fetch(API_URL + "?keys=stage1_play", { mode: "no-cors" });
```

### 集計データの読み取り（Unity C#）

```csharp
IEnumerator FetchStats(string rawUrl) {
    using var req = UnityWebRequest.Get(rawUrl);
    yield return req.SendWebRequest();
    if (req.result == UnityWebRequest.Result.Success) {
        var json = JSON.Parse(req.downloadHandler.text);
        int plays  = json["stage1_play"].AsInt;
        int clears = json["stage1_clear"].AsInt;
        float clearRate = plays > 0 ? (float)clears / plays * 100f : 0f;
    }
}
```

---

## 制限事項

| 項目 | 制限 |
|------|------|
| GAS リクエスト数 | 20,000回/日（URLFetch） |
| GAS トリガー実行時間 | 累計90分/日 |
| CacheService TTL | 最大6時間（5分トリガーが停止すると未反映データが消失） |
| GitHub API | 5,000リクエスト/時（認証済み） |
| 同時書き込み競合 | LockService 5秒でタイムアウト → `Server busy` エラー |

---

## セキュリティについて

- GitHub TokenはPropertiesServiceに保存されるため、コードを公開しても露出しません
- GistはSecret設定（URLを知っている人のみ閲覧可能）
- APIのURLが漏れると誰でもカウントを増やせます（不正送信対策は未実装）

---

## ライセンス

[MIT](LICENSE)
