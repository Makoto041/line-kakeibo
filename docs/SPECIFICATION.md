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
| カテゴリ | 正準19カテゴリ名と完全一致（※パーサは抽出するが**現行の登録処理では未使用** — §2.3参照） | − | `食費` |
| 摘要 | 残りトークンを結合 | −（省略時 `支出`） | `ランチ` |

入力例: `500 ランチ` / `6/29 4800 家賃` / `1500 現金 ドラッグストア`

> ⚠️ **カテゴリトークンは現状指定しても反映されない**: `parseTextExpense()` はカテゴリを抽出するものの、登録処理（`processExpenseInBackground`）は `parsed.category` を参照せず、常に Gemini 分類／ユーザーデフォルトからカテゴリを決定します（`bot/src/index.ts:1025` 付近）。カテゴリの変更は登録後の「カテゴリ変更」ボタンで行います。

### 2.3 支出登録フロー（`processExpenseInBackground`, `bot/src/index.ts`)

1. LINE プロフィール取得（リトライ＋15分メモリキャッシュ）
2. `appUid` 解決（LINE userId → Firebase Auth 匿名ユーザーを作成/取得。`linkUserResolver.ts`）
3. カテゴリ分類（§4）とユーザーデフォルトカテゴリを並列取得。Gemini の確信度 ≥ 0.4 なら採用、なければデフォルト、それも無ければ `その他`
4. `expenses` に保存（`confirmed: false`, `includeInTotal: false`, `inputSource: 'line_text'`）
5. 確認用 Flex メッセージを送信（§2.4 の登録・編集カード）

### 2.4 登録・編集カードの構成（`bot/src/line/flexMessage.ts`）

テキスト入力・Gmail カード利用の両方で同じビルダー（`buildExpenseCard`）を使い、ヘッダー文言と金額下の補足行だけを差し替える。**現在の設定値はリッチテキストで表示し、ボタンは変更操作だけを担う**。

```text
現在の設定
支出区分：共同費　　[変更]
立替：なし　　　　　[変更]
カテゴリ：食費　　　[変更]
```

| 領域 | 内容 |
|---|---|
| ヘッダー | テキスト入力=「支出を登録しました」/ カード利用=「カード利用を記録」 |
| 本文 | 店舗名・説明 → 金額と日付 → （残り予算 / 支払い方法・支払い者）→ 「現在の設定」3行 |
| フッター | `OK` `修正` / `レシート添付` / `家計簿一覧を見る` |

支出区分と立替は単一の `status` フィールドに排他的に入るため、表示上の 2 行は `status` から導出する（`deriveExpenseSettings()`）。`pending` のときだけ、実際の集計挙動（`includeInTotal`）に合わせて表示を変える。

| `status` | `includeInTotal` | 支出区分 | 立替 |
|---|---|---|---|
| `pending` | `true`（Gmail 自動取得） | 共同費（未確認） | なし |
| `pending` | `false`（LINE 手入力） | 未設定 | なし |
| `shared` | — | 共同費 | なし |
| `personal` | — | 個人費 | なし |
| `advance_pending` | — | 共同費 | あり（精算待ち） |
| `advance_settled` | — | 共同費 | 精算済み |

`advance_settled` の行には支出区分・立替の [変更] を出さない（カテゴリのみ変更可）。

### 2.5 Postback アクション（`bot/src/line/postback.ts`）

[変更] ボタンにはトグル（反転）ではなく**設定する値そのもの**を埋め込む（`to`）。カード描画時点の現在値の反対が入っているため、古いカードから押しても表示どおりの結果になる。

| アクション | 効果 |
|---|---|
| `set_split`（`to: shared \| personal`） | `status` を設定し `includeInTotal` を連動（`shared`=true / `personal`=false）。立替は解除（`advanceBy` を削除）。あわせて `confirmed: true` |
| `set_advance`（`to: on \| off`） | on=`status: 'advance_pending'`・`advanceBy` に押下者 / off=`status: 'shared'`・`advanceBy` 削除。いずれも `includeInTotal: true`・`confirmed: true` |
| `confirm`（OK） | `confirmed: true`。**`pending` のときだけ** `status: 'shared'`・`includeInTotal: true` へ昇格（設定済みの支出を共同費へ巻き戻さない） |
| `edit`（修正） | `needsEdit: true` を設定し、Web 編集 URL（`/expenses?edit=<id>&lineId=...`）を案内 |
| `show_category_select` / `set_category` | カテゴリ選択カルーセルを表示 / カテゴリを更新 |
| `show_list` | 押下者の `lineId` を含む家計簿一覧 URL を返す |
| `shared` / `personal` / `advance`（旧 UI） | 配信済みカードからの押下に備えて `set_split` / `set_advance` へ読み替える |

**矛盾の解消**: 個人費にすると立替は解除され、立替ありにすると支出区分は共同費相当に揃う（個人費かつ立替ありは成立しない）。`advance_settled` の支出に対する**支出区分・立替の変更**はサーバー側で拒否する（古いカードにボタンが残っているため、表示を消すだけでは足りない）。カテゴリ変更は精算後も可能（精算額に影響しないため）。

**変更後の再表示**: LINE は送信済みメッセージを編集できないため、状態を変えたら最新値のカードを `replyToken` で返信する（`buildExpenseCardFromRecord()`）。登録直後のカードと同じビルダーを通すので表現がぶれない。

**同時操作**: グループトークでは複数人が同時にボタンを押せるため、読み取り・判定・更新は `runTransaction` で1トランザクションにまとめる（`applyExpenseChange()`）。分離していると、誰かが個人費にした直後に別の人の OK が古い `pending` を読んで共同費へ巻き戻したり、精算済み判定をすり抜けて変更が通ったりする。

### 2.6 メッセージ送信ポリシー

LINE 無料枠（push 200通/月）節約のため、**テキスト支出の登録通知**は replyMessage 優先・pushMessage フォールバックで送信（`sendTextExpenseNotification`, `flexMessage.ts`。reply トークン失効時のみ push）。

Postback への応答（設定変更後のカード再送・カテゴリ選択カルーセル・各種案内テキスト）も `replyToken` を使い、失効時のみ push にフォールバックする（`replyToPostback`, `postback.ts`）。

ただし **push 専用の経路も残っている**点に注意:

- Gmail カード利用通知（`sendCardUsageNotification`, `flexMessage.ts`）… グループ宛の非同期プッシュのため reply トークンが無い

これは push 枠を消費する。Flex メッセージのアイコンは `line-kakeibo.vercel.app/icons` から PNG 配信（lucide 風）。

---

## 3. 自動取込機能

### 3.1 Gmail 連携（三井住友カード利用通知）

- Gmail API（`gmail.readonly` スコープのみ）＋ **Pub/Sub push 通知**（topic: `gmail-notifications`）
- フロー: 新着メール → `gmailPubSubHandler` → history API で差分取得 → SMBC 利用通知をフィルタ → `gmail/parser.ts` で「利用先・金額・利用日時」を抽出 → Gemini でカテゴリ分類 → **アトミック保存**（`gmailMessageId` および `date+amount+usedAt(±1分)` で重複排除、`firestore.ts:137`）→ LINE グループへ Flex 通知（§2.4 の登録・編集カード。現在の設定 3 行＋[変更] ボタン）
- 保存フィールド: `inputSource: 'gmail_auto'`, `usedAt`（カード利用日時）
- watch は7日で失効するため、**6日ごとの cron**（`renewGmailWatch`）で更新
- 管理エンドポイント（`api` function, `/gmail/*`）: OAuth 認可・watch 登録・状態確認・手動処理など。認証は `ADMIN_SECRET` を **`X-Admin-Secret` / `Authorization: Bearer` ヘッダーまたは `?adminSecret=` クエリパラメータ**で受け付け（`index.ts:1396` `requireAdminAuth`）＋レートリミット（OAuth callback のみ CSRF state 検証）。⚠️ クエリ渡しはアクセスログ等にシークレットが残るリスクあり

### 3.2 MoneyForward CSV インポート

- `importMoneyForward`（cron: 毎日 5:00 JST）
- Google Drive（ADC, `drive.readonly`）から最新の `MoneyForward*.csv` を取得 → 正規化 → `${API_BASE_URL}/api/mf/import` へ POST（`MFKAKEIBO_TOKEN` 認証）
- ⚠️ **送信先エンドポイントは本リポジトリの web に存在しない**: `web/app/api/` の Route は無効化済みで `/api/mf/import` の実装は見当たらない（§8 参照）。`API_BASE_URL` が別サービスを指していない限り、このバッチは現状機能しない可能性が高い

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
| `expenses` | `lineId`, `appUid?`, `groupId?`, `lineGroupId?`, `amount`, `description`, `date`(YYYY-MM-DD), `category`, `confirmed`, `includeInTotal`, `status`(`pending\|shared\|personal\|advance_pending\|advance_settled`), `inputSource`(`line_text\|gmail_auto`。`line_ocr` は OCR 廃止に伴う**レガシー値**で既存データにのみ存在), `payerId`, `payerDisplayName`, `paymentMethod`, `advanceBy?`, `advanceSettledAt?`, `gmailMessageId?`, `usedAt?`, `receiptUrl?`, `needsEdit?`, `items?[]`, `ocrText?`, `createdAt`, `updatedAt` | 中核コレクション |
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
