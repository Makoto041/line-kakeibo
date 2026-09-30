# LINE家計簿 Gmail 連携（カード利用通知の自動取込）仕様書

> line-kakeibo / 三井住友カード利用通知メールの自動登録。実装は `bot/src/gmail/`・`bot/src/line/`・`bot/src/gmail/adminRouter.ts`（`api` 関数の `/gmail/*`）。
> 全体の機能仕様は [SPECIFICATION.md](./SPECIFICATION.md)、構成は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

## 1. 概要

### 1.1 目的

**既存の LINE 家計簿機能を維持しながら**、三井住友ゴールドVISA（NL）共用カード 1 枚の利用明細を自動集計し、2 人の共同生活費を透明化・管理する。

### 1.2 併存する既存機能

| 機能 | 説明 | 実装ファイル |
|-----|------|-------------|
| テキスト入力 | 「500 ランチ」形式で LINE から手動登録 | `textParser.ts` / `line/expenseFlow.ts` |
| カテゴリ設定 | 「カテゴリー 食費」でデフォルトカテゴリ変更 | `line/commands/category.ts` |
| Gemini 分類 | キーワード + AI による自動カテゴリ分類 | `geminiCategoryClassifier.ts` |
| グループ機能 | LINE グループに紐づく世帯（2 名固定）での共同家計簿 | `firestore.ts` / `expenseGroupScope.ts` |
| 固定費 | 毎月の固定費を引き落とし日に自動計上 | `recurringExpenses.ts` |
| Web ダッシュボード | 支出一覧・編集・精算・統計表示 | `web/` |

### 1.3 Gmail 連携で追加した機能

- **Gmail 自動取得**: 三井住友カード利用通知メールを自動検知・登録
- **現在値＋[変更] の確認 UI**: 支出区分/立替/カテゴリの現在値をリッチテキストで表示し、変更は [変更] ボタンで行う（テキスト入力の登録カードと共通）

### 1.4 運用方針

| 支払方法 | 入力方法 |
|---------|---------|
| 共用カード | Gmail 自動取得 |
| 現金・PayPay | LINE テキスト入力 |
| 家賃・光熱費などの引き落とし | Web の固定費（`SPECIFICATION.md` §3.3）。カード払いのものを固定費にも登録すると二重になる |

レシート画像の OCR は廃止済み。画像は Web の `/attach` から支出に添付するだけ。

---

## 2. システムアーキテクチャ

### 2.1 全体フロー

```
三井住友ゴールドVISA（NL）
カード利用
    ↓
Gmail
利用通知メール
    ↓
Gmail API watch → Pub/Sub（gmail-notifications）
    ↓
Firebase Functions
gmailPubSubHandler（asia-northeast1）
    ↓ history API で差分取得 → SMBC フィルタ → パース
既存の Gemini 分類
geminiCategoryClassifier.ts
    ↓
Firestore 保存（トランザクション・重複排除）
firestore.ts (saveGmailExpenseAtomic)
    ↓
LINE Bot
Flex Message 通知（line/flexMessage.ts）
```

### 2.2 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js（Vercel） |
| バックエンド | Firebase Functions gen2 / Node.js 22（TypeScript） |
| データベース | Cloud Firestore |
| AI 分類 | Gemini API |
| 通知 | LINE Messaging API |
| メール連携 | Gmail API + Pub/Sub |
| 秘密管理 | Firebase Secret Manager（`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `ADMIN_SECRET` など） |

---

## 3. 入力チャネル設計

### 3.1 チャネル一覧

| チャネル | トリガー | 処理方法 |
|---------|---------|----------|
| テキスト入力 | LINE テキスト | textParser.ts → Gemini 分類 |
| クレジットカード | Gmail Pub/Sub | メールパース → Gemini 分類 |
| 固定費 | 日次スケジュール | recurringExpenses.ts（分類なし。登録時のカテゴリ） |

### 3.2 クレカ自動取得の詳細

- **監視対象メール**: 三井住友ゴールドVISA（NL）の利用通知のみ
- **フィルタ条件**（`gmail/parser.ts` の `isSMBCGoldVISANL`、`gmail/types.ts` の `SMBC_CARD_FILTER`）:
  - From のアドレス部（表示名は見ない）のドメインが `vpass.ne.jp` または `smbc-card.com`（サブドメイン可。`evilvpass.ne.jp` のような文字列一致は不可）
  - 本文に「三井住友ゴールドＶＩＳＡ（ＮＬ）」（半角・括弧半角の表記ゆれも可）を含む
- **他カードの通知メールは無視**
- **重複チェック**: `gmailMessageId` に加え、`date + amount` が同じ `gmail_auto` 支出のうち店舗名が類似（一致または包含）し `usedAt` が ±1 分のものも弾く（`saveGmailExpenseAtomic`。Firestore トランザクション内で判定）
- **失敗時の扱い**: 1 通でも処理に失敗したら `historyId` を進めず Pub/Sub の再送に委ねる。同じメッセージが 3 回失敗したら諦めて先へ進む（`system/gmailFailures` に試行回数を記録）
- **Gmail Watch の有効期限**: 7 日 → `renewGmailWatch`（6 日ごと 3:00 JST）で自動更新

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
| 「家計簿」 | 当月サマリーの Flex メッセージ | line/commands/kakeibo.ts |
| 「カテゴリー」 | 利用可能カテゴリ一覧表示 | line/commands/category.ts |
| 「カテゴリー 食費」 | デフォルトカテゴリを食費に設定 | line/commands/category.ts |
| 「グループ作成 名前」 | 新規グループ作成 | line/commands/group.ts |
| 「グループ一覧」 | 参加中グループ表示 | line/commands/group.ts |
| 「立替一覧」/「精算」 | 未精算の立替の確認・精算 | line/commands/advance.ts |

（「参加 コード 名前」コマンドは無効化済み。世帯は 2 名固定で、メンバー追加は `scripts/manage-group-members.mjs` で行う）

### 4.2 カード利用通知（Flex Message）

カード利用検知時、LINE グループ（`LINE_GROUP_ID`）に Flex メッセージをプッシュする。

テキスト入力の登録カードと同じビルダーを使う（`buildExpenseCard`）。ヘッダー文言と残り予算行だけがカード利用固有。

| 表示要素 | 内容 |
|---------|------|
| ヘッダー | カード利用を記録 |
| 店舗名 | 大きく表示（例: イオン） |
| 金額 / 日付 | 金額を大きく、日付は同じ行の右端 |
| 残り予算 | 緑（余裕）/ 赤（残り 2 万以下） |
| 現在の設定 | `支出区分：…` `立替：…` `カテゴリ：…` の 3 行。各行の右端に [変更] |
| フッター | `OK` `修正` / `レシート添付` / `家計簿一覧を見る` |

現在値は `status` から導出する。導出ルールと遷移ルールは `docs/SPECIFICATION.md` §2.4 / §2.5 を参照。

### 4.3 ボタン押下後の動作

状態を変えたら、最新の現在値を反映したカードを `replyToken` で返信する（LINE は送信済みメッセージを編集できないため）。

| 操作 | Firestore の status | 備考 |
|-------|-------------------|---------------|
| 支出区分 [変更] | shared ⇔ personal | `includeInTotal` を連動。立替は解除 |
| 立替 [変更] | advance_pending ⇔ shared | 立替ありは押下者を `advanceBy` に記録。精算に含める |
| カテゴリ [変更] | （status 不変） | 選択カルーセルを表示して確定 |
| OK | pending のみ shared へ昇格 | 設定済みの支出は `confirmed` だけ立てる |
| （無反応） | pending のまま | 自動確定は行わない。`includeInTotal: true` なので集計には入る |

---

## 5. データ設計（Firestore）

### 5.1 expenses コレクション

`Expense` インターフェース（`firestore.ts`）の主なフィールド:

| フィールド | 型 | 説明 | 必須 |
|-----------|---|------|-----|
| lineId | string | LINE User ID（Gmail 取込はシステムユーザー `gmail-auto-system`） | ✓ |
| appUid | string | Firebase Auth User ID | |
| groupId | string | グループ ID | |
| lineGroupId | string | LINE Group ID | |
| userDisplayName | string | ユーザー表示名 | |
| amount | number | 金額（円） | ✓ |
| description | string | 説明・店舗名 | ✓ |
| date | string | YYYY-MM-DD 形式（JST） | ✓ |
| category | string | カテゴリ名 | ✓ |
| confirmed | boolean | 確認済みフラグ | ✓ |
| payerId | string | 支払者 LINE ID | ✓ |
| payerDisplayName | string | 支払者表示名 | |
| items / ocrText | array / string | OCR 廃止に伴うレガシー（既存データのみ） | |
| createdAt | Timestamp | 登録日時 | 自動 |
| updatedAt | Timestamp | 更新日時 | 自動 |

### 5.2 Gmail 自動取得で使うフィールド

| フィールド | 型 | 説明 |
|-----------|---|------|
| inputSource | string | 入力元: `line_text` / `gmail_auto` / `recurring`（`line_ocr` は既存データのみのレガシー値） |
| gmailMessageId | string | Gmail メッセージ ID（重複チェック用） |
| usedAt | Timestamp | カード利用日時（重複チェック・表示用） |
| status | string | `pending` / `shared` / `personal` / `advance_pending` / `advance_settled` |
| advanceBy | string | 立替者（立替時のみ） |
| includeInTotal | boolean | 合計金額に含めるか |

### 5.3 includeInTotal の初期値

入力元によって初期値が異なる:

| 入力元 | includeInTotal 初期値 | 理由 |
|--------|---------------------|------|
| `gmail_auto` | `true` | 共用カードからの取得なので、初期状態で会計に含める |
| `line_text` | `false` | 確認ボタン（OK / 共同費 / 立替）を押すまで含めない |
| `recurring` | `true` | 固定費は登録時点で確定扱い（`confirmed: true`） |

- LINE 手入力: OK または「支出区分：共同費」「立替：あり」で `includeInTotal: true` に更新
- 「個人費」を選択すると `includeInTotal: false` に設定

### 5.4 システムコレクション（`system/*`。Bot 専用、クライアントからは読み書き不可）

#### system/gmailToken

| フィールド | 型 | 説明 |
|-----------|---|------|
| access_token | string | Gmail OAuth2 アクセストークン |
| refresh_token | string | リフレッシュトークン |
| expiry_date | number | トークン有効期限（Unix timestamp） |

#### system/gmailState

| フィールド | 型 | 説明 |
|-----------|---|------|
| historyId | string | 最後に処理した Gmail historyId（前進のみ。古い通知の後着で巻き戻さない） |
| watchExpiration | number | Watch 有効期限（Unix timestamp） |

#### system/oauthState

OAuth 認可の CSRF 用 state。`/gmail/auth` で発行し、`/gmail/callback` で照合後に削除する。

#### system/gmailFailures

処理に失敗したメッセージの記録（`{ [messageId]: { attempts, lastError, lastFailedAt } }`）。3 回失敗したメッセージは諦めて `historyId` を進める。成功したら記録を消す。

予算は `budgetSettings/{lineId or lineGroupId}` に持つ（`SPECIFICATION.md` §6）。

---

## 6. カテゴリ定義

正準カテゴリは `categoryNormalization.ts` の 19 種で、Gmail 取込も同じ分類器（`classifyExpenseWithGemini`）を使う。ただし店名は部分一致のキーワード辞書で取り違えやすいため、`source: 'merchant'` を渡して **Gemini を先に使い**、Gemini が使えないときだけ辞書で判定する（SPECIFICATION.md §4）:

食費 / 交通費 / 日用品 / 娯楽 / 衣服 / 医療・健康 / 教育 / 光熱費 / 住居費 / 保険 / 税金 / 美容 / 通信費 / サブスク / プレゼント / 旅行 / ペット / 貯金 / その他

カード表示のカテゴリアイコンは `web/public/icons/cat-*.png`（`categoryIconUrl()`）。絵文字は使わない（`gmail/types.ts` の `getCategoryEmoji` は互換のため残しているが空文字を返す）。

---

## 7. ファイル構成

### 7.1 Gmail 連携モジュール

```
bot/src/
├── gmail/
│   ├── index.ts              # エクスポート
│   ├── types.ts              # 型定義・SMBC_CARD_FILTER
│   ├── auth.ts               # Gmail OAuth2 認証（トークンは system/gmailToken、CSRF state は system/oauthState）
│   ├── watch.ts              # Gmail Watch 管理（system/gmailState）
│   ├── parser.ts             # メールパース（送信元判定・利用先/金額/利用日時の抽出・重複判定）
│   ├── handler.ts            # Pub/Sub ハンドラー・手動処理（process-latest / force-process）
│   └── adminRouter.ts        # /gmail/* 管理 API（Admin 認証・レート制限）
└── line/
    ├── client.ts             # LINE クライアント・返信ヘルパー
    ├── flexMessage.ts        # Flex Message 生成（テキスト入力と共通の登録・編集カード）
    └── postback.ts           # Postback 処理
```

### 7.2 関連する既存ファイル

```
bot/src/
├── index.ts                      # Function エクスポート（gmailPubSubHandler / renewGmailWatch / api）
├── firestore.ts                  # saveGmailExpenseAtomic（重複排除つき保存）
├── expenseActions.ts             # postback / Web の確認で共用する状態遷移
├── geminiCategoryClassifier.ts   # Gemini 分類
├── categoryNormalization.ts      # カテゴリ正規化
└── adminAuth.ts                  # ADMIN_SECRET の定数時間比較
```

---

## 8. 環境変数

### 8.1 既存

| 変数名 | 説明 |
|-------|------|
| LINE_CHANNEL_TOKEN | LINE Bot アクセストークン |
| LINE_CHANNEL_SECRET | LINE チャンネルシークレット |
| GEMINI_API_KEY | Gemini API キー |
| FIREBASE_PROJECT_ID | Firebase プロジェクト ID |

### 8.2 Gmail 連携で追加

| 変数名 | 説明 | 置き場所 |
|-------|------|------|
| GMAIL_CLIENT_ID | OAuth2 クライアント ID | Secret Manager |
| GMAIL_CLIENT_SECRET | OAuth2 クライアントシークレット | Secret Manager |
| ADMIN_SECRET | `/gmail/*` 管理 API の認証 | Secret Manager |
| GMAIL_REDIRECT_URI | OAuth2 リダイレクト URI | `bot/.env` |
| LINE_GROUP_ID | 通知先 LINE グループ ID | `bot/.env` |
| DEFAULT_GROUP_ID | 取込んだ支出に付ける Firestore の `groupId` | `bot/.env` |

---

## 9. セットアップ手順

前提: Google Cloud Pub/Sub トピック `gmail-notifications`、Gmail API の有効化、Cloud Scheduler（`renewGmailWatch` は `firebase deploy` が作成）。`api` 関数は **us-central1** にあるため、コールバック URL も us-central1 になる。

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

   Firebase Functions gen2 では `.env` ファイルを使用します:
   ```bash
   # bot/.env に追加
   GMAIL_REDIRECT_URI=https://us-central1-<your-project>.cloudfunctions.net/api/gmail/callback
   LINE_GROUP_ID=C...  # 通知先LINEグループID
   DEFAULT_GROUP_ID=...  # FirestoreグループドキュメントID
   ```

5. **デプロイして OAuth2 認証実行**（通常は `master` へのマージで CI の `deploy-bot` がデプロイする）
   ```bash
   firebase deploy --only functions

   # 認証URLを取得（ADMIN_SECRET は Authorization ヘッダーで渡す。クエリ渡しは廃止）
   curl -H "Authorization: Bearer $ADMIN_SECRET" \
     "https://us-central1-<your-project>.cloudfunctions.net/api/gmail/auth"

   # 返却されたauthUrlをブラウザで開いてGoogleアカウントで認証
   ```

6. **Gmail Watch 登録**
   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
     "https://us-central1-<your-project>.cloudfunctions.net/api/gmail/register-watch"
   ```

---

## 10. Gmail API エンドポイント

`api` 関数（us-central1）の `/gmail` ルーター:

| メソッド | パス | 説明 | 認証 |
|---------|-----|------|------|
| GET | `/api/gmail/auth` | OAuth2 認証 URL を取得 | Admin |
| GET | `/api/gmail/callback` | OAuth2 コールバック（Google からのリダイレクト先。CSRF state を照合） | **不要** |
| POST | `/api/gmail/register-watch` | Gmail Watch 登録 | Admin |
| GET | `/api/gmail/status` | Gmail 連携ステータス確認 | Admin |
| POST | `/api/gmail/process-latest` | 最新の SMBC カードメールを手動処理 | Admin |
| POST | `/api/gmail/test-process` | SMBC カードメール内容をプレビュー | Admin |
| POST | `/api/gmail/force-process/:messageId` | 指定メッセージ ID を強制処理（冪等） | Admin |
| POST | `/api/gmail/refresh-token` | トークン強制リフレッシュ | Admin |
| DELETE | `/api/gmail/revoke` | トークン削除・再認証用 | Admin |

> **注意**: `/api/gmail/callback` は Google からの OAuth2 リダイレクト先のため、Admin 認証は不要です。

### 認証方法

Admin 認証が必要なエンドポイントは `Authorization: Bearer` ヘッダーでのみ認証する:

```bash
curl -H "Authorization: Bearer $ADMIN_SECRET" https://...
```

> クエリパラメータ（`?adminSecret=`）での認証は廃止した。URL はアクセスログやブラウザ履歴に残り、秘密値の漏洩経路になるため。比較は定数時間（SHA-256 ダイジェスト同士の `timingSafeEqual`。`adminAuth.ts`）で行う。管理エンドポイントにはレートリミットも掛かる。

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

- Gmail 自動取得は**追加機能**として実装し、LINE テキスト入力の経路は変えない
- 保存は `saveGmailExpenseAtomic`（重複排除つき）、分類は既存の Gemini 分類器を再利用
- 確認カードとボタン後の状態遷移はテキスト入力と共通（`expenseActions.ts`）

### 11.2 Gmail Watch 制約

- Gmail Watch は 7 日間の有効期限あり
- 6 日ごとに Cloud Scheduler（`renewGmailWatch`）で自動更新
- トークンリフレッシュは自動化（`getValidAccessToken`）
- historyId は Gmail 側で約 1 週間しか保持されない。古すぎて `history.list` が 404 を返した場合、ハンドラーは通知の historyId まで進める（その間のメールは取り込まれない。必要なら `/api/gmail/force-process/:messageId` で個別に処理する）

### 11.3 セキュリティ

- OAuth2 のクライアント ID / シークレットは Secret Manager、発行されたトークンは Firestore `system/gmailToken`（クライアントからは読めない）
- 共用カード以外のメールは送信元アドレスと本文キーワードで排除（表示名の偽装は判定に使わない）
- 個人支出は「支出区分」の [変更] で `personal` に切り替える（`includeInTotal: false`）
- Gmail スコープは `gmail.readonly` のみ
