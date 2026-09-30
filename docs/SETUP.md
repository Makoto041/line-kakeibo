# セットアップと運用手順

新しい環境で line-kakeibo を動かすための手順と、本番の設定・デプロイの仕組みをまとめる。
機能の仕様は [SPECIFICATION.md](SPECIFICATION.md)、構成は [ARCHITECTURE.md](ARCHITECTURE.md)、
セキュリティの運用は [SECURITY_OPERATIONS.md](SECURITY_OPERATIONS.md) を参照。

## 1. 前提

| 項目 | 内容 |
|---|---|
| Node.js | 22 以上（`package.json` の `engines`） |
| CLI | `firebase-tools`（Functions / ルールのデプロイ、エミュレータ）、`gcloud`（IAM・管理スクリプトの認証） |
| Firebase | プロジェクト `line-kakeibo-0410`（Firestore / Storage / Authentication / Functions gen2） |
| LINE Developers | Messaging API チャネル（bot）と LINE Login チャネル（LIFF。Web のログイン用） |
| Gemini | API キー（[Google AI Studio](https://aistudio.google.com/app/apikey)） |
| Vercel | プロジェクト `line-kakeibo`（Git 連携でデプロイ） |
| Gmail 自動取込（任意） | Google Cloud の OAuth クライアントと Pub/Sub。詳細は [GMAIL_AUTO_SPEC.md](GMAIL_AUTO_SPEC.md) |

## 2. リポジトリ

```bash
git clone https://github.com/Makoto041/line-kakeibo.git
cd line-kakeibo
npm install          # npm workspaces（bot / web）をまとめて入れる
```

`package-lock.json` は消さない・作り直さない（差分が大きくなり監査が効かなくなる）。依存を足すときは
`npm -w web install <pkg>` / `npm -w bot install <pkg>` で差分だけ更新する。

## 3. 環境変数

値はすべて秘匿する。`.env*` は gitignore 済みで、手で置く。各 `.env.example` にキーの一覧と説明がある。

### web（`web/.env.local`）

| キー | 内容 |
|---|---|
| `NEXT_PUBLIC_FIREBASE_*` | Firebase コンソール → プロジェクトの設定 → マイアプリ の値 |
| `NEXT_PUBLIC_LIFF_ID` | LIFF アプリ ID。未設定だと匿名サインインになり、データは読めない（プレビュー用の安全側） |
| `NEXT_PUBLIC_AUTH_ENDPOINT` | bot の `api` 関数の `/auth/line`（`https://us-central1-line-kakeibo-0410.cloudfunctions.net/api/auth/line`） |
| `NEXT_PUBLIC_API_BASE` | 任意。`/household/*` のベース URL。未設定なら `NEXT_PUBLIC_AUTH_ENDPOINT` から導く |

本番は Vercel のダッシュボード（Settings → Environment Variables）に同じキーを入れる。
`NEXT_PUBLIC_` 付きの値はブラウザに公開されるので、秘密値を入れない。

### bot（`bot/.env`）

ローカル開発では `bot/.env` に置く。本番は Firebase Secret Manager から関数に渡す（後述）。

| キー | 内容 |
|---|---|
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_TOKEN` | Messaging API チャネルのシークレットと長期アクセストークン |
| `LINE_LIFF_CHANNEL_ID` | LINE Login チャネルの ID（`/auth/line` で ID トークンの `aud` を検証する） |
| `ADMIN_SECRET` | 管理 API（`/gmail/*`）の Bearer トークン |
| `GEMINI_API_KEY` | カテゴリ分類・フィードバック解析 |
| `GEMINI_MODEL` | 任意。Gemini のモデル（既定 `gemini-3.5-flash-lite`） |
| `GITHUB_TOKEN` | 「要望 / 不具合」からの Issue 自動起票 |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` | Gmail 自動取込の OAuth |
| `FIREBASE_PROJECT_ID` | 既定 `line-kakeibo-0410` |
| `GOOGLE_APPLICATION_CREDENTIALS` | ローカルでの Admin SDK 認証（サービスアカウント JSON のパス）。本番では不要 |
| `LINE_GROUP_ID` / `DEFAULT_GROUP_ID` / `WEB_ORIGINS` | 任意（既定値あり） |

## 4. 外部サービスの設定

### LINE

1. Messaging API チャネル: Webhook URL を `webhook` 関数の URL（`https://webhook-<hash>-an.a.run.app/webhook`。
   デプロイログの `Function URL (webhook)` に出る）にし、「Webhook の利用」を ON、「応答メッセージ」を OFF にする。
   署名の無いリクエストは 401 で拒否される。
2. LINE Login チャネル: LIFF アプリを作り、エンドポイント URL を Web の本番 URL（`https://line-kakeibo.vercel.app/`）にする。
   LIFF ID を `NEXT_PUBLIC_LIFF_ID`、チャネル ID を `LINE_LIFF_CHANNEL_ID` に入れる。
3. bot を世帯の LINE グループに招待する。世帯のメンバー登録は自動では行われないので、
   `node scripts/manage-group-members.mjs add ...` で 2 名を登録する（[SECURITY_OPERATIONS.md §2](SECURITY_OPERATIONS.md)）。

### Firebase

- Authentication で「匿名」を有効にする（Web の初期状態）。LINE ログイン後はカスタムトークン（`lineId` クレーム付き）で入る。
- Firestore / Storage のルールは CI がデプロイする（`firestore.rules` / `storage.rules`）。
- Storage ルールは Firestore を参照する（cross-service rules）ため、一度だけ Storage のサービスエージェントに
  `roles/firebaserules.firestoreServiceAgent` を付ける（[SECURITY_OPERATIONS.md §4](SECURITY_OPERATIONS.md)）。
- 本番のシークレットは Secret Manager に入れる。関数は `secrets: [...]` で宣言した名前だけを読む。

  ```bash
  firebase functions:secrets:set LINE_CHANNEL_SECRET --project line-kakeibo-0410   # 値は対話で貼り付ける
  # 変更した値は関数を再デプロイするまで反映されない
  firebase functions:secrets:prune --project line-kakeibo-0410                       # 参照されていない古い版を消す
  ```

### Gemini

API キーを `GEMINI_API_KEY` に入れる。モデルは既定 `gemini-3.5-flash-lite`（`bot/src/geminiClient.ts`）で、
環境変数 `GEMINI_MODEL` で差し替えられる（思考の深さ `thinkingLevel` は Gemini 3 系のときだけ送る）。
分類の順序は入力の種類で違い、Gmail の店名は Gemini を優先する（SPECIFICATION.md §4）。Gemini が使えないときは辞書だけで動く。

### Vercel

- Git 連携で、`master` への push が本番、PR がプレビューになる。ワークフローからはデプロイしない。
- ビルド設定はルートの `vercel.json`（`cd web && npm run build`）。Root Directory はリポジトリのルート。
- 環境変数は §3 の web のキーをダッシュボードに入れる。

## 5. ローカル開発

```bash
npm -w web run dev      # http://localhost:3000（LIFF 未設定なら匿名＝データなしで開く）
npm -w bot run dev      # ts-node-dev で webhook を起動（LINE からの受信には公開 URL が必要）
```

エミュレータで動かすときは `NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true` で `next dev` を起動すると、
`web/lib/firebase.ts` が `localhost:8080` の Firestore に接続する（開発ビルドのみ）。

## 6. テスト

```bash
npm -w web test                 # ロジックのテスト（node --test）
npm -w bot test                 # ビルド＋スモークテスト
npm -w bot run test:emulator    # /household API と固定費の統合テスト（Firestore / Auth エミュレータ。Java 21 が必要）
```

Firestore / Storage のルールのテストは、依存を汚さないためリポジトリの外に道具を入れて実行する。
手順は `.github/workflows/pr-checks.yml` の `rules-tests` と同じ:

```bash
mkdir -p /tmp/rules-tools && cd /tmp/rules-tools && npm init -y >/dev/null \
  && npm i --no-save firebase-tools@15 @firebase/rules-unit-testing@5 firebase@12
cd /path/to/line-kakeibo && ln -s /tmp/rules-tools/node_modules node_modules   # 既存の node_modules がある場合は不要
/tmp/rules-tools/node_modules/.bin/firebase emulators:exec --only firestore,storage --project demo-kakeibo \
  "node test/firestore.rules.test.mjs && node test/storage.rules.test.mjs"
```

## 7. デプロイ

| 対象 | 方法 |
|---|---|
| Web | `master` へのマージで Vercel が自動デプロイ |
| Bot（Functions）＋ Firestore / Storage ルール | `master` へのマージで `ci-cd.yml` の `deploy-bot` が実行（`bot/**`・ルール・`firebase.json` に変更があるとき） |
| 手動で再デプロイ | GitHub Actions で `Improved CI/CD Pipeline` を `master` 上で `workflow_dispatch` 実行 |
| 手元から（緊急時） | `npm -w bot run deploy`（関数のみ）、`firebase deploy --only firestore:rules,storage --project line-kakeibo-0410`（ルール） |
| タグ・リリース | 実装（`feat` / `fix` / `perf` / `refactor` / `revert`）のマージごとに `release.yml` が `vX.Y.Z` のタグと GitHub Release を自動作成。手動は Actions の `Release Tag` を `workflow_dispatch`（`version` 指定） |

CI のデプロイには GitHub の `production-bot` environment に `GCP_SA_KEY`（Firebase Admin / Cloud Functions Developer 等を持つ
サービスアカウントの JSON）が必要。詳細は `.github/README.md`。

## 8. 運用メモ

- **シークレットの差し替え**: LINE コンソールで再発行 → `functions:secrets:set` → 関数を再デプロイ → 署名なし 401 と LINE の Webhook 検証で確認。
- **世帯メンバー・旧形式データ**: `scripts/manage-group-members.mjs`（`list` / `deactivate-unknown` / `add` / `legacy-expenses` / `backfill-group-id`）。既定は dry-run。
- **ログ**: `bot/scripts/view-logs.sh`、または Cloud Logging で関数名（`webhook` / `api` / `postRecurringExpenses` など）で絞る。
- **アイコン**: LINE カードのアイコン画像は `npm run gen:icons` で `web/public/icons` に生成する。
