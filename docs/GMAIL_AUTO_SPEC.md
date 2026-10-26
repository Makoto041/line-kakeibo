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
| カテゴリ分類 | キーワード + AI（Jev。失敗時は Gemini）による自動カテゴリ分類 | `geminiCategoryClassifier.ts` / `jevCategoryClassifier.ts` |
| グループ機能 | LINE グループに紐づく世帯（2 名固定）での共同家計簿 | `firestore.ts` / `expenseGroupScope.ts` |
| 固定費 | 毎月の固定費を引き落とし日に自動計上 | `recurringExpenses.ts` |
| Web ダッシュボード | 支出一覧・編集・精算・統計表示 | `web/` |

### 1.3 Gmail 連携で追加した機能

- **Gmail 自動取得**: 三井住友カード利用通知メールを自動検知・登録
- **現在値＋[変更] の確認 UI**: 支出区分/支払った人/立替/カテゴリの現在値をリッチテキストで表示し、変更は各行のボタンで行う（テキスト入力の登録カードと共通）

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
既存のカテゴリ分類（Jev → 失敗時 Gemini → 辞書）
geminiCategoryClassifier.ts / jevCategoryClassifier.ts
    ↓
Firestore 保存（トランザクション・重複排除）
firestore.ts (saveGmailExpenseAtomic)
＋ 同じトランザクションで送信待ちの印 system/gmailCardNotice_{messageId}（gmail/cardNotice.ts）
    ↓
LINE Bot
Flex Message 通知（line/flexMessage.ts。X-Line-Retry-Key 付き）→ 送れたら印を消す
（送れなければ印が残り、同じメールの再処理で送り直す。§3.2）
```

### 2.2 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js（Vercel） |
| バックエンド | Firebase Functions gen2 / Node.js 22（TypeScript） |
| データベース | Cloud Firestore |
| AI 分類 | TypeSafe AI の Jev（退避先は Gemini API） |
| 通知 | LINE Messaging API |
| メール連携 | Gmail API + Pub/Sub |
| 秘密管理 | Firebase Secret Manager（`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `ADMIN_SECRET` など） |

---

## 3. 入力チャネル設計

### 3.1 チャネル一覧

| チャネル | トリガー | 処理方法 |
|---------|---------|----------|
| テキスト入力 | LINE テキスト | textParser.ts → カテゴリ分類（キーワード辞書 → Jev → Gemini） |
| クレジットカード | Gmail Pub/Sub | メールパース → カテゴリ分類（Jev → Gemini → キーワード辞書） |
| 固定費 | 日次スケジュール | recurringExpenses.ts（分類なし。登録時のカテゴリ） |

### 3.2 クレカ自動取得の詳細

- **監視対象メール**: 三井住友ゴールドVISA（NL）の利用通知のみ
- **フィルタ条件**（`gmail/parser.ts` の `isSMBCGoldVISANL`、`gmail/types.ts` の `SMBC_CARD_FILTER`）:
  - From のアドレス部（表示名は見ない）のドメインが `vpass.ne.jp` または `smbc-card.com`（サブドメイン可。`evilvpass.ne.jp` のような文字列一致は不可）
  - 本文に「三井住友ゴールドＶＩＳＡ（ＮＬ）」（半角・括弧半角の表記ゆれも可）を含む
- **他カードの通知メールは無視**
- **店名の抽出**（`parseSMBCCardEmail`）: 「ご利用店名：」「◇利用先：」の後ろを行末まで取る。text/html しか無いメールは改行が空白になるため、次の項目のラベル（`◇利用金額：` `ご利用金額：` など、ラベルの直後にコロン）の手前で切り、100 文字（モデルに送る上限と同じ）で打ち切る。空なら「不明な店舗」
- **重複チェック**: `gmailMessageId` に加え、`date + amount` が同じ `gmail_auto` 支出のうち店舗名が類似（一致または包含）し `usedAt` が ±1 分のものも弾く（`saveGmailExpenseAtomic`。Firestore トランザクション内で判定）
- **失敗時の扱い**: 1 通でも処理に失敗したら `historyId` を進めずに投げる。`gmailPubSubHandler` は `retry: true` なので、関数の失敗で Pub/Sub が同じ通知を再送する（2nd gen は 10〜600 秒の指数バックオフで、最大 24 時間）。再送と、その間に届いた新しい通知が同じ範囲をやり直す（重複は `gmailMessageId` で弾く）。以前は `retry` を指定しておらず（firebase-functions の既定は再送なし）、失敗すると次に INBOX へ何か届くまでやり直されなかった
  - **諦める条件**（`shouldAbandon`）: 同じメッセージが試行 3 回以上 **かつ** 最初の失敗から 6 時間以上失敗し続けたら、その 1 通は諦めて先へ進む（恒久的に処理できない 1 通で以降の取り込みが止まらないように）。回数だけで決めないのは、再送と新しい通知で 3 回を数分で使い切り、LINE・Firestore・Gmail API の一時的な障害でも諦めてしまうため。`system/gmailFailures` に試行回数と最初・最後の失敗の時刻を記録する（§5.4。`firstFailedAt` の無い記録は `lastFailedAt` で代用）。諦めたメールは `/gmail/force-process/:messageId` で個別に処理し直せる
  - **消されたメール**（`messages.get` が 404）は、何度やり直しても取れないので失敗として数えず読み飛ばす（失敗の記録も消す）。送信待ちの印があるメールは `messages.get` の前に印の処理で終えるので、読み飛ばすのは印の無いメールだけ
  - **古い通知は捨てる**（`isStaleGmailEvent`）: publish から 12 時間より古い通知は処理せずに成功で返す（再送も止まる）。古さはメッセージの `publishTime`（Pub/Sub が publish 時に付け、再送でも変わらない）で測る（CloudEvent の `time` は使わない。コードには無いときの防御として `time` を使う分岐があるが、firebase-functions の Message は `publishTime` を必ず埋めるので本番では通らない）。Gmail の認可切れなど、メール単位の諦めに届かない失敗で同じ通知を 1 日中やり直し続けないため。取込は通知の `historyId` ではなく保存してある `historyId` からの全範囲を処理するので、捨てても取りこぼさない（その範囲は次の新しい通知で処理される。Gmail が履歴を残す約 1 週間以内に限る。§11.2）
  - **やり直しても直らない失敗は再送させない**: 通知の本文から `historyId` が読めない（JSON でない・`historyId` が無い・数値として読めない）、Gmail のトークンが無い（`GmailTokenMissingError`。OAuth の設定前・`/gmail/revoke` の後）、watch の状態（`system/gmailState`）が無い、通知が連携中のアカウントのものでない（下の照合）ときは、投げずに固定文の警告を出して終える。Gmail・Firestore・LINE の一時的な失敗（5xx・通信の失敗・トークンの更新の失敗など）は投げて再送させる
  - **通知のアカウントの照合**（`notificationAccountOf`。#280）: 通知の本文の `emailAddress` を、watch の登録・更新で保存した連携中のアカウントのアドレス（`system/gmailState` の `emailAddress`。§5.4）と比べる（前後の空白を落とし、大文字小文字は区別しない）。違う・通知にアドレスが無いときは（下の追従に当たらなければ）、`history.list` を呼ばず、`historyId` も更新せずに終える（固定文の警告。アドレスはログに出さない）。アカウントを切り替えたあとも古いアカウントの watch は最大 7 日通知しうるため（§11.2）。その通知の `historyId` は別のメールボックスの番号なので、以前は前進のみの更新を通って保存され、新しいアカウントの位置が先へ飛んで取りこぼしえた。読み飛ばしても取りこぼさない（取込は保存してある `historyId` からの全範囲を処理するので、連携中のアカウントの次の通知で処理される）。照合は `getWatchState` の読み取り（以前からある）に載せるので、一致する通知では API 呼び出し・Firestore の読み取りは増えない。読み取りの失敗は以前どおり投げて再送させる
    - **保存してあるアドレスが古いときは追従する**（`followLinkedAddressChange`）: 照合が合わなかった通知では、`users.getProfile` を 1 回だけ呼んで連携中のアカウント（トークンのアカウント）のアドレスを取り、通知のアドレスと同じなら、保存してあるアドレスが古い（プライマリアドレスの変更など）だけなので、`emailAddress` を書き直して処理を続ける（固定文の警告）。照合の誤判定で取込が止まらないようにするため。別のアカウントの通知・偽の通知は `getProfile` のアドレスと一致しないので読み飛ばす。通知にアドレスが無ければ呼ばない。`getProfile`・書き直しの失敗は一時的な失敗として投げ、再送させる
    - アドレスが保存されていない（この照合を入れる前に登録した watch の状態）ときは照合せず、以前どおり処理する（取込を止めない。固定文のログを出す）。アドレスは次の watch の更新（`renewGmailWatch`・`/gmail/register-watch`）で保存される
  - 名前・値の無いヘッダーや payload の無いメールでも投げない（送信元・本文が空のメールとして、カード利用通知ではないと判定する）。投げるとその 1 通が失敗し続け、取込が最大 6 時間止まる
  - 関数のタイムアウトは 300 秒（止まっていた範囲をまとめてやり直しても打ち切られないように。打ち切りも失敗として再送される）
- **保存後に LINE 通知が失敗・中断したとき**（`gmail/cardNotice.ts`）: 支出の保存と同じトランザクションで送信待ちの印（`system/gmailCardNotice_{messageId}`。§5.4）を作り、カードを送れたら消す。push が失敗する（LINE の 5xx・月の上限の 429・ネットワーク）か、保存と push の間で関数が止まると印が残る。同じメールの再処理（上の Pub/Sub の再送・`/gmail/force-process/:messageId`）は、重複チェックより先に印を見て、あれば**保存時点のカード**（判定元の括弧も含む）を送り直して終える。
  - 二重に届かないよう、メッセージから決まる `X-Line-Retry-Key`（`gmail-card:{messageId}` から作る UUID。`settlementSummary.ts` の `summaryRetryKey` と同じ導き方）を付ける。LINE が受け付け済みなら 409 が返り、送れた扱いにする
  - key が効くのは 24 時間なので、作ってから 23 時間を過ぎた印は送らずに消す（警告ログ）。支出が消されていたら送らずに消す（取り込み直さない）
  - 印は LINE グループ（`LINE_GROUP_ID`）があるときだけ作る。印の無い既存の支出には送らない（この仕組みより前の支出のカードは送り直さない）。`/gmail/process-latest` は以前どおりカードを送らず、印も作らない
  - 同じメールを同時に処理しても、保存のトランザクション（重複の判定と印の文書を読んでから書く）で支出は 1 件になる。「登録済み」になった側も印が残っていれば同じ key で送る（届くのは 1 回）
  - 再処理されなくなったメールの印は消す（店名・金額・日付を残さない。届かなかったことを警告ログに出す）: 上の条件で諦めたメール（`historyId` を進めたときだけ。同じ実行に再試行する失敗があって `historyId` を進めないときは、諦めたメールも次の再送で同じ範囲として再処理されるので残し、そこで送れればカードが届く）と、`historyId` が古すぎて先へ飛ばしたとき（飛ばした範囲のメッセージは取れないので、`system/gmailFailures` の記録とその実行で失敗したメールだけ）。消せなくても取込は止めない。諦めたあとに `/gmail/force-process` を呼んでも、印が無いのでカードは送り直さない
- **Gmail Watch の有効期限**: 7 日 → `renewGmailWatch`（6 日ごと 3:00 JST）で自動更新。更新は watch を呼び直すだけで、保存してある `historyId` は変えない（§11.2）。watch の後に `users.getProfile` で連携中のアカウントのアドレスを取り直して保存する（上の照合に使う。取れなければ投げ、Cloud Scheduler がやり直す）。このとき Gmail 側の watch は延長済みだが、Firestore の `watchExpiration` は古いまま残るので、やり直しが成功するまで `/gmail/status` の `isExpiringSoon` が実際と違うことがある

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
| 「立替一覧」/「立替」/「精算」 | 期間の精算（折半）と［自分が立替］の案内、精算画面へのリンク（一覧・精算の記録はしない） | line/commands/advance.ts |

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
| 現在の設定 | `支出区分：…` `支払った人：カード` `立替：なし（折半）` `カテゴリ：…（判定元。決まらなければ（未判定））` の 4 行。各行の右端にボタン（支払った人は [自分が払った]、立替は [自分が立替] / [取り消す]）。判定元の括弧は最初の通知だけに出す（`docs/SPECIFICATION.md` §2.4） |
| フッター | `OK` `修正` / `レシート添付` / `家計簿一覧を見る` |

現在値は `status` から導出する。導出ルールと遷移ルールは `docs/SPECIFICATION.md` §2.4 / §2.5 を参照。

### 4.3 ボタン押下後の動作

状態を変えたら、最新の現在値を反映したカードを `replyToken` で返信する（LINE は送信済みメッセージを編集できないため）。

| 操作 | Firestore の status | 備考 |
|-------|-------------------|---------------|
| 支出区分 [変更] | shared ⇔ personal | `includeInTotal` を連動。立替は解除 |
| 支払った人 [自分が払った] | （status 不変） | 押下者を `payerId` / `payerDisplayName` に記録（世帯の有効メンバーだけ。立替なら `advanceBy` も押下者）。期間の精算（折半）はこの支払った人で数える。Web の支払い者も「クレジットカード」ではなくその人になる |
| 立替 [自分が立替] / [取り消す] | shared ⇔ advance_pending | 立替は押下者を `advanceBy` と支払った人に記録し `advanceFull: true`（世帯の有効メンバーだけ）。折半せず、支出の日付の期間の精算で全額を返す。取り消すと shared に戻り、支払った人の分として折半する |
| カテゴリ [変更] | （status 不変） | 選択カルーセルを表示して確定 |
| OK | （shared のまま） | `confirmed` を立てるだけ。以前に `pending` で入った分は shared へ揃う |
| （無反応） | shared のまま | 取込時点で共同費として確定（`confirmed: true`）。要確認にはしない（要確認は LINE 手入力の支出だけ） |

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
| subCategory | string | 中項目（食費・娯楽だけ。辞書で決まったときだけ。SPECIFICATION.md §4.1） | |
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
| status | string | `shared`（取込時）/ `personal` / `advance_pending` / `advance_settled`。`pending` は以前の取込にだけ残るレガシー値（Web・LINE とも共同費として扱う） |
| advanceBy | string | 立替者（立替時のみ） |
| advanceFull | boolean | 立替を全額で精算に加算する扱い（［自分が立替］で `true`。無い立替は全額にする前の立替） |
| includeInTotal | boolean | 合計金額に含めるか |

### 5.3 includeInTotal の初期値

入力元によって初期値が異なる:

| 入力元 | includeInTotal 初期値 | 理由 |
|--------|---------------------|------|
| `gmail_auto` | `true` | 共用カードからの取得なので、初期状態で会計に含める（`status: 'shared'`・`confirmed: true` で確定扱い） |
| `line_text` | `false` | 確認ボタン（OK / 共同費 / 自分が払った / 自分が立替）を押すまで含めない |
| `recurring` | `true` | 固定費は登録時点で確定扱い（`confirmed: true`） |

- LINE 手入力: OK、「支出区分：共同費」、「支払った人」の [自分が払った]、または「立替」の [自分が立替] で `includeInTotal: true` に更新
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
| historyId | string | 最後に処理した Gmail historyId（前進のみ。古い通知の後着で巻き戻さない）。進めるのは取込（`gmailPubSubHandler`）だけ。watch の登録・更新（`renewGmailWatch`・`/gmail/register-watch`）では変えず、値が無いとき（初回・`/gmail/revoke` の後）だけ watch の応答の値を入れる |
| watchExpiration | number | Watch 有効期限（Unix timestamp ms）。watch の登録・更新のたびに merge で書く |
| emailAddress | string | 連携中のアカウントのアドレス（小文字）。watch の登録・更新のたびに `users.getProfile` で取って merge で書く（`historyId` を残すときも書く。応答にアドレスが無ければ書かない）。取込が通知の `emailAddress` と照合する（§3.2）。照合が合わない通知で `getProfile` が通知と同じだったとき（アドレスの変更）は、取込も `emailAddress`（と `updatedAt`）だけを書き直す。`/gmail/revoke` で文書ごと消える。ログ・管理 API の応答には出さない。この項目を足す前に登録した状態には無く、そのあいだは照合しない |
| updatedAt | timestamp | 最後に書いた時刻 |

#### system/oauthState

OAuth 認可の CSRF 用 state。`/gmail/auth` で発行し、`/gmail/callback` で照合後に削除する。

#### system/gmailFailures

処理に失敗したメッセージの記録（`{ [messageId]: { attempts, lastError, firstFailedAt, lastFailedAt } }`）。試行 3 回以上かつ `firstFailedAt` から 6 時間以上たったメッセージは諦めて `historyId` を進める（§3.2）。成功したら（消されたメールを読み飛ばしたときも）記録を消す。

| フィールド | 型 | 説明 |
|-----------|---|------|
| attempts | number | 失敗した回数（再送と新しい通知の両方で増える） |
| lastError | string | 最後の失敗のエラーの文言（500 文字まで） |
| firstFailedAt | timestamp | 最初の失敗の時刻。2 回目以降の失敗でも引き継ぐ。この項目を足す前の記録には無く、次の失敗で `lastFailedAt` の値を入れる |
| lastFailedAt | timestamp | 最後の失敗の時刻 |

#### system/gmailCardNotice_{messageId}

カード利用通知の送信待ちの印（§3.2。`gmail/cardNotice.ts`）。支出を新規に保存するのと同じトランザクションで作り、カードを送れたら（409 も含む）消す。23 時間を過ぎた印・支出が消された印は送らずに消す。諦めたメール（§3.2 の条件。`historyId` を進めたときだけ）・`historyId` が古すぎて飛ばしたメールの印も消す。

| フィールド | 型 | 説明 |
|-----------|---|------|
| expenseId | string | 保存した支出の ID |
| lineGroupId | string | 送り先の LINE グループ ID |
| card | map | 送るはずだったカード（`CardUsageInfo`。undefined の項目は持たない。判定元 `categoryOrigin` もここにだけ残る） |
| createdAt | timestamp | 作った時刻（23 時間の判定に使う） |
| expireAt | timestamp | `createdAt` + 24 時間。Firestore の TTL で消す時刻（消し損ねた印を残さないため） |

TTL ポリシー（`system` コレクショングループの `expireAt`）は運用で設定する（`gcloud firestore fields ttls update expireAt --collection-group=system --enable-ttl --project=<projectId>`）。未設定でも動作は変わらない（印は送ったとき・送らないと決まったときに bot が消す。TTL は消し損ねた印の後始末だけ）。`system` コレクションで `expireAt` を持つのはこの印だけで、TTL はこのフィールドを持つ文書だけを消す（`oauthState` の `expiresAt` は別のフィールドで対象外）。TTL の削除は期限から 24 時間ほど遅れることがある。

予算は `budgetSettings/{lineId or lineGroupId}` に持つ（`SPECIFICATION.md` §6）。

---

## 6. カテゴリ定義

正準カテゴリは `categoryNormalization.ts` の 19 種で、Gmail 取込も同じ分類器（`classifyExpense`）を使う。ただし店名は部分一致のキーワード辞書で取り違えやすいため、`source: 'merchant'` を渡して **Jev → Gemini の順にモデルを先に使い**、どちらも使えないときだけ辞書で判定する（Jev から Gemini に回す条件も含めて SPECIFICATION.md §4）:

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
│   ├── cardNotice.ts         # カード利用通知の送信待ちの印（system/gmailCardNotice_*）と送り直し（§3.2）
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
├── geminiCategoryClassifier.ts   # カテゴリ分類の入口（キャッシュ・辞書・Jev → Gemini の順序。Gemini の呼び出しもここ。ファイル名は従来のまま）
├── jevCategoryClassifier.ts      # Jev（分類のメイン）の呼び出し
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
| TYPESAFE_API_KEY | TypeSafe AI（Jev）の API キー。カテゴリ分類のメイン |
| GEMINI_API_KEY | Gemini API キー。カテゴリ分類の退避先（Jev が失敗したとき）・フィードバック解析 |
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
   初回は `system/gmailState` が無いので、watch の応答の `historyId`（その時点の位置）から取り込みを始める。2 回目以降は保存してある `historyId` を変えない（§11.2）。あわせて連携中のアカウントのアドレス（`users.getProfile`）を `emailAddress` に保存し、取込が通知と照合する（§3.2）

---

## 10. Gmail API エンドポイント

`api` 関数（us-central1）の `/gmail` ルーター:

| メソッド | パス | 説明 | 認証 |
|---------|-----|------|------|
| GET | `/api/gmail/auth` | OAuth2 認証 URL を取得 | Admin |
| GET | `/api/gmail/callback` | OAuth2 コールバック（Google からのリダイレクト先。CSRF state を照合） | **不要** |
| POST | `/api/gmail/register-watch` | Gmail Watch 登録・更新（保存してある `historyId` は変えない。応答の `historyId` は保存後の値。連携中のアカウントのアドレスを `system/gmailState` に保存する〔応答には出さない〕） | Admin |
| GET | `/api/gmail/status` | Gmail 連携ステータス確認 | Admin |
| POST | `/api/gmail/process-latest` | 最新の SMBC カードメールを手動処理 | Admin |
| POST | `/api/gmail/test-process` | SMBC カードメール内容をプレビュー | Admin |
| POST | `/api/gmail/force-process/:messageId` | 指定メッセージ ID を強制処理（冪等）。既に支出があり、送信待ちのカード（§3.2）が残っていれば送り直す（応答の `cardNotice` が `sent`） | Admin |
| POST | `/api/gmail/refresh-token` | トークン強制リフレッシュ | Admin |
| DELETE | `/api/gmail/revoke` | トークンを Google 側で失効させてから削除する。再認証・アカウントの切替・トークンが漏れたときに使う（`system/gmailState` も消す。消せなければ 500 と `watchStateCleared: false` を返すので、やり直す）。Google 側の結果は `googleRevoked` で返す（下の「revoke の応答」） | Admin |

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

### revoke の応答

`DELETE /api/gmail/revoke`（`adminRouter.ts`）は次の順に進む。

1. 保存してあるトークンを Google 側で失効させる（`auth.ts` の `revokeGmailTokenOnGoogle`）。`POST https://oauth2.googleapis.com/revoke` に、トークンを `application/x-www-form-urlencoded` の本文（`token=...`）で送る（URL のクエリには載せない）。refresh_token を先に、access_token を後に送る。1 回の待ち時間は 5 秒（最大 2 回）
   - Google の文書（[Token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)）は「access_token を失効させると、対応する refresh_token も失効する」と明記している。逆向き（refresh_token → access_token）の明記は無く、「失効はプロジェクトに与えた権限をすべて外し、発行済みのアクセス・リフレッシュトークンを無効にする」という一般的な記述だけなので、両方送る
   - どちらかで Google が 2xx を返せば、失効できたとする（`googleRevoked: true`）。refresh_token の失効が通った後の access_token は既に無効なので 400 になりうるが、結果は変えない
2. Firestore のトークン（`system/gmailToken`）を消す。Google 側の失効に失敗しても消す（取込にもう使わせない）
3. `system/gmailState` を消す

| HTTP | `success` | 状況 | 管理者がすること |
|------|-----------|------|------------------|
| 200 | `true` | 1〜3 がすべて済んだ（`googleRevoked: true`） | 再認証する |
| 200 | `true` | トークンが保存されていなかった。Google へは何も送っていない（`googleRevoked: null`） | 前の revoke が `googleRevoked: false` だったなら、下の手動の手順で外す |
| 200 | `false` | 2・3 は済んだが、Google が失効を受け付けなかった（2xx 以外・タイムアウト・通信の失敗。`googleRevoked: false`） | Google アカウントの「サードパーティのアクセス」（[サードパーティ製のアプリとサービスとの接続](https://myaccount.google.com/connections)）から、このアプリを手動で外す。トークンはもう消えているので、revoke をやり直しても Google へは送られない（`message` で案内する） |
| 500 | `false` | 3 に失敗した（`watchStateCleared: false`） | revoke をやり直す。`googleRevoked: false` なら手動でも外す（`error` で案内する） |

- Google 側に失敗しても 502 にしないのは、Firestore 側の処理は済んでいて、同じ要求をやり直しても直らない（トークンが無いので Google へ送られない）ため。500 は「やり直す」とき（`system/gmailState` を消せなかった）だけに使う。両方に失敗したら 500 を返す
- 応答の `googleRevoke` は、トークンごとの結果（`refreshToken` / `accessToken`）。`result` は `revoked`（2xx）/ `rejected`（2xx 以外。`status` に Google の HTTP の状態）/ `timeout` / `network_error` / `skipped`（そのトークンが保存されていない）。トークン・Google の応答の本文・例外の文言は、応答にもログにも出さない（ログは固定文と結果だけ。通信の失敗は `errorFields`）

```json
{
  "success": false,
  "watchStateCleared": true,
  "googleRevoked": false,
  "googleRevoke": {
    "refreshToken": { "result": "rejected", "status": 400 },
    "accessToken": { "result": "timeout" }
  },
  "message": "Token deleted from Firestore. Google did not confirm the token revocation. Remove this app manually ..."
}
```

---

## 11. 注意事項

### 11.1 既存機能への影響

- Gmail 自動取得は**追加機能**として実装し、LINE テキスト入力の経路は変えない
- 保存は `saveGmailExpenseAtomic`（重複排除つき）、分類は既存の分類器（`classifyExpense`。Jev がメイン、Gemini は退避先）を再利用
- 確認カードとボタン後の状態遷移はテキスト入力と共通（`expenseActions.ts`）

### 11.2 Gmail Watch 制約

- Gmail Watch は 7 日間の有効期限あり
- 6 日ごとに Cloud Scheduler（`renewGmailWatch`）で自動更新
- 更新は stop を呼ばずに watch を呼び直す（`users.watch` は「Set up or update a push notification watch」。push ガイドの「Renew mailbox watch」も 7 日以内に watch を呼び直すことだけを求めている）。更新に失敗したら Cloud Scheduler が 2 回までやり直す（`retryCount: 2`）。それでも失敗すると、watch は約 1 日後に切れる。cron が 6 日ごとなので、通知は最大数日止まりうる。保存してある `historyId` は残るので、約 1 週間以内なら再登録後の最初の通知でまとめて処理される
- watch の登録・更新（`renewGmailWatch`・`/gmail/register-watch`）は、保存してある `historyId` を変えない（`registerWatch`。Firestore トランザクションで読み、`watchExpiration`・`updatedAt` と連携中のアカウントのアドレス `emailAddress` だけを merge で書く）。watch の応答の `historyId` はその時点のメールボックスの位置なので、以前のように上書きすると、取込が失敗して `historyId` が止まっている間の範囲が二度と処理されなかった。応答の値を入れるのは、保存値が無いとき（初回・`/gmail/revoke` の後）と、数値として読めない値が入っていたときだけ
- そのため、止まっていた `historyId` が残っていると、次の通知でその範囲のメールがまとめて処理される（二重登録は `gmailMessageId` で防ぐ）
- `/gmail/register-watch` で「今の位置まで飛ばす」ことはできない。飛ばしたいときは `system/gmailState` の `historyId` を消してから `/gmail/register-watch` を呼ぶ
- **別の Gmail アカウントに切り替える手順**:
  1. `/gmail/revoke` を呼ぶ（トークンを Google 側で失効させ、トークンと `system/gmailState` を消す）。応答が `watchStateCleared: true` で `system/gmailState` が消えたことを確認する（消せなかったときは 500 と `watchStateCleared: false` が返るので、revoke をやり直す）。`googleRevoked: false` なら、古いアカウントの Google アカウントの「サードパーティのアクセス」から、このアプリを手動で外す（§10「revoke の応答」）
  2. 新しいアカウントで `/gmail/auth` から認可する
  3. `/gmail/register-watch` を呼ぶ。新しいアカウントの位置から取り込みを始め、そのアドレスを `system/gmailState` の `emailAddress` に保存する
  - revoke は現状 `users.stop` を呼ばない。呼ぶ場合も、トークンが有効なときだけ効く（取り消し済みのトークンでは stop できない）。このため古いアカウントの watch は最大 7 日、同じ topic に通知を送りうる（revoke は Google 側のトークンも失効させる〔refresh_token と access_token。結果は応答の `googleRevoked`〕が、それで通知が止まるかは確かめていない）。その通知は 3. の後は通知の `emailAddress` の照合で読み飛ばされ、`historyId` も変わらない（§3.2。連携中のアカウントの `getProfile` とも一致しないので、追従もしない）。1.〜3. の間は watch の状態が無いので、どの通知も処理されない（2. のあとは新しいアカウントのトークンはある）。7 日たてば古い watch は切れる
  - revoke をせずに別のアカウントで認可し直すと、`system/gmailState` の `historyId`（古いアカウントの位置）が残ったまま新しいアカウントで取り込もうとする。次の watch の登録・更新で、保存してあるアドレスと違うアカウントなら固定文の警告（`Gmail account differs from the saved one`）を出す（アドレスは新しいアカウントにするが、`historyId` は残す）。この警告が出たら、上の手順でやり直す。revoke をせずに認可し直した場合は、代わりに取込の `Linked Gmail address changed` が出ることもある（新しいアカウントの通知で `getProfile` と通知が一致して保存値が書き直されるので、`Gmail account differs from the saved one` の検知が出ない）。アドレスを変えた覚えが無いのにこの警告が出たら、切替の手順（先に revoke）でやり直す
- 連携中のアカウントのアドレスが変わった（プライマリアドレスの変更など）ときは、取込が自動で追従する（照合が合わない通知で `getProfile` が通知と同じなら、保存値を書き直して処理する。§3.2）。それでも直らない（通知が読み飛ばされ続ける）ときは、`/gmail/register-watch` を呼べば `getProfile` のアドレスで保存し直す（`historyId` は変えない）
- `emailAddress` の照合が効くのは、このコードをデプロイしたあとの最初の watch の登録・更新（`renewGmailWatch` は 6 日ごと。すぐに効かせたいときは `/gmail/register-watch`。`historyId` は変えないので、いつ呼んでもよい）から。それまでは照合せず、以前どおり処理する
- トークンリフレッシュは自動化（`getValidAccessToken`）
- historyId は Gmail 側で約 1 週間しか保持されない。古すぎて `history.list` が 404 を返した場合、ハンドラーは通知の historyId まで進める（その間のメールは取り込まれない。必要なら `/api/gmail/force-process/:messageId` で個別に処理する）

### 11.3 セキュリティ

- OAuth2 のクライアント ID / シークレットは Secret Manager、発行されたトークンは Firestore `system/gmailToken`（クライアントからは読めない）
- トークンが漏れたとき・連携をやめるときは `/api/gmail/revoke` を呼ぶ。応答が `googleRevoked: false`（Google が失効を受け付けなかった）なら、Google アカウントの「サードパーティのアクセス」から手動で外す（§10「revoke の応答」）
- 共用カード以外のメールは送信元アドレスと本文キーワードで排除（表示名の偽装は判定に使わない）
- 個人支出は「支出区分」の [変更] で `personal` に切り替える（`includeInTotal: false`）
- Gmail スコープは `gmail.readonly` のみ
