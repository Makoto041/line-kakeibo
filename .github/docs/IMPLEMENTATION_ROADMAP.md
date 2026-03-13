# 実装ロードマップ - Gmail連携自動化

> 各Stepの詳細実装計画

## 現在のプロジェクト状態

- **既存機能**: LINE Bot（レシートOCR、テキスト入力、グループ機能）
- **既存ディレクトリ**: `bot/src/`（設計書の`functions/src/`は`bot/src/`に読み替え）
- **データベース**: Firestore（expenses, groups, userLinks等）

---

## Step 1: Gmail自動取得 (`feature/gmail-auto`)

### 1.1 事前準備

#### Google Cloud Console設定

```
1. Google Cloud Consoleでプロジェクトを選択
2. API & Services → Credentials → OAuth 2.0 Client IDs を作成
   - Application type: Web application
   - Authorized redirect URIs: https://line-kakeibo-0410.cloudfunctions.net/gmailOAuthCallback
3. Gmail API を有効化
4. Pub/Sub API を有効化
5. Pub/Subトピック "gmail-notifications" を作成
6. Gmail Pub/Subに必要な権限を付与:
   - gmail-api-push@system.gserviceaccount.com に pubsub.publisher ロールを付与
```

#### 環境変数設定

```bash
# Firebase Secretsに追加
firebase functions:secrets:set GMAIL_CLIENT_ID
firebase functions:secrets:set GMAIL_CLIENT_SECRET
firebase functions:secrets:set GMAIL_REDIRECT_URI
```

### 1.2 ファイル作成順序

```
1. bot/src/gmail/types.ts        # 型定義
2. bot/src/gmail/auth.ts         # OAuth2認証
3. bot/src/gmail/parser.ts       # メールパース
4. bot/src/gmail/watch.ts        # Gmail Watch管理
5. bot/src/gmail/handler.ts      # Pub/Subハンドラー
6. bot/src/gmail/index.ts        # エクスポート
7. bot/src/line/flexMessage.ts   # Flex Message生成
8. bot/src/line/postback.ts      # ボタン押下処理
```

### 1.3 実装タスク詳細

#### Task 1.3.1: Gmail OAuth2認証 (`gmail/auth.ts`)

```typescript
// 実装要件
- getAuthUrl(): OAuth2認証URLを生成
- handleCallback(code): 認証コードからトークンを取得
- refreshAccessToken(): アクセストークンのリフレッシュ
- getValidAccessToken(): 有効なトークンを取得（自動リフレッシュ）
- saveTokenToFirestore(): トークンをFirestoreに保存
- loadTokenFromFirestore(): トークンをFirestoreから読み込み
```

#### Task 1.3.2: Gmail Watch管理 (`gmail/watch.ts`)

```typescript
// 実装要件
- registerWatch(): Gmail Watchを登録
- renewWatch(): 6日ごとのWatch更新（Cloud Scheduler）
- stopWatch(): Watch解除
- getWatchExpiration(): 有効期限確認
```

#### Task 1.3.3: メールパース (`gmail/parser.ts`)

```typescript
// 実装要件
- parseSMBCCardEmail(rawEmail): 三井住友カード通知メールをパース
  - 店舗名抽出
  - 金額抽出
  - 利用日時抽出
- isSMBCGoldVISANL(email): 対象カードのメールか判定
  - Fromドメインチェック (vpass.ne.jp, smbc-card.com)
  - 本文に「三井住友ゴールドＶＩＳＡ（ＮＬ）」が含まれるか
- isDuplicateExpense(expense): 重複チェック
```

#### Task 1.3.4: Pub/Subハンドラー (`gmail/handler.ts`)

```typescript
// 実装要件
- Cloud Functions: gmailPubSubHandler
  - Pub/Subメッセージを受信
  - Gmail APIでメール取得
  - パース → Gemini分類 → Firestore保存
  - LINE通知送信
```

#### Task 1.3.5: LINE Flex Message (`line/flexMessage.ts`)

```typescript
// 実装要件
- buildCardUsageFlexMessage(expense, remainingBudget): Flex Message生成
  - 店舗名、金額、カテゴリ、残り予算を表示
  - 3つのpostbackボタン（共同費/個人費/立替）
```

#### Task 1.3.6: Postback処理 (`line/postback.ts`)

```typescript
// 実装要件
- handlePostback(event): postbackイベント処理
  - expenseIdとactionを抽出
  - Firestoreのstatusを更新
  - 確認メッセージを返信
```

### 1.4 テスト項目

| テスト項目 | 確認内容 |
|-----------|---------|
| OAuth2認証フロー | ブラウザで認証 → トークン取得 → Firestore保存 |
| Gmail Watch登録 | historyIdが正しく記録される |
| メールパース | 店舗名・金額・日時が正しく抽出される |
| カードフィルタ | 三井住友ゴールドVISA（NL）以外は無視される |
| 重複チェック | 同じメールを2回処理しても1件のみ登録 |
| LINE通知 | Flex Messageが正しく表示される |
| ボタン動作 | ステータスが正しく更新される |
| Watch更新 | 6日後に自動更新される |

---

## Step 2: 手入力対応強化 (`feature/manual-input`)

### 2.1 実装タスク

```
1. bot/src/textParser.ts を拡張
   - 現金/PayPay支出の識別
   - 支払い方法の推定
2. 返答メッセージにボタンを追加
   - [OK] [修正] [立替]
```

### 2.2 対応フォーマット

```
# 基本フォーマット
1500 ドラッグストア
800 コンビニ 日用品

# 支払い方法指定
1500 現金 ドラッグストア
2000 paypay ランチ

# カテゴリ指定
3000 スーパー 食費
```

---

## Step 3: 立替機能 (`feature/advance`)

### 3.1 実装タスク

```
1. Firestoreスキーマ拡張
   - advanceBy: 立替者
   - advanceSettledAt: 精算日時
2. 「立替一覧」コマンド実装
3. 月末精算計算ロジック
4. 精算通知
```

### 3.2 精算計算ロジック

```typescript
// 月の立替合計
const makotoAdvance = expenses.filter(e => e.advanceBy === 'Makoto' && e.status === 'advance_pending')
const gfAdvance = expenses.filter(e => e.advanceBy === 'GF' && e.status === 'advance_pending')

// 精算額
const makotoTotal = sum(makotoAdvance.map(e => e.amount))
const gfTotal = sum(gfAdvance.map(e => e.amount))
const settlement = makotoTotal - gfTotal

// 精算メッセージ
if (settlement > 0) {
  // GF → Makoto に settlement円
} else {
  // Makoto → GF に |settlement|円
}
```

---

## Step 4: ダッシュボード強化 (`feature/dashboard`)

### 4.1 実装タスク

```
1. web/app/dashboard/page.tsx 拡張
   - 月別グラフ（棒グラフ/円グラフ）
   - カテゴリ別内訳
   - 予算進捗バー
2. 明細リスト
   - フィルタリング（カテゴリ、日付範囲、ステータス）
   - 編集・削除機能
3. 予算設定画面
```

---

## デプロイ手順

### 各Stepのデプロイ

```bash
# 1. ブランチ作成
git checkout -b feature/gmail-auto

# 2. 開発・コミット
git add .
git commit -m "feat: Gmail自動取得機能を実装"

# 3. PRを作成
gh pr create --title "feat: Gmail自動取得機能" --body "Step 1完了"

# 4. マージ後、デプロイ
git checkout master
git pull
firebase deploy --only functions

# 5. 動作確認
curl https://line-kakeibo-0410.cloudfunctions.net/health
```

### ロールバック

```bash
# 問題発生時
git checkout master
git revert HEAD
firebase deploy --only functions
```

---

## 進捗管理

### Step 1 チェックリスト

- [ ] Google Cloud Console設定完了
- [ ] 環境変数設定完了
- [ ] gmail/types.ts 作成
- [ ] gmail/auth.ts 作成
- [ ] gmail/parser.ts 作成
- [ ] gmail/watch.ts 作成
- [ ] gmail/handler.ts 作成
- [ ] line/flexMessage.ts 作成
- [ ] line/postback.ts 作成
- [ ] index.ts にエクスポート追加
- [ ] ローカルテスト完了
- [ ] デプロイ完了
- [ ] 本番テスト完了

### Step 2 チェックリスト

- [ ] textParser.ts 拡張
- [ ] 返答メッセージにボタン追加
- [ ] テスト完了
- [ ] デプロイ完了

### Step 3 チェックリスト

- [ ] Firestoreスキーマ拡張
- [ ] 立替一覧コマンド実装
- [ ] 精算計算ロジック実装
- [ ] 精算通知実装
- [ ] テスト完了
- [ ] デプロイ完了

### Step 4 チェックリスト

- [ ] グラフコンポーネント実装
- [ ] 明細リスト実装
- [ ] 予算設定画面実装
- [ ] テスト完了
- [ ] デプロイ完了
