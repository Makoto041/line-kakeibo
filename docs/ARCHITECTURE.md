# LINE家計簿 アーキテクチャ概要

最終更新: 2026-09-28（コードベース実装準拠）

機能仕様は [SPECIFICATION.md](./SPECIFICATION.md)、認証・セキュリティルール・世帯メンバーの運用は [SECURITY_OPERATIONS.md](./SECURITY_OPERATIONS.md)、初期セットアップは [SETUP.md](./SETUP.md) を参照。

---

## 1. システム全体像

```mermaid
flowchart LR
    subgraph User["ユーザー"]
        LINE["LINE アプリ"]
        Browser["ブラウザ / LINE内WebView<br/>(LIFF ログイン)"]
    end

    subgraph GCP["Google Cloud (line-kakeibo-0410)"]
        subgraph Functions["Firebase Functions gen2 / Node.js 22 (asia-northeast1)"]
            webhook["webhook<br/>(Express: LINE webhook, /health)"]
            gmailHandler["gmailPubSubHandler"]
            renewWatch["renewGmailWatch<br/>(cron: 6日ごと 3:00 JST)"]
            mfImport["importMoneyForward<br/>(cron: 毎日 5:00 JST)"]
            recurring["postRecurringExpenses<br/>(cron: 毎日 6:10 JST)"]
            syncLinks["syncUserLinks<br/>(Firestoreトリガー・無効化済み)"]
            gmailApi["api (us-central1)<br/>/gmail/* /auth/line /household/*"]
        end
        FS[("Firestore<br/>firestore.rules")]
        ST[("Cloud Storage receipts/<br/>storage.rules (cross-service)")]
        PS["Pub/Sub<br/>gmail-notifications"]
        Auth["Firebase Auth<br/>(カスタムトークン: uid=appUid, claim lineId)"]
    end

    subgraph Vercel["Vercel"]
        Web["Next.js 16 Web<br/>(App Router / CSR中心)"]
    end

    subgraph External["外部サービス"]
        LMA["LINE Messaging API"]
        LLogin["LINE Login (LIFF)"]
        Gemini["Gemini 2.5 Flash"]
        Gmail["Gmail API"]
        Drive["Google Drive<br/>(MoneyForward CSV)"]
        GH["GitHub API<br/>(Issue起票)"]
    end

    LINE -->|webhook| LMA -->|POST /webhook| webhook
    webhook -->|reply/push Flex| LMA
    webhook --> Gemini
    webhook --> GH
    webhook --> FS
    webhook --> Auth
    Gmail -->|push通知| PS --> gmailHandler
    gmailHandler --> Gmail
    gmailHandler --> Gemini
    gmailHandler --> FS
    gmailHandler -->|Flex通知| LMA
    renewWatch --> Gmail
    mfImport --> Drive
    mfImport -->|POST /api/mf/import| Web
    recurring --> FS
    FS -->|onDocumentCreated expenses| syncLinks
    Browser --> Web
    Web -->|LIFF ID トークン| LLogin
    Web -->|POST /auth/line| gmailApi -->|カスタムトークン| Auth
    Web -->|ID トークン付き /household/*| gmailApi
    gmailApi --> FS
    Web -->|クライアントSDK直（ルール適用）| FS
    Web -->|レシート画像| ST
    ST -.->|firestore.get()| FS
```

## 2. コンポーネント構成

| コンポーネント | 技術 | ホスティング | 役割 |
|---|---|---|---|
| `bot/` | Node.js 22 + TypeScript + Express 5 + `@line/bot-sdk` v11 + `firebase-functions` v7 | Firebase Functions gen2（`firebase.json` の `functions.source: "bot"` / `runtime: nodejs22` / region `asia-northeast1`。`api` 関数のみ `us-central1`） | LINE webhook、Gmail 取込、cron バッチ（MoneyForward 取込・Gmail watch 更新・固定費計上）、Web 向け API（LIFF ログイン・確認・精算・固定費） |
| `web/` | Next.js 16（App Router）+ React 19 + TypeScript + Tailwind CSS v4 + Recharts + framer-motion + `@line/liff` | Vercel（Git 連携。設定はリポジトリ直下の `vercel.json`） | ダッシュボード・支出管理 UI。読み取りと通常の編集は**クライアントから Firestore/Storage 直アクセス**（セキュリティルールで制御）。確認・精算・固定費・折半設定は bot の `api` 関数経由 |
| Firestore | − | GCP | 唯一の永続データストア。ルール/インデックスはリポジトリ管理（`firestore.rules` / `firestore.indexes.json`） |
| Cloud Storage | − | GCP | レシート画像（`receipts/{expenseId}/`）。`storage.rules` は cross-service rules で Firestore の支出・メンバーシップを参照 |

### デプロイ単位が Vercel と Firebase に分かれている点に注意

- Web → Vercel の Git 連携（PR ごとのプレビュー、`master` で本番）
- Bot・Firestore ルール/インデックス・Storage ルール → GitHub Actions `ci-cd.yml` の `deploy-bot`（`firebase deploy`）
- Flex メッセージのアイコン PNG は **Vercel（web/public/icons）から配信**され Bot が参照する（`bot/src/line/flexMessage.ts` の `ICON_BASE`）、というクロス依存がある

## 3. Cloud Functions 一覧

| Function | トリガー | リージョン | 役割 |
|---|---|---|---|
| `webhook` | HTTPS（Express） | asia-northeast1 | LINE webhook 本体（署名検証は fail-closed、本文上限 1MB）。`/health` も同居（認証なしのデバッグ用 `/classification-stats` `/test-classification` は削除済み）。本番 URL は Cloud Run 形式 `https://webhook-4tgziqsylq-an.a.run.app/webhook` |
| `gmailPubSubHandler` | Pub/Sub `gmail-notifications` | asia-northeast1 | SMBC カード利用メールの取込 |
| `renewGmailWatch` | cron `0 3 */6 * *` JST | asia-northeast1 | Gmail watch（7日失効）の更新 |
| `importMoneyForward` | cron `0 5 * * *` JST | asia-northeast1 | Drive の MoneyForward CSV 取込 |
| `postRecurringExpenses` | cron `10 6 * * *` JST | asia-northeast1 | 固定費（`recurringExpenses`）のうち引き落とし日を迎えた項目を `expenses` に計上（`recurringExpenses.ts`。同じ月に 2 回は入らない。LINE 通知なし） |
| `syncUserLinks` | Firestore `expenses/{id}` onCreate | asia-northeast1 | **無効化済み（何もしない）**。export から外すと CI の非対話デプロイが関数削除の確認で失敗するため残置。削除は手動 `firebase functions:delete syncUserLinks` |
| `api` | HTTPS（Express） | **us-central1** | Gmail OAuth / watch 管理 `/gmail/*`（`ADMIN_SECRET` 認証）、LIFF ログイン `/auth/line`、Web の確認・精算・固定費・折半設定 `/household/*`（Firebase ID トークン認証。SPECIFICATION.md §5.4） |

## 4. 主要データフロー

### 4.1 テキスト支出登録

```text
LINEテキスト → webhook(署名検証)
  → parseTextExpense()（金額必須・日付/支払方法/カテゴリ/摘要を抽出）
  → 並列: プロフィール取得(15分cache) / appUid解決(匿名Auth) / カテゴリ分類
  → カテゴリ分類: キーワードマップ → キャッシュ → Gemini 2.5 Flash（確信度≥0.4で採用）
  → グループ所属の決定（expenseGroupScope.ts: 発言元 LINE グループに紐づく世帯の有効メンバーなら groupId+lineGroupId、それ以外は個人支出）
  → expenses 保存 (confirmed:false, includeInTotal:false, inputSource:'line_text')
  → 確認Flex返信（現在の設定3行＋[変更] / OK / 修正 / レシート添付 / 家計簿一覧を見る）
  → postbackで status / includeInTotal / category を確定 → 最新値のカードを返信
```

### 4.2 Gmail カード利用自動取込

```text
SMBC利用通知メール → Gmail push → Pub/Sub → gmailPubSubHandler
  → history API差分取得 → SMBCフィルタ → 利用先/金額/利用日時パース
  → Gemini分類 → Firestoreトランザクションでアトミック保存
     （gmailMessageId ＋ date+amount+店舗名の類似+usedAt±1分 の二重チェックで重複排除）
  → LINEグループへFlex通知（テキスト入力と同じ登録・編集カード）
```

### 4.3 Web 閲覧・編集

```text
Web を開く（LINE の「家計簿一覧を見る」/「修正」リンク、または直接）
  → initLineAuth()（lib/lineAuth.ts）: LIFF 初期化 → 未ログインなら LINE ログインへ
  → LIFF の ID トークンを POST /auth/line（api 関数）へ → LINE の verify API で検証
  → Firebase カスタムトークン（uid=appUid, claim lineId）で signInWithCustomToken
  → useLineAuth: lineId は ID トークンのクレームからのみ取得（URL の ?lineId= は使わない）
  → useExpenses: 個人分(where lineId==) ＋ groupMembers(isActive) から解決した groupId の世帯分をマージ
  → メモリSWRキャッシュ＋framer-motionでSPA風遷移
  → 編集/削除/レシート添付はクライアントSDKでFirestore/Storageへ直書き（ルールで許可された範囲のみ）
  → 確認（要確認→共同費）・立替の精算・固定費・折半設定は ID トークン付きで api 関数の /household/* を呼ぶ
```

### 4.4 立替・精算（グループ）

- 支出を `status: 'advance_pending'` + `advanceBy` でマーク
- `立替一覧` コマンドで未精算集計と精算額計算、`精算` で `advance_settled` へ一括更新
- Web の精算タブ（`/settlement`）は `api` 関数の `GET /household/settlement` / `POST /household/settlement/settle` で同じ集合（`lineGroupId` 基準）を表示・精算する（Web からの精算では LINE へ通知しない）
- 精算額の決め方は `householdSettlement.ts` の共有関数（1 人だけ立替・有効メンバー 2 人なら相手を 0 円で補う点は LINE と Web で同じ。Web は有効メンバー 2 人の世帯に限り、LINE は立替者 2 人なら従来どおり計算する。SPECIFICATION.md §5.4）
- 精算タブにはもう 1 つ、**期間の精算（折半）**がある（`components/PeriodSplitCard.tsx` + `lib/periodSplit.ts`）。表示期間内の世帯の支出（合計に含むもの。立替精算済みは除く）を 2 人で折半し、`groups.splitSettings.collectFromLineId`（`POST /household/split-settings` で保存）に指定したメンバーの支払い分を引いて集金額を出す。クライアント側の純関数で計算し、記録は残さない
- 支出の確認（LINE の OK / Web の確認ボタン）は `expenseActions.ts` の `applyExpenseChange` + `decideConfirm` を共用する
- Web の支出一覧では支払者（`payerId`/`payerDisplayName`）別集計を表示

### 4.5 固定費（毎月の自動計上）

- 項目は `recurringExpenses/{id}`（世帯 `groupId` 単位、上限 30 件）。クライアントからは読み書きできず、Web の設定 > 固定費タブ（`components/RecurringExpensesPanel.tsx`）が `/household/recurring` の CRUD を通して Admin SDK で扱う
- `postRecurringExpenses` が毎朝 6:10 JST に、引き落とし日（`dayOfMonth`。月の日数を超える日は末日）を迎えた有効な項目を `expenses` に計上する。文書 ID を `recurring_{項目ID}_{YYYYMM}` に固定して create するため冪等
- 支払い元 `shared`（共通のカード・口座）は `lineId`/`payerId` = `recurring-system`・`status: 'shared'`、`advance`（メンバーの個人口座）はその人の立替（`advance_pending`）として計上する。いずれも `inputSource: 'recurring'`・`confirmed: true`・`includeInTotal: true`

## 5. カテゴリ分類パイプライン（コスト最適化）

```text
入力テキスト
  ├─ 1. 結果キャッシュ（関数インスタンスのメモリ内。15分TTL）── ヒット→終了
  ├─ 2. FAST_KEYWORD_MAP（メモリ内・即時・conf 0.8）── ヒット→終了
  └─ 3. Gemini gemini-2.5-flash（few-shot JSON・8sタイムアウト。候補のカテゴリ一覧は Firestore から読み 30分キャッシュ）
        └─ 出力を categoryNormalization で正準19カテゴリに正規化
```

その他のコスト施策:

- **replyMessage 優先・push フォールバック**（LINE 無料枠 200 push/月の節約。※テキスト支出の登録通知と postback 応答（設定変更後のカード再送・カテゴリ選択カルーセル・各種案内）が対象。Gmail カード通知のみグループ宛の非同期プッシュで reply トークンが無く push 専用）
- LINE プロフィール 15 分メモリキャッシュ、`Promise.allSettled` による並列化
- レシート画像はアップロード前にクライアントで圧縮（`web/lib/imageCompress.ts`。OCR / Vision API は廃止済み）
- 固定費の自動計上は LINE 通知を送らない（push 枠を使わない）
- Function ごとのメモリチューニング（webhook / importMoneyForward 512MiB、Gmail 系 / 固定費 256MiB）

## 6. 認証・セキュリティモデル

Web のアクセス制御は **LIFF ログイン → Firebase カスタムトークン → Firestore/Storage ルール** で行う。詳細な運用手順と残課題は [SECURITY_OPERATIONS.md](./SECURITY_OPERATIONS.md)。

| レイヤ | 現状 |
|---|---|
| LINE webhook | チャネルシークレットによる署名検証（fail-closed）、本文上限 1MB |
| Web ログイン | LIFF（`NEXT_PUBLIC_LIFF_ID`）でログイン → ID トークンを `POST /auth/line` へ → LINE の verify API で `aud`（`LINE_LIFF_CHANNEL_ID`）/ `iss` / `exp` を検証 → Firebase カスタムトークン（`uid=appUid`、カスタムクレーム `lineId`）。**URL の `?lineId=` は識別に使わない**（`web/lib/lineAuth.ts`）。LIFF 未設定時は匿名サインインにフォールバックし、`lineId` クレームが無いためデータは一切読めない（フェイルセーフ） |
| Firestore ルール | 所有者（`resource.data.lineId == token.lineId`）と世帯メンバー（`groupMembers/{groupId}_{lineId}.isActive == true`）で判定。`expenses` の create / update / delete はフィールド許可リストと値の検証付き（`status` / `advanceBy` / `inputSource` などはクライアント不変）。精算済み（`advance_settled`）は金額・日付・支払者の変更と削除を禁止。`groups` / `groupMembers` / `userLinks` / `linkTokens` はクライアント書込不可、未定義パスは既定拒否。システムユーザーの支出（`gmail-auto-system` / `recurring-system`）は世帯メンバーが修正・削除できる。bot は Admin SDK でルールをバイパスする |
| Storage ルール | cross-service rules（`firestore.get()` / `firestore.exists()`）で支出と `groupMembers` を参照。所有者 / 有効メンバーだけが get・アップロード・削除でき、list は不可。5MB 以下の JPEG / PNG / WebP / HEIC / HEIF のみ。精算済み支出のレシートは上書き・削除不可。Storage サービスエージェントに `roles/firebaserules.firestoreServiceAgent` が必要（SECURITY_OPERATIONS.md §4） |
| Web 向け API（`/household/*`） | Firebase ID トークン（`sign_in_provider=custom` かつ `lineId` クレーム）＋ `groupMembers` の有効メンバー判定。レート制限、CORS 許可リスト（`webOrigins.ts`）、`Cache-Control: no-store` |
| 世帯メンバー | 2 名固定。bot は発言や招待コードでメンバーを自動追加しない（LINE の `参加` コマンドは無効化済み）。非メンバーの発言は個人支出として保存（`expenseGroupScope.ts`）。LINE グループ退出（`memberLeft`）で `isActive:false`。追加・無効化は `scripts/manage-group-members.mjs` |
| Gmail 管理 API | `ADMIN_SECRET`（`Authorization: Bearer` ヘッダーのみ。定数時間比較。クエリ渡しは廃止）＋ レートリミット、OAuth callback は CSRF state |
| Gmail スコープ | `gmail.readonly` に最小化 |

ルールは `test/firestore.rules.test.mjs` / `test/storage.rules.test.mjs` でエミュレータ検証し、PR ごとに `pr-checks.yml` の `rules-tests` が実行する。

## 7. デプロイ・CI/CD

- **ブランチ運用**: `master` が本番。作業ブランチを切って PR → CI 完了 → squash マージ。`develop` ブランチと手動デプロイスクリプトは廃止
- **デプロイの担当**:
  - Web（Vercel）→ **Vercel の Git 連携**が実行する（PR ごとにプレビュー、`master` へのマージで本番）。GitHub Actions 側にデプロイジョブは持たない。ロールバックは Vercel ダッシュボードから
  - Bot / Firestore ルール・インデックス / Storage ルール → `ci-cd.yml` の `deploy-bot`。`master` への push で `bot/**` やルール類に変更があるとき、または `master` 上での `workflow_dispatch`（再デプロイ用）に実行。Storage の cross-service rules に必要な IAM ロールを事前確認し、確認できない場合は `storage` を除外してデプロイする（SECURITY_OPERATIONS.md §4）。成功後に `post-deploy-check` が webhook の `/health` を確認し Slack へ通知
- **`deploy-bot` の前提**: GitHub の `production-bot` Environment に **`GCP_SA_KEY`**（Firebase プロジェクトのサービスアカウント JSON）が必要。`onRequest({ secrets: [...] })` を使う関数をデプロイするため、Cloud Functions / Cloud Run のデプロイ権限に加えて **Secret Manager の参照権限**も要る。`FIREBASE_PROJECT_ID` は任意（未設定時は `line-kakeibo-0410`）、`SLACK_WEBHOOK_URL` は任意
- **GitHub Actions**: `ci-cd.yml`（changes → install-deps → lint / build-and-test → security（PR のみ）→ deploy-bot → post-deploy-check）と `pr-checks.yml`（`rules-tests`）。詳細は `.github/README.md`
- **テスト**: `npm -w web test`（`node --test __tests__/*.test.mjs`）、`npm -w bot test`（ビルド＋スモークスクリプト）、`npm -w bot run test:emulator`（`/household` API と固定費を Firestore / Auth エミュレータで検証）、ルールテスト（上記）。`build-and-test` ジョブが web / bot の `npm test` を実行する
- **ローカル開発**: `web` は `npm -w web run dev`（:3000）、`bot` は `npm -w bot run dev`（`ts-node-dev`）＋ Firebase Emulator（`NEXT_PUBLIC_USE_FIREBASE_EMULATOR`）。環境変数の準備は [SETUP.md](./SETUP.md)

## 8. ディレクトリ構成（現行）

```text
line-kakeibo/
├─ bot/                      # Firebase Functions gen2 (Node 22)
│  ├─ src/
│  │  ├─ index.ts            # 初期化と Function のエクスポート（webhook / api / スケジュール関数）だけ
│  │  ├─ textParser.ts       # 支出テキストパーサ
│  │  ├─ firestore.ts        # Firestore データアクセス（支出/グループ/メンバー/予算/精算）
│  │  ├─ expenseActions.ts   # 支出の確認の判定とトランザクション（LINE postback と Web API で共用）
│  │  ├─ expenseGroupScope.ts # LINE 発言に付ける groupId / lineGroupId の決定（非メンバーは個人支出）
│  │  ├─ householdApi.ts     # Web 向け /household ルーター（ID トークン認証・メンバー確認・CORS・レート制限・固定費 CRUD・折半設定）
│  │  ├─ householdSettlement.ts # 精算額の決め方（LINE の立替一覧/精算と Web で共用）
│  │  ├─ recurringExpenses.ts # 固定費の検証・計上ロジック（postRecurringExpenses）
│  │  ├─ webOrigins.ts       # Web オリジンの許可リスト（/auth/line と /household で共用）
│  │  ├─ adminAuth.ts        # ADMIN_SECRET の定数時間比較
│  │  ├─ logSafe.ts / time.ts # ログのマスク・JST 日付
│  │  ├─ geminiCategoryClassifier.ts / categoryNormalization.ts
│  │  ├─ linkUserResolver.ts / syncUserLinks.ts
│  │  ├─ issueCreator.ts     # フィードバック→GitHub Issue
│  │  ├─ importMoneyForward.ts
│  │  ├─ auth/lineAuth.ts    # /auth/line（LIFF の ID トークン → Firebase カスタムトークン）
│  │  ├─ line/               # webhookApp.ts（署名検証・イベント振り分け・/health）/ textMessage.ts / commands/*.ts（家計簿・要望・カテゴリー・グループ・立替/精算）
│  │  │                      # / expenseFlow.ts（テキスト入力の支出登録）/ groupEvents.ts / client.ts（LINE クライアント・返信）/ flexMessage.ts / postback.ts
│  │  └─ gmail/              # auth.ts / watch.ts / parser.ts / handler.ts / types.ts / adminRouter.ts（/gmail/* 管理 API）/ index.ts
│  ├─ scripts/               # smoke-*.js（npm test）/ emulator-*.js（test:emulator）/ firebase.emulator.json
│  └─ .env.example
├─ web/                      # Next.js 16 (Vercel)
│  ├─ app/                   # / , /expenses , /settlement , /settings , /attach , /link , /dashboard , /terms , /privacy
│  ├─ components/            # Charts, PeriodSplitCard, RecurringExpensesPanel, GuestGuide, layout/(AppShell, Sidebar, BottomTabBar, TopBar, nav), theme/
│  ├─ lib/                   # firebase.ts, lineAuth.ts, hooks.ts, householdApi.ts, householdContract.ts, recurringApi.ts,
│  │                         # periodSplit.ts, settlementView.ts, expenseState.ts, dateSettings.ts, swrCache.ts, categoryNormalization.ts ほか
│  ├─ __tests__/             # renewal-logic.test.mjs / periodSplit.test.mjs（node --test）
│  ├─ public/icons/          # Flex メッセージ用アイコン PNG（scripts/gen-line-icons.mjs で生成）
│  └─ .env.example
├─ scripts/                  # manage-group-members.mjs（世帯メンバー管理）/ gen-line-icons.mjs（LINE カードのアイコン生成）
├─ test/                     # firestore.rules.test.mjs / storage.rules.test.mjs（エミュレータ）
├─ firestore.rules / firestore.indexes.json / storage.rules
├─ firebase.json / .firebaserc / vercel.json
├─ .github/                  # workflows/(ci-cd.yml, pr-checks.yml), README.md, PULL_REQUEST_TEMPLATE.md, dependabot.yml
└─ docs/                     # ARCHITECTURE.md / SPECIFICATION.md / SECURITY_OPERATIONS.md / GMAIL_AUTO_SPEC.md / SETUP.md
```
