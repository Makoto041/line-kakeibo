# LINE家計簿（ぶちこむ家計簿）機能仕様書

最終更新: 2026-09-28（コードベース実装準拠）

> 本書はリポジトリの**現行実装**をリバースエンジニアリングしてまとめた仕様書です。実際のコードを正とします。
> システム構成・技術選定は [ARCHITECTURE.md](./ARCHITECTURE.md)、認証・ルール・世帯メンバーの運用は [SECURITY_OPERATIONS.md](./SECURITY_OPERATIONS.md) を参照してください。

---

## 1. プロダクト概要

LINE でメッセージを送るだけで支出を記録できる家計簿アプリケーション。

- **入力チャネル**
  1. **LINE Bot へのテキスト入力**（例: `500 ランチ`）
  2. **Gmail 連携**: 三井住友カード ゴールド(NL) の利用通知メールを自動取込
  3. **固定費**: Web で登録した毎月の固定費（家賃・光熱費など）を引き落とし日に自動計上
  4. **Web アプリ**での手動編集・レシート画像添付
- **閲覧チャネル**
  - LINE Bot（`家計簿` コマンドで月次サマリー Flex メッセージ）
  - Web アプリ（Next.js / Vercel）: ホーム・支出一覧・精算・設定（予算 / 期間 / 固定費）
- **共有機能**: LINE グループに紐づく世帯（2 名固定）での支出共有・期間の折半精算（誰が払ったかは支出の「支払った人」で数え、立替は折半せず全額を加算する）・LINE グループへの精算の通知

> 📸 **レシート画像 OCR は廃止済み**（`bot/src/line/webhookApp.ts`）。画像を送ると「画像からの読み取り機能は終了しました。テキストで入力してください」と案内されます。レシート画像は Web の `/attach` ページから支出への「添付」としてのみ扱われます。

---

## 2. LINE Bot 機能仕様

### 2.1 テキストコマンド一覧

| 入力 | 動作 |
|---|---|
| `家計簿` | 当月サマリーの Flex メッセージを返信（予算プログレスバー・カテゴリ別・直近支出）。個人トークなら個人集計、グループトークならグループ集計。8秒タイムアウト時はテキストにフォールバック |
| `カテゴリー` | 有効カテゴリ一覧と現在のデフォルトカテゴリを表示 |
| `カテゴリー <名前>` | デフォルトカテゴリを設定（`userSettings`） |
| `グループ作成 <名前>` | グループ作成（作成者のみがメンバー。招待コードは内部互換のため生成するが表示しない） |
| `参加 <コード> <表示名>` | **無効化済み**。世帯は2名固定で、メンバー追加は管理者が `scripts/manage-group-members.mjs` で行う旨を返信 |
| `グループ一覧` | 所属グループ一覧 |
| `立替一覧` / `立替` / `精算` | 一覧も精算の記録もしない。案内を返す（精算は期間の精算（折半）にまとめていること・相手の分を立て替えたら支出カードの［自分が立替］を押すと、その支出の日付の期間の精算に全額を加算すること・精算額は毎月の起算日に世帯の LINE グループへ通知すること・Web の精算画面のリンク。`line/commands/advance.ts`） |
| `要望 / 改善 / 不具合 / フィードバック <本文>` | Gemini で内容を解析し GitHub Issue を自動起票（`Makoto041/line-kakeibo`） |
| その他のテキスト | 支出テキストとしてパース（§2.2）。金額が取れない場合は**無反応**（誤爆防止） |

グループイベント: メンバー参加（`memberJoined`）は案内メッセージを push するだけで**メンバー登録はしない**。退出（`memberLeft`）はその人の `groupMembers` を `isActive:false` にする。bot 自身の退出（`leave`）ではメンバーシップを変えない。

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

> ⚠️ **カテゴリトークンは現状指定しても反映されない**: `parseTextExpense()` はカテゴリを抽出するものの、登録処理（`processExpenseInBackground`）は `parsed.category` を参照せず、常に Gemini 分類／ユーザーデフォルトからカテゴリを決定します。カテゴリの変更は登録後の「カテゴリ変更」ボタンで行います。

### 2.3 支出登録フロー（`processExpenseInBackground`, `bot/src/line/expenseFlow.ts`)

1. LINE プロフィール取得（リトライ＋15分メモリキャッシュ）
2. `appUid` 解決（LINE userId → Firebase Auth 匿名ユーザーを作成/取得。`linkUserResolver.ts`）
3. カテゴリ分類（§4）とユーザーデフォルトカテゴリを並列取得。Gemini の確信度 ≥ 0.4 なら採用、なければデフォルト、それも無ければ `その他`
4. グループ所属の決定（`expenseGroupScope.ts`）: 発言元の LINE グループに紐づく世帯（`groups.lineGroupId` が一致）の有効メンバーなら `groupId` と `lineGroupId` を付ける。それ以外（第三者・脱退済み・紐づく世帯なし）は**どちらも付けず個人支出**として保存し、Web 一覧にも LINE の集計・精算にも入れない
5. `expenses` に保存（`confirmed: false`, `includeInTotal: false`, `inputSource: 'line_text'`）
6. 確認用 Flex メッセージを送信（§2.4 の登録・編集カード）

### 2.4 登録・編集カードの構成（`bot/src/line/flexMessage.ts`）

テキスト入力・Gmail カード利用の両方で同じビルダー（`buildExpenseCard`）を使い、ヘッダー文言と金額下の補足行だけを差し替える。**現在の設定値はリッチテキストで表示し、ボタンは変更操作だけを担う**。

```text
現在の設定
[users]      支出区分：共同費　　　　[変更]
[wallet]     支払った人：誠　　　　　[自分が払った]
[hand-coins] 立替：なし（折半）　　　[自分が立替]
[食費]       カテゴリ：食費　　　　　[変更]
```

| 領域 | 内容 |
|---|---|
| ヘッダー | テキスト入力=「支出を登録しました」/ カード利用=「カード利用を記録」 |
| 本文 | 店舗名・説明 → 金額と日付 → （残り予算 / 支払い方法）→ 「現在の設定」4行。支払った人は金額の下ではなく「現在の設定」に出す |
| フッター | `OK` `修正` / `レシート添付` / `家計簿一覧を見る` |

各行の先頭にはアイコンを置く。支出区分は共同費系が `users`・個人費/未設定が `user`、支払った人は `wallet`（支払った人がカードのときは `credit-card`）、立替は `hand-coins`、カテゴリは `categoryIconUrl()` が返すカテゴリ別アイコン（未知のカテゴリは `cat-other`）。値をボタンで並べていた頃と同じ絵柄を使い、表示だけになっても見た目の手がかりが減らないようにする。

**支払った人**の表示（`payerLabel()`。Web の `resolvePayerName` と同じ分け方）: `payerId`（無ければ `lineId`）が `gmail-auto-system` なら「カード」、`recurring-system` なら「共通口座」、それ以外は `payerDisplayName` → `userDisplayName` → 「メンバー」の順。期間の精算（折半）はこの支払った人で数える。[自分が払った] は押した人を支払った人にする（カードを送った時点では押す人が分からないので、すでに自分でも出す）。

**立替**は「押した人が払って、相手の分を立て替えた」支出。折半せず、支出の日付の期間の精算で全額を返してもらう（`advanceFull: true`。§5.4 の期間の精算（折半））。立替でない共同費は折半するので「なし（折半）」と表示する（除外は「なし」）。

**「修正」は押す人が分かっていれば URI ボタンで Web 編集画面へ直接飛ぶ**（テキスト入力の登録カード、および postback 応答で返す再構築カード）。Gmail のカード利用通知はグループ宛の push で送信時点では押下者が不明なため、`edit` postback で押した人の `lineId` を含む URL を返す方式を残す。なおグループではカードが全員に届くため、URI ボタンのリンクは組み立てた時点の本人の `lineId` で固定される（`家計簿一覧を見る` の直リンクと同じ性質）。URL の `lineId` は Web 側では**識別に使わない**（§7。編集対象の特定は `?edit=<id>` のみ）。

支出区分と立替は単一の `status` フィールド（と `advanceFull`）から導出する（`deriveExpenseSettings()`）。

**要確認（未確認）は LINE で手入力した支出だけ**。Gmail のカード取込と固定費の自動計上は、取込元で内容が決まっているので確認を求めない（`status: 'shared'`・`confirmed: true` で保存する）。以前に `pending` で入った Gmail 取込も、カードの再表示（`buildExpenseCardFromRecord`）と Web では共同費として扱う（集計にはもとから入っている）。

| `status` | 入力元 | 支出区分 | 立替 |
|---|---|---|---|
| なし / `pending` | LINE 手入力（`includeInTotal: false`） | 共同費（未確認） | なし（折半） |
| `shared` | Gmail 取込・固定費・確認後の手入力 | 共同費 | なし（折半） |
| `personal` | — | 除外 | なし |
| `advance_pending`（`advanceFull: true`） | ［自分が立替］ | 共同費 | あり（全額を精算に加算） |
| `advance_pending`（`advanceFull` なし） | 全額にする前の立替（新しくは作られない） | 共同費 | あり |
| `advance_settled` | 全額にする前の立替を精算済みにしたもの | 共同費 | 精算済み |

`advance_settled` のカードには支出区分・支払った人・立替のボタンを出さない（カテゴリのみ変更可）。

### 2.5 Postback アクション（`bot/src/line/postback.ts`）

支出区分・立替のボタンにはトグル（反転）ではなく**設定する値そのもの**を埋め込む（`to`）。カード描画時点の現在値の反対が入っているため、古いカードから押しても表示どおりの結果になる。

| アクション | 効果 |
|---|---|
| `set_split`（`to: shared \| personal`） | `status` を設定し `includeInTotal` を連動（`shared`=true / `personal`=false）。立替は解除（`advanceBy` / `advanceFull` を削除）。あわせて `confirmed: true` |
| `set_payer`（自分が払った） | `payerId` / `payerDisplayName` を押下者にし、`confirmed: true`。未確認（status なし / `pending`）は `status: 'shared'`・`includeInTotal: true` へ昇格。立替（`advance_pending`）は立替のまま、`advanceBy` も押下者にする（払った人と立て替えた人は同じ）。`personal` は `personal` のまま |
| `set_advance`（`to: on \| off`） | on（自分が立替）= `status: 'advance_pending'`・`advanceFull: true`・`advanceBy` / `payerId` / `payerDisplayName` に押下者・`includeInTotal: true`・`confirmed: true`（除外からでも立替になる）/ off（取り消す）= `status: 'shared'`・`includeInTotal: true`・`confirmed: true`・`advanceBy` / `advanceFull` を削除（支払った人は変えないので、折半で支払った人の分になる）。立替でない支出の off は「立替ではないため、変更はありません」 |
| `confirm`（OK） | `confirmed: true`。**`pending` のときだけ** `status: 'shared'`・`includeInTotal: true` へ昇格（設定済みの支出を共同費へ巻き戻さない） |
| `edit`（修正） | 押下者の `lineId` を含む Web 編集 URL（`/expenses?edit=<id>&lineId=...`）を返信。**押す人が分かっているカードでは「修正」は URI ボタンで直接 Web を開く**ため、この postback へ来るのは Gmail 通知と配信済みの古いカードだけ |
| `show_category_select` / `set_category` | カテゴリ選択カルーセルを表示 / カテゴリを更新 |
| `show_list` | 押下者の `lineId` を含む家計簿一覧 URL を返す |
| `shared` / `personal` / `advance`（旧 UI） | 配信済みカードからの押下に備えて `set_split` / `set_advance`（`advance` は［自分が立替］）へ読み替える |

**押せる人**: `set_payer` と `set_advance`（on / off）は期間の精算の金額が変わるため、押せるのは支出の世帯（`groupId`）の有効メンバーだけ（`groupId` の無い個人の支出は登録した本人だけ、`lineGroupId` だけを持つ旧形式は不可。それ以外は「変更できるのは、世帯のメンバーだけです」）。表示名はメンバー文書の名前 → LINE のプロフィール名 → `User_xxxxxx`。

**矛盾の解消**: 個人費（除外）にすると立替は解除され、立替にすると支出区分は共同費相当に揃う（除外かつ立替は成立しない）。`advance_settled` の支出に対する**支出区分・支払った人・立替の変更**はサーバー側で拒否する（「精算済みのため変更できません」。古いカードにボタンが残っているため、表示を消すだけでは足りない）。カテゴリ変更は精算後も可能（精算額に影響しないため）。

**変更後の再表示**: LINE は送信済みメッセージを編集できないため、状態を変えたら最新値のカードを `replyToken` で返信する（`buildExpenseCardFromRecord()`）。登録直後のカードと同じビルダーを通すので表現がぶれない。

**同時操作**: グループトークでは複数人が同時にボタンを押せるため、読み取り・判定・更新は `runTransaction` で1トランザクションにまとめる（`applyExpenseChange()`。OK・支払った人・立替・取り消しの判定 `decideConfirm()` / `decideSetPayer()` / `decideSetAdvance()` / `decideClearAdvance()` とともに `bot/src/expenseActions.ts` にあり、Web の確認と以前の立替を精算済みにする操作（§5.4。`decideSettleLegacyAdvance()`）も同じ仕組みを使う。`set_payer` / `set_advance` のメンバー確認も同じトランザクション内で読む）。分離していると、誰かが個人費にした直後に別の人の OK が古い `pending` を読んで共同費へ巻き戻したり、精算済み判定をすり抜けて変更が通ったりする。

### 2.6 メッセージ送信ポリシー

LINE 無料枠（push 200通/月）節約のため、**テキスト支出の登録通知**は replyMessage 優先・pushMessage フォールバックで送信（`sendTextExpenseNotification`, `flexMessage.ts`。reply トークン失効時のみ push）。

Postback への応答（設定変更後のカード再送・カテゴリ選択カルーセル・各種案内テキスト）も `replyToken` を使い、失効時のみ push にフォールバックする（`replyToPostback`, `postback.ts`）。

ただし **push 専用の経路も残っている**点に注意:

- Gmail カード利用通知（`sendCardUsageNotification`, `flexMessage.ts`）… グループ宛の非同期プッシュのため reply トークンが無い
- メンバー参加時の案内（`handleMemberJoined`）
- 期間の精算サマリー（§3.4。月 1 回。メンション付きテキストと Flex を 1 回の push で送る。Web の設定から手動で送ったときも push）

これは push 枠を消費する。固定費の自動計上（§3.3）は LINE へ通知しない。Flex メッセージのアイコンは `line-kakeibo.vercel.app/icons` から PNG 配信（lucide 風）。

---

## 3. 自動取込機能

### 3.1 Gmail 連携（三井住友カード利用通知）

- Gmail API（`gmail.readonly` スコープのみ）＋ **Pub/Sub push 通知**（topic: `gmail-notifications`）
- フロー: 新着メール → `gmailPubSubHandler` → history API で差分取得 → SMBC 利用通知をフィルタ → `gmail/parser.ts` で「利用先・金額・利用日時」を抽出 → Gemini でカテゴリ分類 → **アトミック保存**（`gmailMessageId` に加え、`date+amount` が同じ `gmail_auto` 支出のうち店舗名が類似し `usedAt` が ±1 分のものを重複として弾く。`firestore.ts` の `saveGmailExpenseAtomic`）→ LINE グループへ Flex 通知（§2.4 の登録・編集カード。現在の設定 4 行＋ボタン）
- 保存フィールド: `lineId`/`payerId` はシステムユーザー `gmail-auto-system`、`inputSource: 'gmail_auto'`, `status: 'shared'`, `confirmed: true`（自動で入るので要確認にしない）, `includeInTotal: true`, `usedAt`（カード利用日時）、`groupId`（`DEFAULT_GROUP_ID`）/ `lineGroupId`（`LINE_GROUP_ID`）
- watch は7日で失効するため、**6日ごとの cron**（`renewGmailWatch`）で更新
- 管理エンドポイント（`api` function, `/gmail/*`）: OAuth 認可・watch 登録・状態確認・手動処理など。認証は `ADMIN_SECRET` を **`Authorization: Bearer` ヘッダーでのみ**受け付け、定数時間で比較する（`requireAdminAuth`）＋レートリミット（OAuth callback のみ CSRF state 検証）。`?adminSecret=` クエリ渡しはアクセスログ等に秘密値が残るため廃止した。詳細は [GMAIL_AUTO_SPEC.md](./GMAIL_AUTO_SPEC.md)

### 3.2 MoneyForward CSV インポート（廃止）

- 送信先の `/api/mf/import` がリポジトリの履歴上一度も存在せず、送信先の設定（`API_BASE_URL` / `MFKAKEIBO_TOKEN`）も関数に渡していなかったため、機能していなかった。処理は削除済み
- 関数 `importMoneyForward` は、CI の非対話デプロイが本番関数の削除確認で失敗しないよう、何もしない関数として名前だけ残している（ARCHITECTURE.md §3）

### 3.3 固定費の自動計上（`bot/src/recurringExpenses.ts`）

- 項目は Web の設定 > 固定費タブで登録し、`recurringExpenses/{id}` に世帯（`groupId`）ごとに保存する（1 世帯 30 件まで。名前 40 文字・金額 1〜10,000,000 円・引き落とし日 1〜31・正準カテゴリ）。クライアントからは読み書きできず、`/household/recurring` の CRUD（§5.4）を通す
- `postRecurringExpenses`（cron: 毎日 9:10 JST。§3.4 の精算サマリーと同じ実行）が、有効（`active`）な項目のうち当月の引き落とし日（`dayOfMonth`。月の日数を超える日はその月の末日）を迎えたものを `expenses` に計上する。文書 ID を `recurring_{項目ID}_{YYYYMM}` に固定して create するため、同じ月に 2 回は入らない。`lastPostedMonth` に計上した月を記録し、作成日（`startDate`）より前の引き落とし日の分と、停止→再開時に当月の引き落とし日を過ぎていた分は遡らない
- 計上する明細: `inputSource: 'recurring'`, `recurringId`, `confirmed: true`, `includeInTotal: true`, `groupId`（＋世帯の `lineGroupId`）、金額は設定した見込み額（請求確定後は明細側を直す）
  - 支払い元 `shared`（共通のカード・口座）: `lineId`/`payerId` = `recurring-system`、`status: 'shared'`
  - 支払い元 `advance`（メンバーの個人口座）: `lineId`/`payerId`/`payerDisplayName`（`userDisplayName` も）= その人、`status: 'shared'`。`advanceBy` は付けない。期間の精算（折半）でその人の支払いとして数える（例: 家賃）。値の名前 `advance` は以前の「立替」のなごりで、保存する値は変えていない。Web の表示は「個人の口座」、一覧では「<名前>の口座」
- LINE への通知は送らない。カード利用通知メールで自動登録される支出を固定費に登録すると二重になる（画面で案内）
- テスト: 純関数は `bot/scripts/smoke-recurring.js`（`npm -w bot test`）、API と計上は `bot/scripts/emulator-recurring.js`（`npm -w bot run test:emulator`）

### 3.4 期間の精算サマリー（`bot/src/settlementSummary.ts` / `line/settlementSummaryMessage.ts`）

毎月、期間が締まった翌日（期間の起算日）に、Web の「期間の精算（折半）」と同じ内容を LINE グループへ送る。

- **いつ**: 毎日の `postRecurringExpenses`（9:10 JST）の中で判定し、今日が起算日なら送る。起算日は集金するメンバーの期間設定（`userSettings/{lineId}.dateSettings.customStartDay`。無ければ相手の設定、どちらも無ければ 1 日）。例: 15日起算なら 10/15 に 9/15〜10/14 の分。固定期間（`mode: 'custom'`）では送らない。Cloud Scheduler の無料枠（3 ジョブ）を使い切っているため、スケジュールは増やさない
- **対象**: `groups` のうち `lineGroupId` があり、集金するメンバー（`splitSettings.collectFromLineId`）が決まっていて、有効メンバーがちょうど 2 人の世帯
- **計算**: `bot/src/periodSplit.ts`（Web の `web/lib/periodSplit.ts` と同じ式。`smoke-settlement-summary.js` が同じ入力で両方の結果を突き合わせる）
- **メッセージ**（1 回の push に 2 通。LINE の通数は受け取る人数で数えるので、2 人の世帯で月 2 通）
  1. テキスト（`textV2`）: 送金する人と受け取る人をメンション（「9/15〜10/14 の精算（折半）です。@光麦 から @誠 へ ¥159,794 の送金をお願いします。」）。送金なしのときは 2 人をメンションして「今回は送金なし」
  2. Flex: 送金額、内訳（合計・1 人あたり・集金するメンバーの支払い、立替（全額）があれば「+ 相手の立替（全額）」「− 集金するメンバーの立替（全額）」、相手とカード・共通口座の支払い）、カテゴリ別の上位 5 つ（割合のバー。残りは「ほか」。立替（全額）は合計・カテゴリ別に入れない）、要確認の件数（手入力で未確認。合計に入っていない）、「精算を開く」「支出を見る」ボタン
- **冪等**: 送る前に `system/settlementSummary_{groupId}_{期間末日}` を create（同じ期間は 2 回送らない）。送信に失敗したら消して、関数のリトライ（`retryCount: 1`）で送り直す。push には `X-Line-Retry-Key`（世帯と期間から決まる UUID）も付け、LINE が 409（送信済み）を返したら送れたものとして扱う。印があって `sentAt` が無い（前の実行が送信の途中で止まった）ときは、同じキーで送り直す
- **注意**: 起算日が 29〜31 日でその日が無い月には送らず、次の回でその分も含める（31日起算なら 3/31 に 1/31〜3/30）。起算日の 9:10 より後に届いたカード利用通知のうち、利用日が締まった期間内のものはサマリーに入らない（Web の期間の精算には入る）
- **手動の送信**（`sendSettlementSummaryNow`。Web の設定 > 期間タブの「LINEへの精算の通知」→ §5.4 の `POST /household/settlement-summary/send`）: 日付や送信済みの印に関係なく送る。期間は `latestPeriods(今日, 起算日)` で決める（どの日でも決まる。29〜31 日起算でその日が無い月を飛ばす数え方は `closedPeriodFor` と同じ）
  - `closed`（締まった期間）: 直近の起算日に自動で送る期間と同じで、内容も自動の通知と同じ（メンション付き）。`X-Line-Retry-Key` は毎回新しい乱数（同じ期間を送り直せる）。送ったら `system/settlementSummary_{groupId}_{期間末日}` に印を残し、起算日の自動の通知が同じ期間をもう一度送らないようにする（トランザクションで、印が無ければ `groupId`・`endDate`・`createdAt`・`sentAt`・`manualSentAt` で作る。あれば `manualSentAt` だけを書き、`sentAt` が無いときだけ `sentAt` も書く。自動で送った時刻は上書きしない）
  - `current`（今の期間）: 直近の起算日〜今日の途中経過。期間に「（途中経過）」を付け、メンションせずに見込みとして送る。印は付けない（締まったら自動で確定の分が届く）
  - 送れない世帯（LINE グループ無し・集金するメンバー未指定・有効メンバーが 2 人でない・固定期間）は理由を返し、送らない
- テスト: 純関数とメッセージは `bot/scripts/smoke-settlement-summary.js`、送る日の判定・冪等・失敗時の送り直し・手動の送信は `bot/scripts/emulator-settlement-summary.js`

---

## 4. カテゴリ分類仕様

正準カテゴリは **19種**（`bot/src/categoryNormalization.ts` / `web/lib/categoryNormalization.ts`）。エイリアス・キーワード・正規表現で表記ゆれを正準化。

分類はキャッシュ・キーワード辞書・Gemini を組み合わせる（`bot/src/geminiCategoryClassifier.ts`）。入力の種類で順序が違う:

| 入力 | 順序 | 理由 |
|---|---|---|
| LINE のテキスト（`source: 'text'`） | 分類結果キャッシュ（15分）→ キーワード辞書（確信度 0.8）→ Gemini | 「ランチ」のような短い日本語は辞書でほぼ決まり、API を呼ばずに済む |
| カード利用通知の店名（`source: 'merchant'`、Gmail 取込） | 分類結果キャッシュ → **Gemini** → キーワード辞書（Gemini が使えないときだけ） | 店名は半角カナ・ローマ字・略称が多く、部分一致の辞書は取り違えやすい（例: `au` `gu` `etc` `sim` `パン` が店名の一部に一致する） |

- **使うモデルは Flash-Lite 系だけ**（Flash 系は無料枠から外れるため）。メインは「利用できる Flash-Lite の安定版のうち一番新しいもの」で、モデル一覧 API で調べて 24 時間キャッシュする（上位の Flash-Lite が出れば自動でメインになる）。予備はその次に新しい Flash-Lite。一覧を取れないときは既知の順（`gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`）。`-preview` / `-image` などの派生と Flash（Lite でないもの）は使わない
- メインが終了・提供停止（404、または「deprecated / no longer available」などの 400・403）になったときは予備の Flash-Lite に自動で切り替え、以後 1 時間はそのインスタンスで予備を直接使う。思考レベルを受け付けない 400 のときは思考の設定なしで同じモデルに送り直す。レート制限（429）やスキーマ誤りでは切り替えない
- Gemini は `@google/genai` SDK 経由（`bot/src/geminiClient.ts`）。環境変数 `GEMINI_MODEL` でメインを固定できる（Flash-Lite 以外は無視）。思考は `MINIMAL`（フィードバック解析は `LOW`）、8 秒で打ち切り。SDK の再試行は 1 回に抑え、打ち切り時間を超えないようにしている。`GEMINI_MODEL` に 2.5 系を指定した場合は思考の設定を送らない
- 応答は構造化出力（JSON スキーマで `category` をカテゴリ一覧の enum に限定）。カテゴリ一覧は Firestore から取得し 30 分キャッシュ
- Gemini が使えなかった店名の結果はキャッシュしない（復旧後に Gemini で判定し直す）

ユーザーの修正は `categoryFeedback` コレクションに記録される。

---

## 5. Web アプリ機能仕様（`web/` — Next.js 16 App Router）

### 5.1 ページ一覧

| ルート | 内容 |
|---|---|
| `/` | **ホーム（ダッシュボード）**。期間ナビ、合計/件数/日平均カード、予算プログレス、**カテゴリ別 / 支払い者別カード**（`components/home/CategoryBreakdownCard.tsx`。割合の帯と行ごとの金額・件数・前期比。行や「内訳を見る」から内訳シートを開く）＋日別推移（Recharts）、前月比インサイト、残り日数ペース。要確認の支出（LINE で手入力して未確認のもの。`lib/expenseState.ts` の `isPending`。Gmail 取込・固定費は対象外）があれば件数バナー（→ `/expenses?filter=pending`）。LINE 未ログイン（`lineId` クレーム無し）はゲストモード（サンプルデータ＋ガイド） |
| `/expenses` | **支出一覧**。セグメント（全て / 要確認 / 立替。立替は `advance_pending` / `advance_settled`。区分のチップは「立替（全額）」〔`advanceFull`〕/「立替」〔全額にする前の立替〕/「精算済み」）、絞り込み（説明・カテゴリの文字検索、集計対象/対象外、カテゴリ、日付/金額ソート。`lib/expenseState.ts`）、支払者別集計、インライン編集ドロワー、削除、集計対象トグル、レシートプレビュー、要確認の支出の「確認」ボタン（§5.4 の confirm API。LINE の OK と同じ判定）。`?edit=<id>` で編集を自動オープン（LINE の「修正」ボタン連携）、`?filter=pending\|advance` で初期セグメント指定、`?from=YYYY-MM-DD` でその日を含む期間、`?category=` でカテゴリの絞り込み（内訳シートから開くとき） |
| `/settlement` | **精算**。**期間の精算（折半）**（`PeriodSplitCard`）: 表示期間内の世帯の支出（合計に含むもの。立替精算済みと立替（全額）は除く）を 2 人で折半し、「集金するメンバー」（`groups.splitSettings`、§5.4 の split-settings API で保存）の支払い分を引き、立替（全額）を足し引きした集金額を表示（立替があれば式に「+ <相手>の立替（全額）」「− <集金するメンバー>の立替（全額）」の行を出す。§5.4）。誰が払ったかは支出の支払った人（`payerId`、無ければ `lineId`）で数える。2 人の支払いのタイルと「カテゴリ別の内訳を見る」から内訳シートを開く（集金するメンバーの支払い / 相手・カード・共通口座の支払い / 期間の合計。立替（全額）は入れない）。全額にする前の立替（`advanceFull` の無い `advance_pending`）が残っているときだけ、下に「以前の「立替」がN件残っています」のお知らせ（`LeftoverAdvancesCard`。`GET /household/legacy-advances`）を出す: 立替を全額で精算するようにする前の支出なので、精算が済んでいれば精算済みにしてほしい旨（どの期間の精算にも入らなくなる）、［N件を見る］（その場で一覧を開く）、［精算済みにする］（その場で確認 → `POST /household/legacy-advances/settle`） |
| `/settings` | **設定**。予算タブ（月次予算・アラート閾値・カテゴリ別予算）、期間タブ（月次/開始日カスタム/期間指定。保存ボタンの下に「LINEへの精算の通知」カード〔`components/settings/SettlementNotifyCard.tsx`。§3.4〕: 自動で送る日〔毎月N日。「送金する人の期間設定の起算日」と添え、29〜31 日は「その日が無い月は次の回にまとめて」〕・送り先・前の期間とその送信済みの状態を表示し、［今すぐ送る］→ 締まった期間 / 今の期間（途中）を選んで［送る］。送れない世帯では理由を表示。［設定を保存］のあとに読み直す）、固定費タブ（`RecurringExpensesPanel`。§3.3 の項目の追加・編集・停止・削除） |
| `/attach` | **レシート添付**。LINE のカードから直接開かれるため、LINE サインインの完了（`waitForLineAuth`）を待ってから支出を読む。`?expenseId=` の支出にカメラ/アルバムから画像を選択→クライアント側で圧縮（リサイズ＋JPEG 再エンコード）→ Firebase Storage `receipts/{expenseId}/{timestamp}_{name}` へレジューマブルアップロード→ `receiptUrl` を書き戻し。アンマウント後もバックグラウンド継続 |
| `/link` | アカウント連携確認画面（`token` + `lineId` クエリの存在チェックのみ。認証には関与しない） |
| `/dashboard` | `/` へのリダイレクト（レガシー） |
| `/terms` `/privacy` | 静的な規約・プライバシーページ |

### 5.2 UI/UX

- **内訳シート**（`components/drilldown/DrillSheet.tsx`、計算は `lib/drilldown.ts`）: 合計 → カテゴリ / 支払い者 → 明細と潜っていく（モバイルは下からのシート、デスクトップは右のドロワー。パンくずで戻れる）。各階層に金額・件数・合計に占める割合・1 件平均（カテゴリはホームでは前期比と週ごとの棒）、内訳の行、明細（日付順 / 金額順）。明細から編集（`/expenses?edit=<id>`）、カテゴリの階層から支出一覧（`?from=&category=`）へ。読み込み済みの明細から計算し、Firestore を追加で読まない

- Tailwind CSS v4（CSS 変数トークン、ライト/ダーク/システム切替）
- framer-motion による SPA 風ページ遷移アニメーション＋ SWR キャッシュ（`lib/swrCache.ts`）で再読込感を排除。支出・集計・世帯・以前の立替（`advances:`）・設定のキャッシュは localStorage にも保存し（14 日で破棄。別の LINE アカウントに切り替わったら消す）、LINE から開き直したときも前回の内容をすぐ出して裏で取り直す
- レスポンシブ: デスクトップはサイドバー、モバイルはボトムタブ。タブは **ホーム / 支出 / 精算 / 設定** の 4 つ（`components/layout/nav.ts`）
- `/attach` `/link` はナビ chrome なし（`components/layout/AppShell.tsx` の BARE_ROUTES）
- セキュリティヘッダー（`next.config.ts`）: CSP は Report-Only、`X-Frame-Options: DENY`、`X-Robots-Tag: noindex`

### 5.3 データアクセス

- **API Route は無し**。読み取りと通常の編集は**クライアントから Firestore/Storage SDK 直アクセス**（セキュリティルールで許可された範囲。§7）
- 例外: 支出の確認（`status` / `confirmed` の変更）、以前の立替を精算済みにする操作、固定費の CRUD、折半設定の保存、精算の通知の状態の取得と手動の送信は、bot の `api` 関数の認証付き API（§5.4）を経由する（Firestore ルールではクライアントから書けないため。通知は LINE へ送るため）
- `lib/lineAuth.ts`: 起動時に LIFF でログインし、ID トークンを `POST /auth/line` へ送って Firebase カスタムトークンでサインインする。`lib/hooks.ts` の `useLineAuth` は `lineId` を **ID トークンのカスタムクレームからのみ**取得する（URL の `?lineId=` は使わない）
- `useExpenses`: 個人分（`where lineId == 自分`）＋ `groupMembers`（`isActive == true`）から解決した `groupId` の世帯分（`where groupId == …`）をマージ。`useHousehold` が世帯（`groups` 文書・有効メンバー・`splitSettings`）を、`useLegacyAdvances` が全額にする前の立替（`GET /household/legacy-advances`）の応答を保持する。支払い者の表示（`lib/expenseState.ts` の `resolvePayerName` / `isCardSource`）では、LINE で支払った人をメンバーに変えたカード取込はその人の支払いとして出す

### 5.4 Web 向け API（bot の `api` 関数 `/household`、`bot/src/householdApi.ts`）

ベース URL は `https://us-central1-<project>.cloudfunctions.net/api`（`/auth/line` と同じ関数。web は `NEXT_PUBLIC_API_BASE`、無ければ `NEXT_PUBLIC_AUTH_ENDPOINT` から `/auth/line` を除いた値を使う）。

- **認証**: `Authorization: Bearer <Firebase ID トークン>`。`/auth/line` のカスタムトークンでサインインしたユーザー（`sign_in_provider=custom` かつ `lineId` クレームあり）だけを受け付ける。検証は 2 段階で、署名・有効期限を確かめて LINE のユーザーだと分かってから `verifyIdToken(token, true)` で失効・無効化を確かめる（匿名トークンの連打で Auth API を呼ばせない）。無し・不正・失効・無効化は 401、匿名・`lineId` 無しは 403
- **認可**: `groupMembers/{groupId}_{lineId}` が `isActive: true`。支出は `groupId` あり → その世帯の有効メンバー / 個人支出 → 所有者 / `lineGroupId` だけの旧形式 → 不可。Firestore ルールより厳しい（`groupId` のある支出は所有者であっても、その世帯の有効メンバーでなければ 403。旧形式は所有者でも 403）。判定はトランザクション内で読む
- **入力検証**: ID（`:expenseId`・`groupId`・`expectedExpenseIds[]`・`:id`）は 1〜128 文字の文字列で、`/` を含まず `.` `..` `__…__` でないこと。body は JSON オブジェクト。違反は 400
- **CORS**: 許可オリジンは `/auth/line` と同じ（`WEB_ORIGINS` / 本番 Vercel・localhost・`line-kakeibo*.vercel.app`）。`Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`、`Allow-Headers: Content-Type, Authorization`、Cookie は使わない。JSON の解析エラーやレート制限の応答にも付ける。**防御線はトークンとメンバー確認**で、CORS ではない
- **レート制限**: 認証前は接続元 IP 単位 300 回/分（Bearer トークンの無い要求は数えない）。`/auth/line` の挙動を変えないため `trust proxy` は設定せず、Google のフロントエンドが `X-Forwarded-For` の末尾に足す接続元の IP をキーにする（クライアントが送った値はその前に並ぶだけなので詐称できない。IP として読めなければ `req.ip`、IPv6 は /56 単位）。前段が増えて末尾が共通のアドレスになると、インスタンス全体の上限として働く（その場合は 1 つの接続元の連打で全員が 429 になりうるため、上限は大きめにしてある）。認証後は lineId 単位で全ルート合わせて 60 回/分（失敗した応答も数える）、加えて以前の立替を精算済みにする操作は成功したものだけを数えて 5 回/分、精算の通知の手動送信は成功したものだけを数えて 10 分に 3 回（LINE の push の無料枠を連打で使い切らないように）。いずれの上限もインスタンス内メモリで数えるため、複数インスタンスでは最大その倍数まで通る（`api` は maxInstances: 5）
- 全応答 `Cache-Control: no-store`・`X-Content-Type-Options: nosniff`。エラーは `{ "error": "<code>" }`（`invalid_request` / `unauthenticated` / `forbidden` / `not_found` / `rate_limited` / `internal` ほか下表）

| メソッド・パス | リクエスト | 成功時 | 主なエラー |
|---|---|---|---|
| `POST /household/expenses/:expenseId/actions` | `{ "action": "confirm" }`（これ以外の action は 400） | 200 `{ ok: true, expense: { id, status, includeInTotal, confirmed: true, advanceBy \| null, category, updatedAt(ISO) } }`。LINE の OK と同じ判定: status 無し / `pending` → `shared`・`includeInTotal: true`、それ以外は `confirmed: true` だけ（精算済みも 200） | 403 / 404（`confirm` は拒否しないので 409 は無い） |
| `GET /household/legacy-advances?groupId=<id>` | − | 200 `{ groupId, items: [{ id, date, description, amount, category, advanceBy, advanceByName }], expenseIds: [...], asOf }`。全額にする前の立替（`advanceFull` の無い `advance_pending`。全額の立替は期間の精算で返すので含めない）を `createdAt` の新しい順で全件。`advanceBy` は `advanceBy`、無ければ `payerId`。`advanceByName` は支出に記録された名前（`advanceBy` があれば `userDisplayName` → `payerDisplayName`、無ければ `payerDisplayName`。分からなければ空文字） | 403 / 404 |
| `POST /household/legacy-advances/settle` | `{ "groupId": "<id>", "expectedExpenseIds": ["…"] }`（ID は重複を除いて 500 件まで照合する。GET の `expenseIds` が 500 件を超えていてそのまま送った場合は 400 にせず、現在も 500 件超なら `too_many`、500 件以下に減っていれば `stale`） | 200 `{ ok: true, settled, skipped }`。1 件ずつトランザクションで `status: 'advance_settled'`・`advanceSettledAt`（`decideSettleLegacyAdvance`）。精算済みはどの期間の折半にも入らない。その間に範囲外になった・精算済みや取り消しになった・全額の立替になった支出は飛ばして `skipped` に数える（全額の立替〔`advanceFull`〕は変えない） | 409 `too_many`（500 件超）/ `stale`（ID の集合が現在と違う。`current` に最新の GET 内容）/ `nothing_to_settle`（対象も画面も 0 件、または 1 件も精算済みにできなかった） |
| `GET /household/settlement-summary?groupId=<id>` | − | 200 `{ reason, startDay, closed: { startDate, endDate } \| null, current: { startDate, endDate } \| null, closedSentAt: ISO \| null }`（設定の「LINEへの精算の通知」の状態。§3.4）。`reason` は送れるなら `null`、送れなければ `no_line_group`（LINE グループに紐づいていない）/ `no_collect_from`（集金するメンバー未指定。脱退も含む）/ `not_two_members`（有効メンバーが 2 人でない）/ `fixed_period`（期間を日付で固定）。`closedSentAt` は締まった期間を送った時刻（自動・手動のどちらでも） | 403 / 404 |
| `POST /household/settlement-summary/send` | `{ "groupId": "<id>", "period": "closed" \| "current" }` | 200 `{ ok: true, range: { startDate, endDate }, interim }`。精算サマリーを今すぐ世帯の LINE グループへ push する（`sendSettlementSummaryNow`。§3.4 の手動の送信。`closed` は自動の通知と同じ内容で、送ったら送信済みの印を書く。`current` は途中経過で印は書かない） | 409 `unavailable`（`reason` 付き。理由は GET と同じ）/ 502 は LINE への push の失敗だけ: `line_limit`（LINE が 429。月の上限・送りすぎ）/ `line_failed`（それ以外の送信失敗）。世帯・支出の読み込みの失敗などは 500 `internal` |
| `GET /household/recurring?groupId=<id>` | − | 200 `{ items: [固定費項目（dayOfMonth・名前順）], members: [{ lineId, displayName }] }`（`members` は引き落とされるメンバーに選べる有効メンバー） | 403 / 404 |
| `POST /household/recurring` | `{ groupId, name, amount, category, dayOfMonth, payment: "shared"\|"advance", payerLineId: string \| null, active? }`（`advance` は `payerLineId` に世帯の有効メンバーが必須、`shared` は `null`） | 201 `{ item }` | 400 `invalid_request` / 409 `too_many`（30 件超） |
| `PATCH /household/recurring/:id` | 上記のうち変更するキーだけ（空は 400）。トランザクションで読み直して書く。`shared` に変えると `payerLineId` は外れる。停止→再開で当月の引き落とし日を過ぎていれば当月分は遡らない | 200 `{ item }` | 400 / 403 / 404 |
| `DELETE /household/recurring/:id` | − | 200 `{ ok: true }`（計上済みの明細はそのまま残る） | 403 / 404 |
| `POST /household/split-settings` | `{ groupId, collectFromLineId: string \| null }`（有効メンバーの lineId か `null`=解除） | 200 `{ collectFromLineId }`。`groups/{groupId}.splitSettings` に `{ collectFromLineId, updatedBy, updatedAt }` を書く | 400 / 403 / 404 |

- **立替は期間の精算に全額を加算する**: 以前は立替（`advance_pending`）が期間の精算（折半。支払った人 `payerId || lineId` で数える）と別の立替の精算の両方に入り、二重に払うおそれがあった。立替の精算（`GET /household/settlement`・`POST /household/settlement/settle`、LINE の `精算` の記録）はやめ、［自分が立替］にした支出（`advanceFull: true`）は支出の日付の期間の精算で全額を返す。全額にする前の立替（`advanceFull` 無し）は、これまでどおり支払った人の分として折半する（過去の期間の金額を変えないため）。精算が済んでいれば `legacy-advances/settle` で精算済みにする
- **対象範囲**（全額にする前の立替）: `groups/{groupId}.lineGroupId` があれば `lineGroupId` 基準（以前の LINE の `立替一覧` / `精算` と同じ集合）、無ければ `groupId` 基準。期間は見ず、残っている全件
- **期間の精算（折半）**の計算は API を持たない。`web/lib/periodSplit.ts` の `computePeriodSplit` がクライアントで計算する（LINE への通知は同じ式の `bot/src/periodSplit.ts`）: 集金額 = 世帯の支出合計 ÷ 2 − 集金するメンバーの支払い（`payerId`、無ければ `lineId`）＋ 相手の立替（全額）− 集金するメンバーの立替（全額）。合計は `groupId` が一致し `includeInTotal` のもので、`advance_settled` と立替（全額）を除く。立替（全額）は `isFullAdvance`（`status: 'advance_pending'` かつ `advanceFull: true`）のうち日付が期間内のもので、立て替えた人（`advanceBy` → `payerId` → `lineId`）で分ける（集金するメンバー以外の立替は相手の分）。結果の `advanceCount` / `targetAdvanced` / `counterpartAdvanced` が件数と各人の立替の合計。有効メンバーが 2 人でない（`not_two_members`）か集金するメンバー未指定（`no_target`）なら出さない。記録は残さない
- テスト: 純関数は `bot/scripts/smoke-household-api.js` / `smoke-recurring.js`（`npm -w bot test`）、web 側は `web/__tests__/periodSplit.test.mjs` / `renewal-logic.test.mjs`（`npm -w web test`）。ルーター・認証・Firestore を通した確認は `bot/scripts/emulator-household-api.js` / `emulator-recurring.js` / `emulator-settlement-summary.js`（`npm -w bot run test:emulator`。`bot/scripts/firebase.emulator.json` のポート 18080 / 19099 で Firestore・Auth エミュレータを起動する。firebase-tools は依存に入れていないので、別途入れて PATH に置く）

---

## 6. データモデル（Firestore）

| コレクション | 主なフィールド | 備考 |
|---|---|---|
| `expenses` | `lineId`, `appUid?`, `groupId?`, `lineGroupId?`, `amount`, `description`, `date`(YYYY-MM-DD), `category`, `confirmed`, `includeInTotal`, `status`(`pending\|shared\|personal\|advance_pending\|advance_settled`。`advance_*` は以前の立替の値で、新しくは作られない), `inputSource`(`line_text\|gmail_auto\|recurring`。`line_ocr` は OCR 廃止に伴う**レガシー値**で既存データにのみ存在), `payerId`, `payerDisplayName`, `paymentMethod`, `advanceBy?`, `advanceSettledAt?`, `gmailMessageId?`, `usedAt?`, `recurringId?`, `receiptUrl?`, `needsEdit?`（**レガシー**。書き込み・読み出しとも廃止済みで既存データにのみ存在）, `items?[]`, `ocrText?`（レガシー）, `createdAt`, `updatedAt` | 中核コレクション。システムユーザーの `lineId`: Gmail 取込 `gmail-auto-system` / 固定費 `recurring-system`（ルールで世帯メンバーが修正・削除できる） |
| `groups` | `name`, `inviteCode`(8桁・暗号学的乱数。参加には使わない), `createdBy`, `lineGroupId?`, `splitSettings?`(`{ collectFromLineId, updatedBy, updatedAt }`) | 汎用グループ機能はコード上「非推奨」— 実運用は LINE グループ共有。クライアント書込不可 |
| `groupMembers/{groupId}_{lineId}` | `groupId`, `lineId`, `displayName`, `isActive`, `joinedAt`, `leftAt?`, `deactivatedReason?` | `isActive == true` が Web アクセス権。LINE グループ退出（`memberLeft`）で bot が `false` にする。発言による自動追加はしない（世帯2名固定、追加は管理スクリプト）。クライアント書込不可 |
| `recurringExpenses` | `groupId`, `name`, `amount`, `category`, `dayOfMonth`, `payment`(`shared\|advance`), `payerLineId`, `active`, `lastPostedMonth`, `startDate`, `createdBy`, `createdAt`, `updatedAt` | 固定費の項目（§3.3）。クライアントからは読み書き不可（`/household/recurring` 経由） |
| `userSettings/{lineId}` | `defaultCategory?`, `dateSettings` | 集計期間設定も格納。本人のみ read/write |
| `budgetSettings/{lineId or lineGroupId}` | `monthlyBudget`, `categoryBudgets`, `alertThreshold` | Web が書き、Bot のサマリーも参照。本人のみ read/write |
| `userLinks/{appUid}` | `lineId`（1:1, `firestore.ts`。`/auth/line` が作成）／ `lineIds[]`（1:N, `userLinks.ts`。`syncUserLinks` トリガーは書き込みを停止済み） | **2形式が併存**（§8）。クライアントは本人分の read のみ |
| `linkTokens/{token}` | `lineId`, `expiresAt`(15分), `used` | クライアントからは読み書き不可 |
| `userCustomCategories` | `lineId`, `name`, `icon?`, `keywords?[]` | Bot 専用 |
| `categoryFeedback` | `originalCategory`, `correctedCategory`, `description` | 分類改善用ログ。Bot 専用 |
| `system/{gmailToken,gmailState,oauthState,gmailFailures}` | Gmail OAuth トークン・historyId / watch 期限・CSRF state・処理失敗の記録 | Bot 専用 |
| `system/settlementSummary_{groupId}_{YYYY-MM-DD}` | `groupId`, `endDate`, `createdAt`, `sentAt`, `manualSentAt?` | 期間の精算サマリーを送った印（§3.4。同じ期間は 1 回。Web から締まった期間を手動で送ったときも `sentAt`・`manualSentAt` を書く）。Bot 専用 |

複合インデックス: `expenses` の `lineId/groupId/lineGroupId × createdAt/date/status` 組合せ、`groupMembers` の `lineId+isActive` / `groupId+isActive`（`firestore.indexes.json`）。

Storage: `receipts/{expenseId}/{fileName}` — cross-service rules で支出を参照し、個人支出は所有者、グループ支出は有効メンバーだけが get / 書込 / 削除できる（list は不可）。書込は 5MB 以下かつ JPEG / PNG / WebP / HEIC / HEIF のみ。精算済み支出のレシートは上書き・削除不可（`storage.rules`）。運用上の前提（IAM ロール）は `docs/SECURITY_OPERATIONS.md` §4。

---

## 7. 認証・認可モデル

- **Web**: LIFF ログイン。`web/lib/lineAuth.ts` が LIFF の ID トークンを bot の `POST /auth/line` へ送り、LINE の verify API で検証（`aud` = `LINE_LIFF_CHANNEL_ID`）した `sub` を `lineId` クレームに持つ **Firebase カスタムトークン**（`uid` = `appUid`）でサインインする。**URL の `?lineId=` は識別に使わない**（LINE のリンクに付いていても無視される）。未ログインなら LINE ログインへ移り、ログイン後は元のページ（`/attach?expenseId=…` など）へ戻る。LIFF 未設定（ローカル・プレビュー）や失敗時は匿名サインインへフォールバックし、`lineId` クレームが無いためルール上は何も読めない（ゲスト表示）
- **Bot**: LINE webhook 署名検証（`LINE_CHANNEL_SECRET`）。`appUid` は Firebase Auth 匿名ユーザーとして裏で発行。Firestore は Admin SDK で操作しルールをバイパスする
- **Firestore ルール**（`firestore.rules`）: `request.auth.token.lineId` と各文書の `lineId`、および `groupMembers/{groupId}_{lineId}.isActive` で判定。`expenses` は所有者と世帯メンバーが読め、create / update / delete はフィールド許可リストと値の検証付き（`status` / `advanceBy` / `inputSource` / `groupId` などはクライアント不変、精算済みは金額・日付・支払者の変更と削除不可）。`groups` / `groupMembers` / `userLinks` / `linkTokens` はクライアント書込不可、`userSettings` / `budgetSettings` は本人のみ、未定義パスは既定拒否。要点は `docs/SECURITY_OPERATIONS.md` §3
- **Storage ルール**（`storage.rules`）: §6 の記載どおり。cross-service rules の IAM 前提は `docs/SECURITY_OPERATIONS.md` §4
- **Web 向け API**: §5.4 の ID トークン認証＋メンバー判定。Gmail 管理 API は `ADMIN_SECRET`
- **世帯メンバー管理**: 2 名固定。追加・無効化は `scripts/manage-group-members.mjs`（`docs/SECURITY_OPERATIONS.md` §1–2）

残っているセキュリティ上の課題（LINE postback でのメンバーシップ未確認、脱退者による自分の登録分の読み取り、トークン付き `receiptUrl` など）は `docs/SECURITY_OPERATIONS.md` §6 に集約している。

---

## 8. 既知の不整合・技術的負債

1. **`userLinks` の 2 形式併存**: `lineId`（1:1）と `lineIds[]`（1:N）。`syncUserLinks` トリガーは何もしない関数として残置（削除は手動 `firebase functions:delete`）、`userLinks.ts` と `firestore.ts` の `joinGroup()` は呼び出し元が無い
2. **ビルド時の型チェックを無効化**: `web/next.config.ts` は `typescript.ignoreBuildErrors: true`。CI の `lint` ジョブも ESLint / `tsc --noEmit` の失敗を警告扱いにしており（`|| echo ::warning`）、型エラーでは落ちない。テストは `build-and-test` ジョブで実行され、失敗すれば落ちる
3. **セキュリティ上の残課題**は `docs/SECURITY_OPERATIONS.md` §6 を参照

---

## 9. 環境変数一覧

### Bot（Firebase Functions secrets / `bot/.env`）

| 変数 | 用途 |
|---|---|
| `LINE_CHANNEL_TOKEN` / `LINE_CHANNEL_SECRET` | LINE Messaging API |
| `LINE_LIFF_CHANNEL_ID` | `/auth/line` での LIFF ID トークン検証（`aud`） |
| `WEB_ORIGINS` | `/auth/line` と `/household` の CORS 許可オリジン（任意。既定は本番 Vercel と localhost） |
| `GEMINI_API_KEY` | カテゴリ分類・フィードバック解析 |
| `FIREBASE_PROJECT_ID` | 既定 `line-kakeibo-0410` |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` | Gmail OAuth |
| `DEFAULT_GROUP_ID` / `LINE_GROUP_ID` | Gmail 自動登録・通知先 |
| `ADMIN_SECRET` | Gmail 管理 API 認証 |
| `GITHUB_TOKEN` | フィードバック Issue 起票 |
| `GOOGLE_APPLICATION_CREDENTIALS` | Firebase Admin 認証（ローカルのみ JSON パス。本番は ADC） |

### Web（Vercel, すべてクライアント公開）

`NEXT_PUBLIC_FIREBASE_API_KEY` / `APP_ID` / `AUTH_DOMAIN` / `PROJECT_ID` / `STORAGE_BUCKET` / `MESSAGING_SENDER_ID` / `MEASUREMENT_ID`、LIFF ログイン用 `NEXT_PUBLIC_LIFF_ID` / `NEXT_PUBLIC_AUTH_ENDPOINT`（`api` 関数の `/auth/line`）/ `NEXT_PUBLIC_API_BASE`（任意。未設定なら `AUTH_ENDPOINT` から導出）、開発用フラグ `NEXT_PUBLIC_USE_FIREBASE_EMULATOR`（`NODE_ENV=development` のときだけ有効。`web/lib/firebase.ts`）
