# LINE家計簿 自動化システム設計書 v2.2

> line-kakeibo / Gmail連携 追加機能版

## 1. プロジェクト概要

### 1.1 目的

**既存のLINE家計簿機能を維持しながら**、三井住友ゴールドVISA（NL）共用カード1枚の利用明細を自動集計する機能を追加し、2人の共同生活費（月13.6万円）を透明化・管理する。

### 1.2 現状の機能（維持）

以下の既存機能は**すべて維持**する：

| 機能 | 説明 | 実装ファイル |
|-----|------|-------------|
| レシートOCR | LINE画像送信 → Vision API → Gemini分類 → 自動登録 | `index.ts` |
| テキスト入力 | 「500 ランチ」形式でLINEから手動登録 | `textParser.ts` |
| カテゴリ設定 | 「カテゴリー 食費」でデフォルトカテゴリ変更 | `index.ts` |
| Gemini分類 | キーワード + AI による自動カテゴリ分類 | `geminiCategoryClassifier.ts` |
| グループ機能 | LINEグループでの共同家計簿 | `firestore.ts` |
| Webダッシュボード | 支出一覧・編集・統計表示 | `web/` |

### 1.3 追加機能（今回の実装）

- **Gmail自動取得**: 三井住友カード利用通知メールを自動検知・登録
- **3ボタン確認UI**: 共同費/個人費/立替をワンタップで選択
- **月次レポート**: 自動集計・プッシュ通知（将来実装）

### 1.4 運用方針

| 支払方法 | 入力方法 |
|---------|---------|
| 共用カード | Gmail自動取得（新機能） |
| 現金・PayPay | 既存のLINEテキスト入力 |
| レシート画像 | 既存のOCR機能 |

---

## 2. システムアーキテクチャ

### 2.1 全体フロー（Gmail自動取得の追加部分）

```
三井住友ゴールドVISA（NL）
カード利用
    ↓
Gmail
利用通知メール
    ↓
Gmail API + Pub/Sub
    ↓
Firebase Functions
gmailPubSubHandler
    ↓
既存のGemini分類
geminiCategoryClassifier.ts
    ↓
既存のFirestore保存
firestore.ts (saveExpense)
    ↓
LINE Bot
Flex Message通知（新規）
```

### 2.2 技術スタック（既存 + 追加）

| レイヤー | 技術 | 状態 |
|---------|------|------|
| フロントエンド | Next.js | 既存 |
| バックエンド | Firebase Functions (TypeScript) | 既存 |
| データベース | Cloud Firestore | 既存 |
| OCR | Google Cloud Vision API | 既存 |
| AI分類 | Gemini API | 既存 |
| 通知 | LINE Messaging API | 既存 |
| **メール連携** | **Gmail API + Pub/Sub** | **新規** |
| 秘密管理 | Firebase Secret Manager | 既存 |

---

## 3. 入力チャネル設計

### 3.1 チャネル一覧

| チャネル | トリガー | 処理方法 | 状態 |
|---------|---------|----------|------|
| レシートOCR | LINE画像送信 | Vision API → Gemini分類 | 既存 |
| テキスト入力 | LINEテキスト | textParser.ts → Gemini分類 | 既存 |
| **クレジットカード** | **Gmail Pub/Sub** | **メールパース → Gemini分類** | **新規** |

### 3.2 クレカ自動取得の詳細

- **監視対象メール**: 三井住友ゴールドVISA（NL）の利用通知のみ
- **フィルタ条件**:
  - Fromドメイン: `vpass.ne.jp` または `smbc-card.com`
  - 本文に「三井住友ゴールドＶＩＳＡ（ＮＬ）」を含む
- **他カードの通知メールは完全無視**
- **重複チェック**: gmailMessageId で一意性を保証
- **Gmail Watchの有効期限**: 7日 → 6日ごとに自動更新

### 3.3 既存のテキスト入力フォーマット（維持）

現在の `textParser.ts` が対応するフォーマット:

```
500 ランチ           → 金額500円、説明「ランチ」、当日
6/29 4800 家賃       → 金額4800円、説明「家賃」、6月29日
1200 交通費          → 金額1200円、説明「交通費」、当日
```

---

## 4. LINE インターフェース設計

### 4.1 既存コマンド（維持）

| コマンド | 動作 | 実装場所 |
|---------|------|---------|
| 「家計簿」 | 最近の支出3件 + Webリンク表示 | index.ts:719 |
| 「カテゴリー」 | 利用可能カテゴリ一覧表示 | index.ts:826 |
| 「カテゴリー 食費」 | デフォルトカテゴリを食費に設定 | index.ts:869 |
| 「グループ作成 名前」 | 新規グループ作成 | index.ts:944 |
| 「参加 コード 名前」 | グループに参加 | index.ts:981 |
| 「グループ一覧」 | 参加中グループ表示 | index.ts:1032 |

### 4.2 新規: カード利用通知（Flex Message）

カード利用検知時、LINEグループにFlexメッセージをプッシュ。

| 表示要素 | 内容 |
|---------|------|
| ヘッダー | 💳 カード利用を記録 |
| 店舗名 | 大きく表示（例: イオン） |
| 金額 | 赤字で大きく（例: ¥3,240） |
| カテゴリ | 絵文字 + カテゴリ名 + 日付 |
| 残り予算 | 緑（余裕）/ 赤（残り2万以下） |
| ボタン（3つ） | ✅ 共同費 / 👤 個人費 / ↩️ 立替 |

### 4.3 新規: ボタン押下後の動作

| ボタン | Firestoreのstatus | 返答メッセージ |
|-------|-------------------|---------------|
| ✅ 共同費 | shared | ✅ 共同費として記録しました |
| 👤 個人費 | personal | 👤 個人費として除外しました |
| ↩️ 立替 | advance_pending | ↩️ 立替として記録。月末精算に含めます |
| （無反応） | shared（自動） | 5分後に自動で共同費として確定 |

---

## 5. データ設計（Firestore）

### 5.1 既存: expenses コレクション（維持）

現在の `Expense` インターフェース (`firestore.ts:43-65`):

| フィールド | 型 | 説明 | 必須 |
|-----------|---|------|-----|
| lineId | string | LINE User ID | ✓ |
| appUid | string | Firebase Auth User ID | |
| groupId | string | グループID | |
| lineGroupId | string | LINE Group ID | |
| userDisplayName | string | ユーザー表示名 | |
| amount | number | 金額（円） | ✓ |
| description | string | 説明・店舗名 | ✓ |
| date | string | YYYY-MM-DD形式 | ✓ |
| category | string | カテゴリ名 | ✓ |
| confirmed | boolean | 確認済みフラグ | ✓ |
| payerId | string | 支払者LINE ID | ✓ |
| payerDisplayName | string | 支払者表示名 | |
| ocrText | string | OCR抽出テキスト | |
| items | array | 明細アイテム配列 | |
| createdAt | Timestamp | 登録日時 | 自動 |
| updatedAt | Timestamp | 更新日時 | 自動 |

### 5.2 追加フィールド（Gmail自動取得用）

| フィールド | 型 | 説明 |
|-----------|---|------|
| inputSource | string | 入力元: `line_text` / `line_ocr` / `gmail_auto` |
| gmailMessageId | string | GmailメッセージID（重複チェック用） |
| status | string | `pending` / `shared` / `personal` / `advance_pending` |
| advanceBy | string | 立替者（立替時のみ） |
| **includeInTotal** | **boolean** | **合計金額に含めるか** |

### 5.3 includeInTotalフィールドの初期値

入力元によって初期値が異なる:

| 入力元 | includeInTotal初期値 | 理由 |
|--------|---------------------|------|
| `gmail_auto` | `true` | Gmail自動取得は基本的に共同費として会計に含める |
| `line_text` | `false` | 確認ボタンを押すまで含めない |
| `line_ocr` | `false` | 確認ボタンを押すまで含めない |

- Gmail自動取得: 共用カードからの取得なので、初期状態で会計に含める
- LINE手入力: ユーザーが「共同費」「立替」ボタンを押すと `includeInTotal: true` に更新
- 「個人費」を選択すると `includeInTotal: false` に設定

### 5.4 新規: システムコレクション

#### system/gmailToken

| フィールド | 型 | 説明 |
|-----------|---|------|
| access_token | string | Gmail OAuth2アクセストークン |
| refresh_token | string | リフレッシュトークン |
| expiry_date | number | トークン有効期限（Unix timestamp） |

#### system/gmailState

| フィールド | 型 | 説明 |
|-----------|---|------|
| historyId | string | 最後に処理したGmail historyId |
| watchExpiration | number | Watch有効期限（Unix timestamp） |

#### system/budget

| フィールド | 型 | 説明 |
|-----------|---|------|
| monthly | number | 月次予算（デフォルト: 136000） |
| alertThreshold | number | アラート閾値（デフォルト: 20000残り） |

---

## 6. カテゴリ定義（既存）

現在の `geminiCategoryClassifier.ts` で定義されているカテゴリ:

| ID | 絵文字 | カテゴリ名 | キーワード例 |
|----|-------|----------|-------------|
| food | 🍱 | 食費 | 食、ランチ、ディナー、弁当、レストラン |
| transport | 🚃 | 交通費 | 電車、バス、タクシー、ガソリン |
| daily | 🧻 | 日用品 | ティッシュ、洗剤、シャンプー |
| entertainment | 🎮 | 娯楽 | ゲーム、映画、カラオケ、本 |
| clothing | 👕 | 衣服 | 服、靴、ユニクロ |
| health | 💊 | 医療・健康 | 病院、薬、サプリ、ジム |
| education | 📚 | 教育 | 本、参考書、講座 |
| utility | 💡 | 光熱費 | 電気、ガス、水道 |
| housing | 🏠 | 住居費 | 家賃、管理費、家具 |
| insurance | 🛡️ | 保険 | 生命保険、医療保険 |
| tax | 📋 | 税金 | 所得税、住民税 |
| beauty | 💄 | 美容 | 化粧品、美容院 |
| communication | 📱 | 通信費 | スマホ、インターネット |
| subscription | 📺 | サブスク | Netflix、Spotify |
| gift | 🎁 | プレゼント | ギフト、お祝い |
| travel | ✈️ | 旅行 | ホテル、航空券 |
| pet | 🐕 | ペット | ペットフード |
| savings | 💰 | 貯金 | 貯金、投資 |
| other | 📝 | その他 | - |

---

## 7. ファイル構成

### 7.1 既存ファイル（変更なし）

```
bot/src/
├── index.ts                      # エントリーポイント（Webhook処理）
├── firestore.ts                  # Firestore CRUD
├── textParser.ts                 # テキスト入力パース
├── parser.ts                     # レシートOCRパース
├── enhancedParser.ts             # 高度なOCRパース
├── geminiCategoryClassifier.ts   # Gemini分類
├── categoryNormalization.ts      # カテゴリ正規化
├── imageOptimizer.ts             # 画像最適化
├── costMonitor.ts                # コスト監視
├── userLinks.ts                  # ユーザーリンク
├── linkUserResolver.ts           # ユーザー解決
├── syncUserLinks.ts              # ユーザー同期
└── importMoneyForward.ts         # MF連携
```

### 7.2 新規追加ファイル

```
bot/src/
├── gmail/
│   ├── index.ts              # エクスポート
│   ├── types.ts              # 型定義（作成済み）
│   ├── auth.ts               # Gmail OAuth2認証
│   ├── watch.ts              # Gmail Watch管理
│   ├── parser.ts             # メールパース
│   └── handler.ts            # Pub/Subハンドラー
└── line/
    ├── flexMessage.ts        # Flex Message生成
    └── postback.ts           # Postback処理
```

---

## 8. 環境変数

### 8.1 既存（維持）

| 変数名 | 説明 |
|-------|------|
| LINE_CHANNEL_TOKEN | LINE Botアクセストークン |
| LINE_CHANNEL_SECRET | LINEチャンネルシークレット |
| GEMINI_API_KEY | Gemini APIキー |
| FIREBASE_PROJECT_ID | Firebase プロジェクトID |

### 8.2 新規追加

| 変数名 | 説明 |
|-------|------|
| GMAIL_CLIENT_ID | OAuth2クライアントID |
| GMAIL_CLIENT_SECRET | OAuth2クライアントシークレット |
| GMAIL_REDIRECT_URI | OAuth2リダイレクトURI |
| LINE_GROUP_ID | 通知先LINEグループID |

---

## 9. 実装ロードマップ

### Step 1: Gmail自動取得（feature/gmail-auto）

| タスク | 内容 |
|-------|------|
| 1-1 | Gmail OAuth2認証実装 |
| 1-2 | Gmail Watch登録・更新 |
| 1-3 | メールパース（三井住友ゴールドVISA NL） |
| 1-4 | Pub/Subハンドラー |
| 1-5 | 既存のGemini分類を使用 |
| 1-6 | 既存のFirestore保存を使用 |
| 1-7 | LINE Flex Message通知 |
| 1-8 | Postbackボタン処理 |

### Step 1 完了条件

| 条件 | ステータス | 備考 |
|-----|---------|------|
| 三井住友ゴールドVISA（NL）の利用通知メールを自動検知 | ✅ 実装済み | `gmail/parser.ts` で実装 |
| 既存のGemini分類でカテゴリを正しく分類 | ✅ 実装済み | `handler.ts` で既存の `classifyExpenseWithGemini` を使用 |
| LINEグループに3ボタン付きFlexメッセージが届く | ✅ 実装済み | `line/flexMessage.ts` で実装 |
| ボタン押下でFirestoreのstatusが更新される | ✅ 実装済み | `line/postback.ts` で実装 |
| 重複登録が発生しない | ✅ 実装済み | `gmailMessageId` で重複チェック |
| **既存のLINE入力機能が正常に動作する** | ✅ 影響なし | 追加実装のみ、既存コード変更なし |

### Step 1 セットアップ要件

以下の設定が動作確認前に必要:

| 設定項目 | ステータス | 設定方法 |
|---------|---------|---------|
| GMAIL_CLIENT_ID | ✅ 設定済み | Firebase Secret Manager |
| GMAIL_CLIENT_SECRET | ✅ 設定済み | Firebase Secret Manager |
| ADMIN_SECRET | ✅ 設定済み | Firebase Secret Manager |
| GEMINI_API_KEY | ✅ 設定済み | Firebase Secret Manager（カテゴリ分類用） |
| LINE_CHANNEL_TOKEN | ✅ 設定済み | Firebase Secret Manager（LINE通知用） |
| LINE_CHANNEL_SECRET | ✅ 設定済み | Firebase Secret Manager |
| GMAIL_REDIRECT_URI | ✅ 設定済み | `bot/.env.local` ファイル |
| LINE_GROUP_ID | ✅ 設定済み | `bot/.env.local` ファイル（通知先グループ） |
| DEFAULT_GROUP_ID | ✅ 設定済み | `bot/.env.local` ファイル（Firestore用） |
| Google Cloud Pub/Sub Topic | ✅ 設定済み | `gmail-notifications` トピック |
| Gmail OAuth2認証 | ✅ 完了 | `/api/gmail/auth` エンドポイントで実行済み |
| Gmail Watch登録 | ✅ 完了 | `/api/gmail/register-watch` エンドポイントで実行済み |

### セットアップ手順

1. **Google Cloud Console で OAuth2 クライアント作成**
   - APIs & Services > Credentials > Create Credentials > OAuth 2.0 Client ID
   - Application type: Web application
   - Authorized redirect URIs: `https://us-central1-<your-project>.cloudfunctions.net/api/gmail/callback`
   - 例: `https://us-central1-line-kakeibo-0410.cloudfunctions.net/api/gmail/callback`

2. **Firebase Secret Manager に設定**
   ```bash
   # 対話形式で設定
   firebase functions:secrets:set GMAIL_CLIENT_ID
   firebase functions:secrets:set GMAIL_CLIENT_SECRET

   # ADMIN_SECRET は改行なしで設定（重要）
   echo -n 'your-admin-secret' | firebase functions:secrets:set ADMIN_SECRET --data-file=-
   ```

3. **Pub/Sub トピック作成**
   ```bash
   gcloud pubsub topics create gmail-notifications
   ```

4. **環境変数設定（bot/.env ファイル）**

   Firebase Functions v2 では `.env` ファイルを使用します:
   ```bash
   # bot/.env に追加
   GMAIL_REDIRECT_URI=https://us-central1-<your-project>.cloudfunctions.net/api/gmail/callback
   LINE_GROUP_ID=C...  # 通知先LINEグループID
   DEFAULT_GROUP_ID=...  # FirestoreグループドキュメントID
   ```

5. **デプロイして OAuth2 認証実行**
   ```bash
   firebase deploy --only functions

   # ブラウザで認証URLを取得（ADMIN_SECRET が必要）
   curl "https://us-central1-<your-project>.cloudfunctions.net/api/gmail/auth?adminSecret=YOUR_ADMIN_SECRET"

   # 返却されたauthUrlをブラウザで開いてGoogleアカウントで認証
   ```

6. **Gmail Watch 登録**
   ```bash
   curl -X POST "https://us-central1-<your-project>.cloudfunctions.net/api/gmail/register-watch?adminSecret=YOUR_ADMIN_SECRET"
   ```

### 将来ステップ（オプション）

| Step | 機能 |
|------|-----|
| 2 | 立替機能（精算計算） |
| 3 | 月次レポート自動生成 |
| 4 | ダッシュボード強化 |

---

## 10. Gmail API エンドポイント

Gmail管理用のAPIエンドポイント一覧:

| メソッド | パス | 説明 | 認証 |
|---------|-----|------|------|
| GET | `/api/gmail/auth` | OAuth2認証URLを取得 | Admin |
| GET | `/api/gmail/callback` | OAuth2コールバック（Googleからのリダイレクト先） | **不要** |
| POST | `/api/gmail/register-watch` | Gmail Watch登録 | Admin |
| GET | `/api/gmail/status` | Gmail連携ステータス確認 | Admin |
| POST | `/api/gmail/process-latest` | 最新のSMBCカードメールを手動処理 | Admin |
| POST | `/api/gmail/test-process` | SMBCカードメール内容をプレビュー | Admin |
| POST | `/api/gmail/force-process/:messageId` | 指定メッセージIDを強制処理（冪等） | Admin |
| POST | `/api/gmail/refresh-token` | トークン強制リフレッシュ | Admin |
| DELETE | `/api/gmail/revoke` | トークン削除・再認証用 | Admin |

> **注意**: `/api/gmail/callback` はGoogleからのOAuth2リダイレクト先のため、Admin認証は不要です。

### 認証方法

Admin認証が必要なエンドポイントは以下のいずれかで認証:

```bash
# Authorization ヘッダー
curl -H "Authorization: Bearer YOUR_ADMIN_SECRET" https://...

# クエリパラメータ
curl "https://...?adminSecret=YOUR_ADMIN_SECRET"
```

### 使用例

```bash
# ステータス確認
curl -H "Authorization: Bearer $ADMIN_SECRET" \
  "https://us-central1-line-kakeibo-0410.cloudfunctions.net/api/gmail/status"

# 最新メールを処理
curl -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  "https://us-central1-line-kakeibo-0410.cloudfunctions.net/api/gmail/process-latest"

# トークン削除（再認証が必要になる）
curl -X DELETE -H "Authorization: Bearer $ADMIN_SECRET" \
  "https://us-central1-line-kakeibo-0410.cloudfunctions.net/api/gmail/revoke"
```

---

## 11. 注意事項

### 11.1 既存機能への影響

- **既存のLINE入力機能には一切変更を加えない**
- Gmail自動取得は**追加機能**として実装
- 既存の `saveExpense` 関数を再利用
- 既存の Gemini 分類を再利用

### 11.2 Gmail Watch制約

- Gmail Watchは7日間の有効期限あり
- 6日ごとにCloud Schedulerで自動更新
- トークンリフレッシュは自動化

### 11.3 セキュリティ

- OAuth2トークンはFirestore + Secret Managerで管理
- 共用カード以外のメールは本文フィルタで完全排除
- 個人支出は👤ボタンで対応
