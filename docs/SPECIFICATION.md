# LINE家計簿（ぶちこむ家計簿）機能仕様書

最終更新: 2026-07-01（コードベース実装準拠）

> 本書はリポジトリの**現行実装**をリバースエンジニアリングしてまとめた仕様書です。
> ルート `README.md` には旧設計（Vision API OCR 等）の記述が残っていますが、本書は実際のコードを正としています。
> システム構成・技術選定は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照してください。

---

## 1. プロダクト概要

LINE でメッセージを送るだけで支出を記録できる家計簿アプリケーション。

- **入力チャネル**
  1. **LINE Bot へのテキスト入力**（例: `500 ランチ`）
  2. **Gmail 連携**: 三井住友カード ゴールド(NL) の利用通知メールを自動取込
  3. **MoneyForward CSV**: Google Drive 上の CSV を日次バッチでインポート
  4. **Web アプリ**での手動編集・レシート画像添付
- **閲覧チャネル**
  - LINE Bot（`家計簿` コマンドで月次サマリー Flex メッセージ）
  - Web アプリ（Next.js / Vercel）: ダッシュボード・支出一覧・予算管理
- **共有機能**: LINE グループ単位での支出共有・立替（advance）管理・精算

> 📸 **レシート画像 OCR は廃止済み**（`bot/src/index.ts:102` 付近）。画像を送ると「テキストで入力してください」と案内されます。レシート画像は Web の `/attach` ページから支出への「添付」としてのみ扱われます。

---

## 2. LINE Bot 機能仕様

### 2.1 テキストコマンド一覧

| 入力 | 動作 |
|---|---|
| `家計簿` | 当月サマリーの Flex メッセージを返信（予算プログレスバー・カテゴリ別・直近支出）。個人トークなら個人集計、グループトークならグループ集計。8秒タイムアウト時はテキストにフォールバック |
| `カテゴリー` | 有効カテゴリ一覧と現在のデフォルトカテゴリを表示 |
| `カテゴリー <名前>` | デフォルトカテゴリを設定（`userSettings`） |
| `グループ作成 <名前>` | グループ作成＋6桁招待コード発行 |
| `参加 <コード> <表示名>` | 招待コードでグループ参加 |
| `グループ一覧` | 所属グループ一覧 |
| `立替一覧` / `立替` | （グループのみ）未精算の立替一覧と精算額計算 |
| `精算` | （グループのみ）立替を精算済みにする |
| `要望 / 改善 / 不具合 / フィードバック <本文>` | Gemini で内容を解析し GitHub Issue を自動起票（`Makoto041/line-kakeibo`） |
| その他のテキスト | 支出テキストとしてパース（§2.2）。金額が取れない場合は**無反応**（誤爆防止） |

### 2.2 支出テキスト入力フォーマット（`bot/src/textParser.ts`）

トークンは空白（半角/全角）区切り。順不同。

| 要素 | 書式 | 必須 | 例 |
|---|---|---|---|
| 金額 | `^\d+円?$`（カンマ許容） | ✅ | `500` `1,200円` |
| 日付 | `YYYY-MM-DD` / `M/D` / `MM/DD` / `M月D日` | −（省略時は当日） | `6/29` `6月29日` |
| 支払方法 | 現金/げんきん/キャッシュ→`cash`、paypay/ペイペイ→`paypay`、カード/クレカ/クレジット→`card` | −（省略時 `unknown`） | `現金` |
| カテゴリ | 正準19カテゴリ名と完全一致 | − | `食費` |
| 摘要 | 残りトークンを結合 | −（省略時 `支出`） | `ランチ` |

入力例: `500 ランチ` / `6/29 4800 家賃` / `1500 現金 ドラッグストア` / `3000 スーパー 食費`

### 2.3 支出登録フロー（`processExpenseInBackground`, `bot/src/index.ts`)

1. LINE プロフィール取得（リトライ＋15分メモリキャッシュ）
2. `appUid` 解決（LINE userId → Firebase Auth 匿名ユーザーを作成/取得。`linkUserResolver.ts`）
3. カテゴリ分類（§4）とユーザーデフォルトカテゴリを並列取得。Gemini の確信度 ≥ 0.4 なら採用、なければデフォルト、それも無ければ `その他`
4. `expenses` に保存（`confirmed: false`, `includeInTotal: false`, `inputSource: 'line_text'`）
5. 確認用 Flex メッセージを送信 — ボタン: **OK / 修正 / 立替 / カテゴリ変更 / レシート添付**

### 2.4 Postback アクション（`bot/src/line/postback.ts`）

| アクション | 効果 |
|---|---|
| confirm（OK） | `status: 'shared'`, `includeInTotal: true` |
| 修正 | `needsEdit: true` を設定し、Web 編集 URL（`/expenses?edit=<id>&lineId=...`）を案内 |
| 立替 | `status: 'advance_pending'`, `advanceBy` 設定 |
| shared / personal（Gmail 由来） | `includeInTotal` の切替、`status` 更新 |
| show_category_select | カテゴリ選択カルーセルを表示 |
| set_category | カテゴリを更新 |

### 2.5 メッセージ送信ポリシー

LINE 無料枠（push 200通/月）節約のため、**replyMessage 優先・pushMessage フォールバック**を全経路で徹底（`index.ts:118`、`flexMessage.ts:627`）。Flex メッセージのアイコンは `line-kakeibo.vercel.app/icons` から PNG 配信（lucide 風）。

---

## 3. 自動取込機能

### 3.1 Gmail 連携（三井住友カード利用通知）

- Gmail API（`gmail.readonly` スコープのみ）＋ **Pub/Sub push 通知**（topic: `gmail-notifications`）
- フロー: 新着メール → `gmailPubSubHandler` → history API で差分取得 → SMBC 利用通知をフィルタ → `gmail/parser.ts` で「利用先・金額・利用日時」を抽出 → Gemini でカテゴリ分類 → **アトミック保存**（`gmailMessageId` および `date+amount+usedAt(±1分)` で重複排除、`firestore.ts:137`）→ LINE グループへ Flex 通知（shared/personal/立替ボタン付き）
- 保存フィールド: `inputSource: 'gmail_auto'`, `usedAt`（カード利用日時）
- watch は7日で失効するため、**6日ごとの cron**（`renewGmailWatch`）で更新
- 管理エンドポイント（`api` function, `/gmail/*`）: OAuth 認可・watch 登録・状態確認・手動処理など。`ADMIN_SECRET` Bearer 認証＋レートリミット（OAuth callback のみ CSRF state 検証）

### 3.2 MoneyForward CSV インポート

- `importMoneyForward`（cron: 毎日 5:00 JST）
- Google Drive（ADC, `drive.readonly`）から最新の `MoneyForward*.csv` を取得 → 正規化 → Web API `${API_BASE_URL}/api/mf/import` へ POST（`MFKAKEIBO_TOKEN` 認証）

---

## 4. カテゴリ分類仕様

正準カテゴリは **19種**（`bot/src/categoryNormalization.ts` / `web/lib/categoryNormalization.ts`）。エイリアス・キーワード・正規表現で表記ゆれを正準化。

分類は 3 段のコスト最適化パイプライン（`bot/src/geminiCategoryClassifier.ts`）:

1. **高速キーワードマップ**（メモリ内、確信度 0.8）
2. **分類結果キャッシュ**（15分 TTL）＋ユーザー別カテゴリキャッシュ（30分 TTL）
3. **Gemini `gemini-2.5-flash`**（few-shot JSON プロンプト、8秒タイムアウト）— 上記ミス時のみ

ユーザーの修正は `categoryFeedback` コレクションに記録される。

> ⚠️ 既知の不整合: `types/shared.ts` の `EXPENSE_CATEGORIES` は 10 カテゴリで、正準 19 カテゴリと乖離しています（§8）。

---

## 5. Web アプリ機能仕様（`web/` — Next.js 15 App Router）

### 5.1 ページ一覧

| ルート | 内容 |
|---|---|
| `/` | **ダッシュボード**。期間ナビ、合計/件数/日平均カード、予算プログレス、カテゴリ円グラフ＋日別推移（Recharts）、前月比インサイト、残り日数ペース。`lineId` なしはゲストモード（サンプルデータ＋ガイド） |
| `/expenses` | **支出一覧**。フィルタ（全て/集計対象/対象外/カテゴリ）、ソート（日付/金額）、支払者別集計、インライン編集ドロワー、削除、集計対象トグル、レシートプレビュー。`?edit=<id>` で編集を自動オープン（LINE の「修正」ボタン連携） |
| `/settings` | **設定**。予算タブ（月次予算・アラート閾値・カテゴリ別予算）と期間タブ（月次/開始日カスタム/期間指定） |
| `/attach` | **レシート添付**。`?expenseId=` の支出にカメラ/アルバムから画像を選択→クライアント側で圧縮（リサイズ＋JPEG 再エンコード）→ Firebase Storage `receipts/{expenseId}/` へレジューマブルアップロード→ `receiptUrl` を書き戻し。アンマウント後もバックグラウンド継続 |
| `/link` | アカウント連携確認画面（`token` + `lineId` クエリの存在チェックのみ） |
| `/dashboard` | `/` へのリダイレクト（レガシー） |
| `/debug/firebase` | Firebase 初期化・接続テストのデバッグページ |
| `/terms` `/privacy` | 静的な規約・プライバシーページ |

### 5.2 UI/UX

- Tailwind CSS（CSS 変数トークン、`darkMode: 'class'`、ライト/ダーク/システム切替）
- framer-motion による SPA 風ページ遷移アニメーション＋メモリ内 SWR キャッシュ（`lib/swrCache.ts`）で再読込感を排除
- レスポンシブ: デスクトップはサイドバー、モバイルはボトムタブ
- `/attach` `/link` `/debug` はナビ chrome なし（BARE_ROUTES）

### 5.3 データアクセス

- **API Route は実質なし**（`/api/link` `/api/health` は無効化スタブ）。全て**クライアントから Firestore/Storage SDK 直アクセス**
- `lib/hooks.ts`: `useLineAuth`（URL の `?lineId=` から識別）、`useExpenses`（個人分＋ユーザーが関わった全 `lineGroupId` のグループ分をマージ）、`useBudgetConfig` ほか

---

## 6. データモデル（Firestore）

| コレクション | 主なフィールド | 備考 |
|---|---|---|
| `expenses` | `lineId`, `appUid?`, `groupId?`, `lineGroupId?`, `amount`, `description`, `date`(YYYY-MM-DD), `category`, `confirmed`, `includeInTotal`, `status`(`pending\|shared\|personal\|advance_pending\|advance_settled`), `inputSource`(`line_text\|line_ocr\|gmail_auto`), `payerId`, `payerDisplayName`, `paymentMethod`, `advanceBy?`, `advanceSettledAt?`, `gmailMessageId?`, `usedAt?`, `receiptUrl?`, `needsEdit?`, `items?[]`, `ocrText?`, `createdAt`, `updatedAt` | 中核コレクション |
| `groups` | `name`, `inviteCode`(6桁), `createdBy`, `lineGroupId?` | 汎用グループ機能はコード上「非推奨」— 実運用は LINE グループ共有 |
| `groupMembers` | `groupId`, `lineId`, `displayName`, `isActive`, `joinedAt` | |
| `userSettings/{lineId}` | `defaultCategory?`, `dateSettings` | 集計期間設定も格納 |
| `budgetSettings/{lineId or lineGroupId}` | `monthlyBudget`, `categoryBudgets`, `alertThreshold` | Web が書き、Bot のサマリーも参照 |
| `userLinks/{appUid}` | `lineId`（1:1, `firestore.ts`）／ `lineIds[]`（1:N, `userLinks.ts`＋`syncUserLinks` トリガー） | **2形式が併存**（§8） |
| `linkTokens/{token}` | `lineId`, `expiresAt`(15分), `used` | |
| `userCustomCategories` | `lineId`, `name`, `icon?`, `keywords?[]` | |
| `categoryFeedback` | `originalCategory`, `correctedCategory`, `description` | 分類改善用ログ |
| `system/{gmailToken,gmailState,oauthState}` | Gmail OAuth トークン・historyId・CSRF state | |

複合インデックス: `expenses` の `lineId/groupId/lineGroupId × createdAt/date/status` 組合せ、`groupMembers` の `lineId+isActive` / `groupId+isActive`（`firestore.indexes.json`）。

Storage: `receipts/{expenseId}/{fileName}` — 公開読取、書込は 10MB 未満かつ `image/*` のみ（`storage.rules`）。

---

## 7. 認証・認可モデル（現状）

- **Web**: ログイン機構なし。**URL クエリ `?lineId=` がそのままユーザー識別子**（LINE Bot が発行するリンクに付与）。`lineId` なしはゲスト（サンプルデータ表示）。LIFF・Firebase Auth ログインは未使用
- **Bot**: LINE webhook 署名検証（`LINE_CHANNEL_SECRET`）。`appUid` は Firebase Auth 匿名ユーザーとして裏で発行
- **Firestore ルール**: `userLinks` 以外は実質 `allow read, write: if true`（**DB 層のアクセス制御なし**）。README 記載の `request.auth.uid == resource.data.appUid` モデルは**未実装**。`web/firestore-security-rules-update.md` に強化案あり

> ⚠️ **セキュリティ上の重要な既知課題**: `lineId` を知っていれば誰でも他人のデータを読み書きできる構造です。改善方針は ARCHITECTURE.md §7 参照。

---

## 8. 既知の不整合・技術的負債

1. **README が旧設計のまま**: Vision API OCR / Cloud Functions 構成図 / `appUid` ベースのセキュリティルールなど、現実装と乖離
2. **OCR 関連ドキュメントが陳腐化**: `PR-cost-optimization-implementation.md` / `ISSUE-cost-optimization-ocr-improvement.md` が参照する `imageOptimizer.ts` `enhancedParser.ts` `parser.ts` `costMonitor.ts` は現存しない
3. **カテゴリ正準リストの乖離**: `types/shared.ts`（10種）vs `categoryNormalization.ts`（19種）
4. **`userLinks` の 2 形式併存**: `lineId`（1:1）と `lineIds[]`（1:N）
5. **Firestore ルールが実質無防備**（§7）
6. **未使用コード**: `web/lib/firebaseAdmin.ts`、`web/lib/hooks-realtime.ts`、`web/lib/analytics.ts`（テストのみ参照）、無効化された API Route
7. **テスト未整備**: `web/__tests__/analytics.test.ts` のみ（自前ランナー、CI 未接続）。`next.config.ts` は `ignoreBuildErrors: true` / `ignoreDuringBuilds: true`
8. **MoneyForward インポート先 `/api/mf/import` が web 側に見当たらない**（API Route は無効化済みのため要確認）

---

## 9. 環境変数一覧

### Bot（Firebase Functions secrets）

| 変数 | 用途 |
|---|---|
| `LINE_CHANNEL_TOKEN` / `LINE_CHANNEL_SECRET` | LINE Messaging API |
| `GEMINI_API_KEY` | カテゴリ分類・フィードバック解析 |
| `FIREBASE_PROJECT_ID` | 既定 `line-kakeibo-0410` |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` | Gmail OAuth |
| `DEFAULT_GROUP_ID` / `LINE_GROUP_ID` | Gmail 自動登録・通知先 |
| `ADMIN_SECRET` | Gmail 管理 API 認証 |
| `GITHUB_TOKEN` | フィードバック Issue 起票 |
| `API_BASE_URL` / `MFKAKEIBO_TOKEN` | MoneyForward インポート先 |

### Web（Vercel, すべてクライアント公開）

`NEXT_PUBLIC_FIREBASE_API_KEY` / `APP_ID` / `AUTH_DOMAIN` / `PROJECT_ID` / `STORAGE_BUCKET` / `MESSAGING_SENDER_ID` / `MEASUREMENT_ID`、開発用フラグ `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` / `NEXT_PUBLIC_DISABLE_REALTIME`
