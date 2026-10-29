# LINE家計簿（ぶちこむ家計簿）機能仕様書

最終更新: 2026-10-24（コードベース実装準拠）

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
| `家計簿` | 当月サマリーの Flex メッセージを返信（予算プログレスバー・カテゴリ別・直近支出）。カテゴリ別は正準名にまとめて数える（`getMonthlyGroupSummary`。`toCanonicalCategoryName` で、正準名・エイリアスと完全一致した名前だけを揃える: 旧名の `娯楽費` `交際費` `趣味`→`娯楽`、`投資` `貯蓄`→`貯金` など。それ以外の名前〔カスタム名など〕は別の行のまま、空・文字列でないものは `その他`。#243）。1 対 1 のトーク（`source.type: user`）なら送った本人の支出（`lineId` で引く。所属は確かめない）の集計、グループトークならグループ集計（`lineGroupId` で引く）。**グループ集計を返すのは、発言元の LINE グループに紐づくグループ（`groups.lineGroupId` が一致）がちょうど 1 つで、送った人がその有効メンバー（`groupMembers/{groupId}_{lineId}`）のときだけ**（`isHouseholdMember` と同じ考え方。支出が世帯の支出になる条件と同じ。#271）。メンバーでない人（脱退済み・世帯外・`userId` の無い発言）、紐づくグループが無い・2 つ以上ある LINE グループ、複数人トーク（room）・未知の種類のトークには「家計簿の集計を表示できるのは、世帯のメンバーだけです。」と Web のリンク（ID なし）だけを返し、支出も予算も読まない。所属の確認に失敗・タイムアウトしたときも集計を返さない（確認できなかった旨と Web のリンク）。拒否の返信に失敗しても別の文は送らない。所属の確認と集計の取得をあわせて 8 秒でタイムアウトし、集計の取得に失敗・タイムアウトしたときはテキストにフォールバック（集計は含まない。リンクは ID なし） |
| `カテゴリー` | 有効カテゴリ一覧と現在のデフォルトカテゴリを表示 |
| `カテゴリー <名前>` | デフォルトカテゴリを設定（`userSettings`）。選べるのは一覧の名前（`医療費` など）で、保存は正準名（`医療・健康`。§2.2 のカテゴリと同じ揃え方）。そのため、新しく設定した既定は `カテゴリー` の「現在のデフォルト」に正準名で出る（以前に設定した旧名は旧名のまま出る。支出の登録では正準名に揃えて使う） |
| `グループ作成 <名前>` | グループ作成（作成者のみがメンバー。招待コードは内部互換のため生成するが表示しない） |
| `参加 <コード> <表示名>` | **無効化済み**。世帯は2名固定で、メンバー追加は管理者が `scripts/manage-group-members.mjs` で行う旨を返信 |
| `グループ一覧` | 所属グループ一覧 |
| `立替一覧` / `立替` / `精算` | 一覧も精算の記録もしない。案内を返す（精算は期間の精算（折半）にまとめていること・相手の分を立て替えたら支出カードの［自分が立替］を押すと、その支出の日付の期間の精算に全額を加算すること・精算額は毎月の起算日に世帯の LINE グループへ通知すること・Web の精算画面のリンク。`line/commands/advance.ts`） |
| `要望 / 改善 / 不具合 / フィードバック <本文>` | Gemini で内容を解析し GitHub Issue を自動起票（公開リポジトリ `Makoto041/line-kakeibo`）。**使えるのは `DEFAULT_GROUP_ID` の世帯グループの有効メンバーだけ**（#260。`groupMembers/{DEFAULT_GROUP_ID}_{userId}` を `readActiveMember` で読む。LINE の postback の認可と同じ判定。どのトーク〔1 対 1・LINE グループ・複数人トーク〕から送っても同じ。読み取りは 1 回で、キャッシュしない）。次のときは Gemini も GitHub も呼ばず、短い返信だけを返す: 世帯の有効メンバーでない（「このコマンドを使えるのは、世帯のメンバーだけです。」）、`DEFAULT_GROUP_ID` が未設定・空、所属の確認に失敗した（Firestore の障害。拒否側に倒す）、送った人の userId が無い、本文が 1,000 文字（コードポイント。絵文字も 1 文字）を超える（切らずに「内容が長すぎます」）、同じ人が 10 分に 3 件を超えた（受け付けた件数だけを数える。関数のインスタンスごとのメモリで数える）。本文が空なら使い方を返す。使い方と作成できたときの返信に、公開リポジトリに載るので個人情報を書かないよう注意を付ける。Issue の元の本文はコードブロックに入れ、Gemini の結果はメンション・参照・HTML・リンクを無効にして（角括弧をエスケープし、リンク・画像・参照定義の構文を成立させない）長さを切る（SECURITY_OPERATIONS.md §8。`line/commands/feedback.ts`・`issueCreator.ts`） |
| その他のテキスト | 支出テキストとしてパース（§2.2）。金額が取れない場合は**無反応**（誤爆防止） |

グループイベント: メンバー参加（`memberJoined`）は案内メッセージを push するだけで**メンバー登録はしない**。退出（`memberLeft`）はその人の `groupMembers` を `isActive:false` にする。bot 自身の退出（`leave`）ではメンバーシップを変えない。

### 2.2 支出テキスト入力フォーマット（`bot/src/textParser.ts`）

トークンは空白（半角/全角）区切り。順不同。

| 要素 | 書式 | 必須 | 例 |
|---|---|---|---|
| 金額 | `^\d+円?$`（カンマ許容） | ✅ | `500` `1,200円` |
| 日付 | `YYYY-MM-DD` / `M/D` / `MM/DD` / `M月D日` | −（省略時は当日） | `6/29` `6月29日` |
| 支払方法 | 現金/げんきん/キャッシュ→`cash`、paypay/ペイペイ→`paypay`、カード/クレカ/クレジット→`card` | −（省略時 `unknown`） | `現金` |
| カテゴリ | `textParser.ts` の `VALID_CATEGORIES` と完全一致したときだけ、分類より優先して使う（§2.3参照）。正準19カテゴリとは別のリストで、`娯楽費` `衣服費` `医療費` `教育費` `貯蓄` `投資` `趣味` `交際費` などを含み、`娯楽` `衣服` `医療・健康` `教育` `サブスク` `旅行` `プレゼント` `貯金` は含まない。保存するときは正準名に揃える（`toCanonicalCategoryName`。正準名かエイリアスと完全一致したときだけ: `医療費`→`医療・健康`、`娯楽費` `交際費` `趣味`→`娯楽`、`衣服費`→`衣服`、`教育費`→`教育`、`投資` `貯蓄`→`貯金`。一覧の名前はすべて正準名になる。`趣味` `貯蓄` を揃えるのは #243 から。それより前に旧名のまま保存された支出は移行しない。Web の表示・集計（`normalizeCategoryName`。§5.1 の `/`）と、LINE の `家計簿`・精算の通知のカテゴリ別（`toCanonicalCategoryName`。§2.1・§3.4）では同じ正準名に入る） | − | `食費` |
| 摘要 | 残りトークンを結合 | −（省略時 `支出`） | `ランチ` |

入力例: `500 ランチ` / `6/29 4800 家賃` / `1500 現金 ドラッグストア`

> **カテゴリトークンを指定すると、そのカテゴリで登録する**: 登録処理（`processExpenseInBackground`）は `parsed.category` があればそれを使い（旧名は正準名に揃える）、大項目の分類（§4）は呼びません（食費・娯楽の中項目は、辞書で決まらなければ世帯メンバーの入力に限り Jev に聞く。§4.1）。指定が無いときは、分類（辞書 → Jev → Gemini）の結果かユーザーデフォルトからカテゴリを決定します。カテゴリの変更は登録後の「カテゴリ変更」ボタンで行います。

### 2.3 支出登録フロー（`processExpenseInBackground`, `bot/src/line/expenseFlow.ts`)

1. LINE プロフィール取得（リトライ＋15分メモリキャッシュ）
   - 取得に失敗した（表示名が取れなかった）ときは「ユーザー情報の取得に失敗しました」と返して保存しない。その結果はキャッシュに残さず、次の入力で取り直す（個人チャット・LINE グループとも。#261）
2. `appUid` 解決（LINE userId → Firebase Auth 匿名ユーザーを作成/取得。`linkUserResolver.ts`）
3. カテゴリの決定: カテゴリトークン（§2.2）があればそれを使う（指定・既定カテゴリの旧名は正準名に揃える）。無ければカテゴリ分類（§4。辞書 → Jev → Gemini）とユーザーデフォルトカテゴリを並列取得し、分類結果の確信度 ≥ 0.4 なら採用（辞書・Jev・Gemini のどれで決まっても同じ閾値）、なければデフォルト、それも無ければ `その他`。カードに出す判定元（§2.4）も一緒に決める（`decideTextExpenseCategory`）
   - **Jev・Gemini を呼ぶのは世帯メンバーの入力だけ**（費用・無料枠の保護。#245。手順 3 の最後の中項目の Jev も同じ。カテゴリを指定した入力でも、メンバーでなければ中項目を Jev に聞かない）: 世帯メンバー = LINE グループに紐づく世帯（`groups.lineGroupId` を持つグループ）の有効メンバー。LINE グループでの発言は、発言元の LINE グループに紐づく世帯のメンバーに限る（手順 4 で世帯の支出になる条件と同じ）。「グループ作成」で作った自分だけのグループ（`lineGroupId` なし）のメンバーは含めない（`expenseGroupScope.ts` の `isHouseholdMember`）
   - メンバーでなければ辞書だけで判定し、決まらなければデフォルト、それも無ければ `その他`（Jev・Gemini が使えないときと同じ。判定元は `辞書` / `既定` / `未判定`）。判定には手順 4 のために読む所属グループを使い、Firestore の読み取りは増やさない
   - 所属の確認（`getUserGroups` / `findLineGroupId`）自体が失敗したときは、メンバーの入力を辞書だけにしないようモデルを呼ぶ（メンバーでない人は Firestore の失敗を起こせない）。個人チャットではこの失敗をプロフィールのキャッシュ（15 分）に残さず、次の入力で読み直す
   - プロフィールのキャッシュの期限は取得した時点から 15 分で、キャッシュに当たっても延ばさない。管理スクリプトでの無効化は、個人チャットでは最長 15 分で反映される（LINE グループでの発言は発言ごとに所属を読み直す）
   - 大項目が決まったあと（指定・分類・既定のどの経路でも）、説明文から中項目を決める（§4.1。まず辞書で、時刻は当てない。`textSubCategoryOf`）。辞書で決まらない食費・娯楽は、世帯メンバーの入力なら Jev に聞く（`subCategoryByModel`。大項目を分類して Jev で決まらなかった〔Gemini で決まった・どれでも決まらなかった〕ときは聞かない）。判定元には影響しない
4. グループ所属の決定（`expenseGroupScope.ts`）: 発言元の LINE グループに紐づく世帯（`groups.lineGroupId` が一致）の有効メンバーなら `groupId` と `lineGroupId` を付ける。それ以外（第三者・脱退済み・紐づく世帯なし）は**どちらも付けず個人支出**として保存し、Web 一覧にも LINE の集計・精算にも入れない
5. `expenses` に保存（`confirmed: false`, `includeInTotal: false`, `inputSource: 'line_text'`。`subCategory` は中項目が決まったときだけ付ける）
6. 確認用 Flex メッセージを送信（§2.4 の登録・編集カード）

### 2.4 登録・編集カードの構成（`bot/src/line/flexMessage.ts`）

テキスト入力・Gmail カード利用の両方で同じビルダー（`buildExpenseCard`）を使い、ヘッダー文言と金額下の補足行だけを差し替える。**現在の設定値はリッチテキストで表示し、ボタンは変更操作だけを担う**。

```text
現在の設定
[users]      支出区分：共同費　　　　[変更]
[wallet]     支払った人：誠　　　　　[自分が払った]
[hand-coins] 立替：なし（折半）　　　[自分が立替]
[食費]       カテゴリ：食費 › 昼ご飯（辞書）　[変更]
```

| 領域 | 内容 |
|---|---|
| ヘッダー | テキスト入力=「支出を登録しました」/ カード利用=「カード利用を記録」 |
| 本文 | 店舗名・説明 → 金額と日付 → （残り予算 / 支払い方法）→ 「現在の設定」4行。支払った人は金額の下ではなく「現在の設定」に出す |
| フッター | `OK` `修正` / `レシート添付` / `家計簿一覧を見る` |

各行の先頭にはアイコンを置く。支出区分は共同費系が `users`・個人費/未設定が `user`、支払った人は `wallet`（支払った人がカードのときは `credit-card`）、立替は `hand-coins`、カテゴリは `categoryIconUrl()` が返すカテゴリ別アイコン（未知のカテゴリは `cat-other`）。値をボタンで並べていた頃と同じ絵柄を使い、表示だけになっても見た目の手がかりが減らないようにする。

**中項目**（#235。§4.1）: カテゴリの行に、大項目に続けて「食費 › 昼ご飯」の形で出す（区切りの ` › ` は灰色・太字なし、中項目は大項目と同じ太字）。行は 4 行のまま増やさず、長い中項目（「デリバリー・テイクアウト」など）は行の中で折り返す。

- 出すのは、大項目の中項目の一覧（`SUB_CATEGORIES`。大項目は正準名で引く）にある値だけ。中項目が無い・空・一覧に無い値（Web で入れた自由な値や、別の大項目の中項目）と、一覧の無い大項目（日用品など）では、今までどおり大項目だけを出す（例: 食費（Jev））。カードに出す文字列は固定の一覧の語だけになる
- 判定元の注記は大項目についてのもので、中項目の後ろ（行の最後）に付く（例: 食費 › 昼ご飯（辞書））。最初のカードだけに出るのは変わらない
- 値は保存した `subCategory` を使う（テキスト入力の登録カード・Gmail のカード利用通知は保存した値、postback で作り直したカードは文書の値）。`set_category`（§2.5）の返信は決め直した中項目を出し、決まらず消したときは大項目だけを出す
- LINE から変えられるのは大項目だけ。中項目は postback の data にも altText にも入れない

**カテゴリの判定元**: 最初に送るカード（テキスト入力の登録カードと Gmail のカード利用通知）だけ、カテゴリの後ろに、カテゴリがどこで決まったかを全角括弧で小さく（灰色・太字なし）出す。文言は `CATEGORY_ORIGIN_LABELS`（`flexMessage.ts`）の 1 か所で決める。

| 表示 | 意味 |
|---|---|
| （辞書） | キーワード辞書で決まった |
| （Jev） | Jev で決まった |
| （Gemini） | Jev が失敗し、Gemini で決まった |
| （指定） | 入力でカテゴリを指定した（例: `500 食費`。§2.2） |
| （既定） | 分類で決まらず、利用者の既定カテゴリを使った（テキスト入力だけ） |
| （未判定） | 分類で決まらず「その他」にした |

- 判定元は保存しない（Firestore のスキーマは変えない）。postback で作り直したカード（`buildExpenseCardFromRecord`）には出ない。LINE グループに届くカード（グループでの入力と Gmail の通知）では、世帯のもう一人にも見える
- 分類の結果をキャッシュから使ったときは、最初に決まったときの判定元を出す
- テキスト入力で確信度が 0.4 未満だったときは、既定カテゴリがあれば（既定）、無ければ（未判定）。分類が「その他」を返したときは、既定カテゴリがあればそれに上書きして（既定）、無ければ分類の判定元（例: その他（Jev））のまま
- Gmail のカード利用通知は確信度に関係なく分類の結果を使い、既定カテゴリも使わない。決まらなければ その他（未判定）

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
| `advance_settled` | 以前の立替の精算・全額にする前の立替を精算済みにしたもの | 共同費 | 精算済み |

`advance_settled` のカードには支出区分・支払った人・立替のボタンを出さない（カテゴリのみ変更可）。

### 2.5 Postback アクション（`bot/src/line/postback.ts`）

支出区分・立替のボタンにはトグル（反転）ではなく**設定する値そのもの**を埋め込む（`to`）。カード描画時点の現在値の反対が入っているため、古いカードから押しても表示どおりの結果になる。

| アクション | 効果 |
|---|---|
| `set_split`（`to: shared \| personal`） | `status` を設定し `includeInTotal` を連動（`shared`=true / `personal`=false）。立替は解除（`advanceBy` / `advanceFull` を削除）。あわせて `confirmed: true`。押せるのは世帯の有効メンバーだけ |
| `set_payer`（自分が払った） | `payerId` / `payerDisplayName` を押下者にし、`confirmed: true`。未確認（status なし / `pending`）は `status: 'shared'`・`includeInTotal: true` へ昇格。立替（`advance_pending`）は立替のまま、`advanceBy` も押下者にする（払った人と立て替えた人は同じ）。`personal` は `personal` のまま |
| `set_advance`（`to: on \| off`） | on（自分が立替）= `status: 'advance_pending'`・`advanceFull: true`・`advanceBy` / `payerId` / `payerDisplayName` に押下者・`includeInTotal: true`・`confirmed: true`（除外からでも立替になる）/ off（取り消す）= `status: 'shared'`・`includeInTotal: true`・`confirmed: true`・`advanceBy` / `advanceFull` を削除（支払った人は変えないので、折半で支払った人の分になる）。立替でない支出の off は「立替ではないため、変更はありません」 |
| `confirm`（OK） | `confirmed: true`。**`pending` のときだけ** `status: 'shared'`・`includeInTotal: true` へ昇格（設定済みの支出を共同費へ巻き戻さない）。押せるのは世帯の有効メンバーだけ |
| `edit`（修正） | 押下者の `lineId` を含む Web 編集 URL（`/expenses?edit=<id>&lineId=...`）を返信。**押す人が分かっているカードでは「修正」は URI ボタンで直接 Web を開く**ため、この postback へ来るのは Gmail 通知と配信済みの古いカードだけ |
| `show_category_select` / `set_category` | カテゴリ選択カルーセルを表示 / カテゴリを更新（`decideSetCategory`）。どちらも押せるのは世帯の有効メンバーだけ（カルーセルもメンバーにだけ返す）。**受け付けるカテゴリ**: `category` は 32 文字以内の文字列で、正準名（19 種）か、正準名に揃えられる名前（カルーセルの `医療費` や、LINE の入力の `趣味` `貯蓄` など）だけ（`toSelectableCategoryName`）。それ以外（文字列以外・一覧に無い名前・長すぎる値）は「このカテゴリには変更できません」と返して保存しない。カルーセルの選択肢は `医療費` などの名前のまま、保存は正準名（§2.2 のカテゴリと同じ揃え方）。「選択中」も正準名どうしで比べる（旧名 `趣味` のまま保存された支出では `娯楽費` が選択中）。**中項目（`subCategory`）**: 大項目が正準名どうしで同じなら触らない。変わるときは辞書と時刻のルール（`resolveSubCategory`。モデルは呼ばない）で決め直し、決まらなければ削除する（**大項目を変えても Jev には聞き直さない**。登録時〔§4.1〕と違い、辞書で決まらなければ中項目なし。決め直しはトランザクションの中で同期に行う）。説明文を辞書に当て、時刻（朝・昼・夜ご飯）は Gmail 取込（`inputSource: 'gmail_auto'`）の飲食店で、保存済みの `usedAt` に時刻があるときだけ当てる（JST の 00:00:00.000 ちょうどは時刻なしとみなす）。制限: 日時の無いカード利用通知は、処理した時刻が `usedAt` に入るため、大項目を変え直したときの時刻ルールは、その処理時刻で判定される（登録時は、日時の無いメールには時刻ルールを当てないため、結果が食い違いうる。件数はごく少ない）。判定に失敗しても大項目は変え、中項目は削除する。postback に中項目が入っていても使わない。返信カードのカテゴリの行には、決め直した中項目を出す（決まらなければ大項目だけ。§2.4） |
| `show_list` | 押下者の `lineId` を含む家計簿一覧 URL を返す |
| `shared` / `personal` / `advance`（旧 UI） | 配信済みカードからの押下に備えて `set_split` / `set_advance`（`advance` は［自分が立替］）へ読み替える |

**押せる人**: `set_split`・`set_payer`・`set_advance`（on / off）・`confirm`・`set_category`・`show_category_select` と旧UIの `shared` / `personal` / `advance` は、期間の精算の金額や集計が変わるため（OK とカテゴリの変更は未確認の支出を共同費にする）、押せるのは支出の世帯（`groupId`）の有効メンバーだけ（`groupId` の無い個人の支出は登録した本人だけ、`lineGroupId` だけを持つ旧形式は不可。それ以外は「変更できるのは、世帯のメンバーだけです」。押した人の `userId` が無ければ「押した人を特定できなかったため、変更できませんでした」）。表示名はメンバー文書の名前 → LINE のプロフィール名 → `User_xxxxxx`。

**入力の形式**: postback の `expenseId` は、最初に Firestore の文書 ID として安全な文字列か（`isValidDocId`。`/household` API と同じ判定。1〜128 文字・`/` を含まない・`.` `..` `__…__` ではない）を確かめ、不正なら何もしない（Firestore も LINE も呼ばず、返信もしない）。`show_category_select` の `source` は `gmail` / `text` の許可リストで、それ以外は `gmail` としてカルーセルのボタンに埋め込む。ログには postback の値を書式文字列で埋め込まず、支出 ID は伏せる（不明な `action` は型だけを出す）。世帯のメンバーでない人が押したときは、`Postback rejected: the presser is not a member of the household` を warn に出す（押した人・支出の ID は伏せ、`action` は既知の名前だけ。それ以外は `unknown`）。不正な postback のログには押した人（伏せた ID）だけを出し、例外のログ（`Postback processing error`）には `action`（同じ許可リスト）を添える。

**矛盾の解消**: 個人費（除外）にすると立替は解除され、立替にすると支出区分は共同費相当に揃う（除外かつ立替は成立しない）。`advance_settled` の支出に対する**支出区分・支払った人・立替の変更**はサーバー側で拒否する（「精算済みのため変更できません」。古いカードにボタンが残っているため、表示を消すだけでは足りない）。カテゴリ変更は精算後も可能（精算額に影響しないため）。

**変更後の再表示**: LINE は送信済みメッセージを編集できないため、状態を変えたら最新値のカードを `replyToken` で返信する（`buildExpenseCardFromRecord()`）。登録直後のカードと同じビルダーを通すので表現がぶれない。

**同時操作**: グループトークでは複数人が同時にボタンを押せるため、読み取り・判定・更新は `runTransaction` で1トランザクションにまとめる（`applyExpenseChange()`。OK・支払った人・立替・取り消しの判定 `decideConfirm()` / `decideSetPayer()` / `decideSetAdvance()` / `decideClearAdvance()` とともに `bot/src/expenseActions.ts` にあり、Web の確認と以前の立替を精算済みにする操作（§5.4。`decideSettleLegacyAdvance()`）も同じ仕組みを使う。支出を変える postback のメンバー確認も同じトランザクション内で読む）。分離していると、誰かが個人費にした直後に別の人の OK が古い `pending` を読んで共同費へ巻き戻したり、精算済み判定をすり抜けて変更が通ったりする。

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
- フロー: 新着メール → `gmailPubSubHandler` → history API で差分取得 → SMBC 利用通知をフィルタ → `gmail/parser.ts` で「利用先・金額・利用日時」と、メールに時刻が書かれていたか（`usedAtHasTime`。§4.1）を抽出 → カテゴリ分類（§4。Jev → Gemini → 辞書。確信度に関係なく採用）→ 中項目の判定（§4.1。店名の辞書 `merchantSubCategoryOf` → 決まらない食費・娯楽は Jev〔大項目が Jev で決まったときだけ〕）→ **アトミック保存**（`gmailMessageId` に加え、`date+amount` が同じ `gmail_auto` 支出のうち店舗名が類似し `usedAt` が ±1 分のものを重複として弾く。`firestore.ts` の `saveGmailExpenseAtomic`）→ LINE グループへ Flex 通知（§2.4 の登録・編集カード。現在の設定 4 行＋ボタン）
- 通知の送り直し: 保存と同じトランザクションで送信待ちの印（`system/gmailCardNotice_{messageId}`）を作り、送れたら消す。push の失敗や保存と push の間の中断で印が残ったら、同じメールの再処理（Pub/Sub の再送・`/gmail/force-process/:messageId`）で保存時点のカードを送り直す。メッセージから決まる `X-Line-Retry-Key` を付けて二重に届かないようにし（409 は送れた扱い）、key が効く 24 時間に収まるよう 23 時間を過ぎた印は送らずに消す。印の無い既存の支出には送らない（`gmail/cardNotice.ts`。詳細は [GMAIL_AUTO_SPEC.md](./GMAIL_AUTO_SPEC.md) §3.2）
- 保存フィールド: `lineId`/`payerId` はシステムユーザー `gmail-auto-system`、`inputSource: 'gmail_auto'`, `status: 'shared'`, `confirmed: true`（自動で入るので要確認にしない）, `includeInTotal: true`, `usedAt`（カード利用日時）、`groupId`（`DEFAULT_GROUP_ID`）/ `lineGroupId`（`LINE_GROUP_ID`）、`subCategory`（中項目が決まったときだけ。手動処理の `/gmail/process-latest`・`/gmail/force-process/:messageId` でも同じ）
- 失敗時: 1 通でも処理に失敗したら `historyId` を進めずに投げ、Pub/Sub の再送（`gmailPubSubHandler` の `retry: true`。10〜600 秒の間隔で最大 24 時間）で同じ範囲をやり直す。同じメッセージが試行 3 回以上 **かつ** 最初の失敗から 6 時間以上失敗し続けたら、その 1 通は諦めて先へ進む（`system/gmailFailures` の `attempts`・`firstFailedAt`）。消されたメール（`messages.get` の 404）は失敗として数えず読み飛ばす。やり直しても直らない失敗（`historyId` の読めない通知・Gmail のトークンが無い・watch の状態が無い）は投げずに終え、再送させない。12 時間より古い通知は処理せずに捨てる（取込は保存してある `historyId` からの全範囲を処理するので、次の新しい通知で拾われる）。詳細は [GMAIL_AUTO_SPEC.md](./GMAIL_AUTO_SPEC.md) §3.2
- watch は7日で失効するため、**6日ごとの cron**（`renewGmailWatch`）で更新（失敗したら 2 回までやり直す。`retryCount: 2`）
- 管理エンドポイント（`api` function, `/gmail/*`）: OAuth 認可・watch 登録・状態確認・手動処理など。認証は `ADMIN_SECRET` を **`Authorization: Bearer` ヘッダーでのみ**受け付け、定数時間で比較する（`requireAdminAuth`）＋レートリミット（OAuth callback のみ CSRF state 検証）。`?adminSecret=` クエリ渡しはアクセスログ等に秘密値が残るため廃止した。詳細は [GMAIL_AUTO_SPEC.md](./GMAIL_AUTO_SPEC.md)

### 3.2 MoneyForward CSV インポート（廃止）

- 送信先の `/api/mf/import` がリポジトリの履歴上一度も存在せず、送信先の設定（`API_BASE_URL` / `MFKAKEIBO_TOKEN`）も関数に渡していなかったため、機能していなかった。処理は削除済み
- 関数 `importMoneyForward` は、CI の非対話デプロイが本番関数の削除確認で失敗しないよう、何もしない関数として名前だけ残している（ARCHITECTURE.md §3）

### 3.3 固定費の自動計上（`bot/src/recurringExpenses.ts`）

- 項目は Web の設定 > 固定費タブで登録し、`recurringExpenses/{id}` に世帯（`groupId`）ごとに保存する（1 世帯 30 件まで。名前 40 文字・金額 1〜10,000,000 円・引き落とし日 1〜31・正準カテゴリ）。クライアントからは読み書きできず、`/household/recurring` の CRUD（§5.4）を通す
- `postRecurringExpenses`（cron: 毎日 9:10 JST。§3.4 の精算サマリーと同じ実行）が、有効（`active`）な項目のうち当月の引き落とし日（`dayOfMonth`。月の日数を超える日はその月の末日）を迎えたものを `expenses` に計上する。文書 ID を `recurring_{項目ID}_{YYYYMM}` に固定して create するため、同じ月に 2 回は入らない。`lastPostedMonth` に計上した月を記録し、作成日（`startDate`）より前の引き落とし日の分と、停止→再開時に当月の引き落とし日を過ぎていた分は遡らない
- 計上する明細: `inputSource: 'recurring'`, `recurringId`, `confirmed: true`, `includeInTotal: true`, `groupId`（＋世帯の `lineGroupId`）、金額は設定した見込み額（請求確定後は明細側を直す）
  - 支払い元 `shared`（共通のカード・口座）: `lineId`/`payerId` = `recurring-system`、`status: 'shared'`
  - 支払い元 `advance`（メンバーの個人口座）: `lineId`/`payerId`/`payerDisplayName`（`userDisplayName` も）= その人、`status: 'shared'`。`advanceBy` は付けない。期間の精算（折半）でその人の支払いとして数える（例: 家賃。共同費なので立替〔全額〕にはせず折半する）。値の名前 `advance` は以前の「立替」のなごりで、保存する値は変えていない。Web の表示は「個人の口座」、一覧では「<名前>の口座」
- LINE への通知は送らない。カード利用通知メールで自動登録される支出を固定費に登録すると二重になる（画面で案内）
- テスト: 純関数は `bot/scripts/smoke-recurring.js`（`npm -w bot test`）、API と計上は `bot/scripts/emulator-recurring.js`（`npm -w bot run test:emulator`）

### 3.4 期間の精算サマリー（`bot/src/settlementSummary.ts` / `line/settlementSummaryMessage.ts`）

毎月、期間が締まった翌日（期間の起算日）に、Web の「期間の精算（折半）」と同じ内容を LINE グループへ送る。

- **いつ**: 毎日の `postRecurringExpenses`（9:10 JST）の中で判定し、今日が起算日なら送る。起算日は集金するメンバーの期間設定（`userSettings/{lineId}.dateSettings.customStartDay`。無ければ相手の設定、どちらも無ければ 1 日）。例: 15日起算なら 10/15 に 9/15〜10/14 の分。固定期間（`mode: 'custom'`）では送らない。Cloud Scheduler の無料枠（3 ジョブ）を使い切っているため、スケジュールは増やさない
- **対象**: `groups` のうち `lineGroupId` があり、集金するメンバー（`splitSettings.collectFromLineId`）が決まっていて、有効メンバーがちょうど 2 人の世帯
- **計算**: `bot/src/periodSplit.ts`（Web の `web/lib/periodSplit.ts` と同じ式。`smoke-settlement-summary.js` が同じ入力で両方の結果を突き合わせる）
- **メッセージ**（1 回の push に 2 通。LINE の通数は受け取る人数で数えるので、2 人の世帯で月 2 通）
  1. テキスト（`textV2`）: 送金する人と受け取る人をメンション（「9/15〜10/14 の精算（折半）です。@光麦 から @誠 へ ¥159,794 の送金をお願いします。」）。送金なしのときは 2 人をメンションして「今回は送金なし」
  2. Flex: 送金額、内訳（合計・1 人あたり・集金するメンバーの支払い、立替（全額）があれば「+ 相手の立替（全額）」「− 集金するメンバーの立替（全額）」、相手とカード・共通口座の支払い）、カテゴリ別の上位 5 つ（割合のバー。残りは「ほか」。立替（全額）は合計・カテゴリ別に入れない。カテゴリは `家計簿` コマンド〔§2.1〕と同じく `toCanonicalCategoryName` で正準名にまとめて数える〔旧名の `娯楽費` と `娯楽` は 1 行。完全一致しない名前は別の行のまま〕。精算額は変わらない。#243）、要確認の件数（手入力で未確認。合計に入っていない）、「精算を開く」「支出を見る」ボタン
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

分類は**世帯の確定ルール**・キャッシュ・キーワード辞書・Jev・Gemini を組み合わせる（`bot/src/geminiCategoryClassifier.ts`）。モデルは Jev（TypeSafe AI）がメインで、Gemini は Jev が失敗したときだけ使う。**どの入力でも、世帯の確定ルール（下の「世帯のカテゴリのルール」）が一番先**で、当たればモデルも辞書も呼ばずにそのカテゴリにする（判定元は `rule`。確信度 1）。入力の種類で、その後の順序が違う:

| 入力 | 順序 | 理由 |
|---|---|---|
| LINE のテキスト（`source: 'text'`） | 分類結果キャッシュ（15分）→ キーワード辞書（確信度 0.8）→ Jev → Gemini。**世帯メンバーでない送信者は辞書まで**（§2.3） | 「ランチ」のような短い日本語は辞書でほぼ決まり、API を呼ばずに済む |
| カード利用通知の店名（`source: 'merchant'`、Gmail 取込） | 分類結果キャッシュ → **Jev → Gemini** → キーワード辞書（どちらも使えないときだけ） | 店名は半角カナ・ローマ字・略称が多く、部分一致の辞書は取り違えやすい（例: `au` `gu` `etc` `sim` `パン` が店名の一部に一致する） |

- **世帯のカテゴリのルール**（`bot/src/categoryRules.ts`。`groups/{groupId}.categoryRules`。Web の設定「カテゴリ」で編集〔§5.1〕。世帯のふたりで共有）: 「この場合はこのカテゴリにしたい」という要望のために、利用者が決める。
  - **確定ルール** `rules`（`{ keyword, category }` の並び。最大 50 件・言葉は 2〜30 文字。英数字だけの言葉は 3 文字から〔`au` `gu` のような短い言葉は店名の一部に当たって誤爆するため〕）: 内容に言葉が含まれたら（全角・半角、大文字・小文字、空白を区別しない部分一致）、上から順に最初に当たったカテゴリにする。LINE の入力にもカード利用メールの店名にも効き、モデルを呼ばない送信者（世帯メンバーでない人）でも、世帯が分かる場合は効く。カテゴリを入力で指定した場合（§2.3）は、そちらが先
  - **AI へ伝える例** `examples`（カテゴリ名 → 例の並び。1 カテゴリ 5 件・1 件 40 文字まで）: Jev の選択肢の説明の末尾と Gemini のプロンプトのカテゴリ一覧に「この家計では次もこのカテゴリ: 「…」」の形で足す。AI が参考にするだけで、従うとは限らない
  - カテゴリは正準 19 種の名前だけ。文字は、見えない文字（ゼロ幅・双方向制御などの書式文字、対にならないサロゲート）と引用に使う「」を取り除き、制御文字・改行を空白に直す。上限を超える入力と短すぎる言葉は丸めずに断る（400）。ふたりの同時編集で後の保存が先の保存を黙って消さないよう、保存は読んだときの版（`version`＝更新時刻のミリ秒。保存したことがなければ 0）を `expectedVersion` で送り、今の版と違えば 409 `stale` で断る（トランザクションで確かめて書く）。ルールは読み込みを 60 秒キャッシュし（保存したインスタンスは即座に捨てる。ほかのインスタンスは最大 60 秒遅れる）、読めなかったときはルール無しで分類を続ける。分類結果のキャッシュのキーにルールの版を入れ、変えたらすぐ効く
  - 世帯の ID は、LINE の入力では所属する世帯（`activeGroup`）、Gmail 取込では `DEFAULT_GROUP_ID`。世帯が分からない入力にはルールを使わない
- **Jev**（`bot/src/jevCategoryClassifier.ts`、`@typesafe-ai/sdk`）: System One の `choice` 質問で、カテゴリ一覧（利用者のカスタムカテゴリを含む）から 1 つ選ばせる。選択肢の説明は Gemini と同じ判断基準（`CATEGORY_GUIDE`）で、食費・娯楽だけ Jev 用に書き足したもの。説明の無いカスタムカテゴリは説明なし（`null`）で渡す。モデルは `jev-1.13.0` に固定、3 秒で打ち切り、再試行なし。Jev・Gemini に送るのは入力・店名の先頭 100 文字だけ（費用・無料枠の消費を抑える）
- Jev が「失敗」したときだけ Gemini に回す。失敗 = 鍵なし（`TYPESAFE_API_KEY` が無い）・エラー・3 秒のタイムアウト・答えなし・選択肢にないカテゴリ。**信頼度が低いだけでは Gemini に回さない**（評価で効果が無かったため）。どちらで決まったかは `Category classified` のログ（`provider`・`source`・`confidence`〔小数 2 桁〕・`ms`。入力・店名は出さない）で見られる
- Jev も Gemini と同じく、LINE のテキストでは確信度 0.4 未満なら採用しない（`expenseFlow.ts`。その場合は利用者の既定カテゴリか「その他」）。店名（Gmail 取込）は確信度に関係なく採用する
- **Gemini（退避先）で使うモデルは Flash-Lite 系だけ**（Flash 系は無料枠から外れるため）。メインは「利用できる Flash-Lite の安定版のうち一番新しいもの」で、モデル一覧 API で調べて 24 時間キャッシュする（上位の Flash-Lite が出れば自動でメインになる）。予備はその次に新しい Flash-Lite。一覧を取れないときは既知の順（`gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`）。`-preview` / `-image` などの派生と Flash（Lite でないもの）は使わない
- メインが終了・提供停止（404、または「deprecated / no longer available」などの 400・403）になったときは予備の Flash-Lite に自動で切り替え、以後 1 時間はそのインスタンスで予備を直接使う。思考レベルを受け付けない 400 のときは思考の設定なしで同じモデルに送り直す。レート制限（429）やスキーマ誤りでは切り替えない
- Gemini は `@google/genai` SDK 経由（`bot/src/geminiClient.ts`）。環境変数 `GEMINI_MODEL` でメインを固定できる（Flash-Lite 以外は無視）。思考は `MINIMAL`（フィードバック解析は `LOW`）、8 秒で打ち切り。SDK の再試行は 1 回に抑え、打ち切り時間を超えないようにしている。`GEMINI_MODEL` に 2.5 系を指定した場合は思考の設定を送らない
- Gemini の応答は構造化出力（JSON スキーマで `category` をカテゴリ一覧の enum に限定）。カテゴリ一覧は Firestore から取得し 30 分キャッシュ（Jev と Gemini で同じ一覧を使う）
- Jev・Gemini の失敗はキャッシュしない（どちらも使えず辞書で決めた店名の結果も、復旧後にモデルで判定し直す）。成功した結果は提供元に関わらずキャッシュする
- 分類の結果は判定元（`provider`: `dictionary` / `jev` / `gemini`）を持ち、キャッシュでも残る。最初のカードの括弧に出す（§2.4）
- 中項目（食費・娯楽）は大項目とは別の段で決める（§4.1。辞書 → 決まらなければ Jev）。大項目の判定はこの段の有無で変わらない

ユーザーの修正は `categoryFeedback` コレクションに記録される。

### 4.1 中項目の判定（#235）

食費・娯楽の支出に、中項目（`subCategory`。一覧は `bot/src/categoryTaxonomy.ts` の `SUB_CATEGORIES`）を付ける。大項目が決まったあとに、まず**辞書と時刻のルール**で決め（`bot/src/subCategoryRules.ts` の `resolveSubCategory`。モデルは呼ばない）、登録時に辞書で決まらなかったときだけ **Jev** に中項目を選ばせる（`bot/src/subCategoryClassifier.ts` の `subCategoryByModel`。例: 辞書に無い店名の「万人力 2950」が食費になったとき、Jev が外食を選べば「食費 › 外食」）。

- **辞書**: 大項目ごとに順番つきの語のグループを持ち、説明文・店名を揃えて（NFKC・小文字・記号除去）照合し、最初に当たったグループの中項目を採る。大項目は正準名の完全一致で見る（中項目の一覧が無い大項目・カスタム名では付けない）
- **LINE の入力**: 説明文の辞書。時刻は当てない（入力した時刻は食べた時刻とは限らない）。例: 「ランチ」→ 昼ご飯、「ラーメン」→ 外食
- **カード利用通知（Gmail）**: 店名の辞書。メールに時刻が書かれていたとき（`gmail/parser.ts` の `usedAtHasTime`。日付と時刻の両方が取れ、時刻が 0:00〜23:59 の表記のときだけ true。時刻なし〔00:00 にする〕・日付なし〔処理した時刻にする〕・`25:00` のような表記は false）だけ、飲食店のグループに当たった店名を JST の時刻で朝ご飯（5:00〜10:59）・昼ご飯（11:00〜16:59）・夜ご飯（17:00〜翌 4:59）にする。時刻の無いメールの飲食店は外食。カフェ・コンビニ・飲み会などには時刻を当てない
- **Jev（辞書で決まらなかったときだけ）**: 大項目とは別の呼び出しで、System One の `choice` 質問 1 問（`subCategory`）を送る。選択肢はその大項目の中項目の一覧（「その他の食費」「その他の娯楽」を含む）と説明（`SUB_CATEGORY_DESCRIPTIONS`）、質問文に大項目名、入力は大項目と同じ先頭 100 文字。モデル・3 秒の打ち切り・再試行なしは大項目と同じ。Gemini には回さない
  - **呼ぶ条件**（すべて満たすとき）: 大項目（正準名）に中項目の一覧がある（食費・娯楽。日用品・その他〔未判定〕・カスタム名は呼ばない）／説明・店名が、`textParser.ts` が説明に入れる決まった文字列でない（空・空白だけ・「支出」・カテゴリの指定だけを書いたときのカテゴリ名〔`VALID_CATEGORIES` の名前そのもの。「食費 500」の「食費」、「娯楽費 800」の「娯楽費」〕。「書籍」「エンタメ」「飲食」のようなカテゴリの別名や、「娯楽」のような指定にならない名前の説明は聞く）／モデルを呼んでよい（LINE は世帯メンバーの入力だけ。所属の確認に失敗したときはカテゴリを指定した入力でも呼ぶ。§2.3。カード利用通知は呼んでよい）／鍵（`TYPESAFE_API_KEY`）がある／同じ処理で大項目の Jev が失敗していない（LINE で大項目を分類して Gemini で決まった・どれでも決まらなかったとき、カード利用通知で大項目が Jev 以外で決まった・決まらなかったときは呼ばない）
  - 大項目が既定カテゴリに置き換わった（判定元 `既定`）ときも、置き換わった大項目（食費など）の中項目を聞く。カテゴリを指定した入力（`指定`）でも聞く
  - **採用**: 確信度 0.4 以上（`SUB_MIN_CONFIDENCE`。LINE・カード利用通知で同じ）で、「その他の食費」「その他の娯楽」でないときだけ。Jev が「外食」を返しても時刻のルールは当てない
  - **キャッシュ**: Jev の答え（採用しなかったその他・低い確信度も含む）を 15 分（キーは経路・正準の大項目・送った入力の小文字。利用者 ID は含めない）。失敗はキャッシュしない。モデルを呼ばない送信者はキャッシュも使わない
  - エラー・3 秒のタイムアウト・答えなし・一覧外は中項目なし（大項目と別の文言で警告: `Jev subcategory classification failed`〔`errorName`・`errorStatus`。大項目の `Jev classification failed` と同じ形〕／`Jev returned no subcategory`／`Jev suggested a subcategory outside the list`）
  - 結果は `Subcategory classified by model` のログ（`source`・`majorOrigin`・`majorConfidence`・`outcome`・`answer`〔一覧の名前だけ〕・`confidence`・`cached`・`ms`。確信度は小数 2 桁。入力・店名・ID は出さない）で見られる。`outcome` は `adopted` / `low_confidence` / `other` / `failed` / `no_info` / `models_not_allowed` / `jev_unavailable` / `not_configured`。辞書で決まったとき・一覧の無い大項目では出さない
- **決まらなければ付けない**: 辞書にも Jev にも決まらない・説明が「支出」だけ・大項目に中項目の一覧が無いときは `subCategory` の項目を保存しない。「その他の食費」「その他の娯楽」は自動では付けない（手で選ぶためのもの）
- 判定に失敗しても保存は続ける（中項目なし。Jev の失敗・タイムアウトでもカードは送る）。辞書の結果は `Subcategory resolved` のログ（`source`・`subCategory` だけ。説明・店名・ID は出さない）で見られる。食費・娯楽のときだけ出す
- **既存のデータはそのまま**（遡って付けない）。LINE のカードで大項目を変えると辞書と時刻のルールだけで決め直す（Jev には聞き直さない。§2.5）。Web の編集画面では一覧から手で選べる（§5.1 の `/expenses`。大項目を変えると「中項目なし」に戻り、選び直さずに保存すると `subCategory` を消す）
- Web の内訳シートで、食費・娯楽を中項目別の小計に分けて見られる（§5.2）

---

## 5. Web アプリ機能仕様（`web/` — Next.js 16 App Router）

### 5.1 ページ一覧

| ルート | 内容 |
|---|---|
| `/` | **ホーム（ダッシュボード）**。期間ナビ、合計/件数/日平均カード、予算プログレス（`components/home/BudgetProgress.tsx`。カテゴリ別の実支出は、合計に含む支出を `normalizeCategoryName` で正準名にまとめて数える〔`useMonthlyStats` → `lib/budgetAnalytics.ts` の `sumCategoryTotals`。旧名の `娯楽費` `交際費` `趣味` は `娯楽`、`投資` `貯蓄` は `貯金` の予算に入る。ほかの名前も部分一致・キーワードで正準名に寄せ〔例: `ゲーム課金` は `娯楽`〕、寄せられない名前〔カスタム名など〕は `その他`。ホームの内訳と同じ。旧名の予算キー〔`娯楽費` など〕は `BUDGET_TO_EXPENSE_CATEGORY` で正準名に読み替える。#243〕）、**カテゴリ別 / 支払い者別カード**（`components/home/CategoryBreakdownCard.tsx`。割合の帯と行ごとの金額・件数・前期比。行や「内訳を見る」から内訳シートを開く）＋日別推移（Recharts）、前月比インサイト、残り日数ペース。要確認の支出（LINE で手入力して未確認のもの。`lib/expenseState.ts` の `isPending`。Gmail 取込・固定費は対象外）があれば件数バナー（→ `/expenses?filter=pending`）。LINE 未ログイン（`lineId` クレーム無し）の人は、サインイン処理が終わると `/demo/` へ移す（下の §5.2）。ゲストモード（サンプルデータ＋ガイド）を見るのは検索エンジンのクローラーだけ |
| `/expenses` | **支出一覧**。セグメント（全て / 要確認 / 立替。立替は `advance_pending` / `advance_settled`。区分のチップは「立替（全額）」〔`advanceFull`〕/「立替」〔全額にする前の立替〕/「精算済み」）、絞り込み（説明・カテゴリの文字検索、集計対象/対象外、カテゴリ、日付/金額ソート。`lib/expenseState.ts`）、支払者別集計、インライン編集ドロワー（**中項目**: 大項目が食費・娯楽のときだけ、大項目の下に「中項目」のセレクトを出す。選択肢は先頭の「中項目なし」と、選んだ大項目の中項目の一覧〔`web/lib/categoryTaxonomy.ts`。bot の `SUB_CATEGORIES` と同じ。一致は `web/__tests__/categoryTaxonomy.test.mjs` で確かめる〕。一覧に無い今の値は選択肢の最後に残す〔開いただけで消えない〕。大項目を変えると「中項目なし」に戻し、「大項目を変えたので『中項目なし』に戻しました」と添える〔大項目は保存時と同じ正規化（`normalizeCategoryName`）で比べ、別名（例: 外食 → 食費）を選んだだけなら戻さない〕。保存時、「中項目なし」なら `subCategory` を削除、選んでいれば一覧の名前をそのまま保存。自由入力の欄は無い。`lib/expenseEdit.ts`）、削除、集計対象トグル、レシートプレビュー、要確認の支出の「確認」ボタン（§5.4 の confirm API。LINE の OK と同じ判定）。`?edit=<id>` で編集を自動オープン（LINE の「修正」ボタン連携）、`?filter=pending\|advance` で初期セグメント指定、`?from=YYYY-MM-DD` でその日を含む期間、`?category=` でカテゴリの絞り込み（内訳シートから開くとき） |
| `/settlement` | **精算**。**期間の精算（折半）**（`PeriodSplitCard`。表示は `PeriodSplitView`）: 表示期間内の世帯の支出（合計に含むもの。立替精算済みと立替（全額）は除く）を 2 人で折半し、「集金するメンバー」（`groups.splitSettings`、§5.4 の split-settings API で保存）の支払い分を引き、立替（全額）を足し引きした集金額を表示（立替があれば式に「+ <相手>の立替（全額）」「− <集金するメンバー>の立替（全額）」の行を出す。§5.4）。誰が払ったかは支出の支払った人（`payerId`、無ければ `lineId`）で数える。2 人の支払いのタイルと「カテゴリ別の内訳を見る」から内訳シートを開く（集金するメンバーの支払い / 相手・カード・共通口座の支払い / 期間の合計。立替（全額）は入れない）。全額にする前の立替（`advanceFull` の無い `advance_pending`）が残っているときだけ、下に「以前の「立替」がN件残っています」のお知らせ（`LeftoverAdvancesCard`。`GET /household/legacy-advances`）を出す: 立替を全額で精算するようにする前の支出なので、精算が済んでいれば精算済みにしてほしい旨（どの期間の精算にも入らなくなる）、［N件を見る］（その場で一覧を開く）、［精算済みにする］（その場で確認 → `POST /household/legacy-advances/settle`） |
| `/settings` | **設定**。予算タブ（月次予算・アラート閾値・カテゴリ別予算）、期間タブ（月次/開始日カスタム/期間指定。保存ボタンの下に「LINEへの精算の通知」カード〔`components/settings/SettlementNotifyCard.tsx`。§3.4〕: 自動で送る日〔毎月N日。「送金する人の期間設定の起算日」と添え、29〜31 日は「その日が無い月は次の回にまとめて」〕・送り先・前の期間とその送信済みの状態を表示し、［今すぐ送る］→ 締まった期間 / 今の期間（途中）を選んで［送る］。送れない世帯では理由を表示。［設定を保存］のあとに読み直す）、固定費タブ（`RecurringExpensesPanel`。§3.3 の項目の追加・編集・停止・削除）、**カテゴリタブ**（`components/settings/CategoryRulesPanel.tsx`。世帯のカテゴリのルール〔§4〕を編集する。確定ルール〔言葉 → カテゴリ。追加・削除〕、AI へ伝える例〔カテゴリごと〕、「試してみる」〔今の編集内容でどうなるか。確定ルールに当たるか・例に近いか〕。確定ルールは［↑］［↓］で順番を入れ替えられ、前のルールの言葉を含むために当たらなくなっているルールには警告を出す。編集は手元の下書きで、［保存］で `POST /household/category-rules`。保存していない変更があると表示し、［変更を元に戻す］で破棄。タブを切り替えても下書きは消えない（一度開いたパネルは隠すだけ）。相手が先に保存していたら（409）読み直しを案内する。世帯に入っていないときは編集できない） |
| `/attach` | **レシート添付**。LINE のカードから直接開かれるため、LINE サインインの完了（`waitForLineAuth`）を待ってから支出を読む。`?expenseId=` の支出にカメラ/アルバムから画像を選択→クライアント側で圧縮（リサイズ＋JPEG 再エンコード）→ Firebase Storage `receipts/{expenseId}/{timestamp}_{name}` へレジューマブルアップロード→ `receiptUrl` を書き戻し。アンマウント後もバックグラウンド継続 |
| `/link` | アカウント連携確認画面（`token` + `lineId` クエリの存在チェックのみ。認証には関与しない） |
| `/dashboard` | `/` へのリダイレクト（レガシー） |
| `/terms` `/privacy` | 静的な規約・プライバシーページ |
| `/demo` | **デモ**（職場の所感発表用。ログイン不要・架空データだけ。`app/demo/`、`(app)` の外）。目次と、LINE（`/demo/line/`）・Gmail（`/demo/gmail/`）・ホーム（`/demo/home/`）・支出一覧（`/demo/expenses/`）・精算（`/demo/settlement/`）・精算サマリー（`/demo/settlement-summary/`）の順の場面。ホーム・支出一覧・精算は、本番と同じ部品・純関数に `lib/demo/demoData.ts` の架空データ（Aさん・Bさん、2026年8〜10月）を渡す。LINE はスマホの枠のトークで、用意した文例（大項目・中項目が bot の辞書で決まる語だけ。自由入力は無し）を送ると入力中の表示のあとに確認カードが返り、OK で確定のカードが返る。Gmail はカード利用のメール（差出人は `.example`、店は「サンプル食堂」）→ 自動の登録（店名の分類の順と、時刻のルールで昼ご飯）→ LINE グループへの通知カードの 3 段。精算サマリーは、起算日（1 日）に届く 9月分の精算（メンション付きのテキストと Flex。数字は本番と同じ `computePeriodSplit` から）。確認カード・精算サマリーは bot の Flex Message を手で写したもので、文言・色・アイコン・判定元の表示名・ボタンと文例の分類を `__tests__/demoCard.test.mjs` が bot のソースと突き合わせる（レイアウトのずれは検出できない）。本番のカード利用の通知に残り予算の行は無いので、デモにも出さない。Firestore・LINE ログイン・bot の API・ブラウザの保存領域に触れず（テーマの設定を除く。`ThemeToggle` が本番と同じキーの localStorage に書く。`__tests__/demoIsolation.test.mjs`）、操作は保存しない。リンクは `/demo` 以下だけ（例外は「LINE でログイン」の 1 本。`DEMO_LOGIN_HREF`）で、`/demo` 以下の存在しない URL はデモの 404（目次へ戻る）。**発表後に削除する**: 未ログインの人のデモへの移動（`web/lib/guestRedirect.ts`・`web/__tests__/guestRedirect.test.mjs`・`AppShell.tsx` の `toDemo`）を先に外す（残すと送り先が 404 になる）。そのうえで `web/app/demo/`・`web/components/demo/`・`web/lib/demo/`・`web/__tests__/demo*.test.mjs` と（外部ブラウザの人の入口が無くなるので、`shouldStartLineLogin` の外部ブラウザの扱いも元に戻す）、docs のこの行（表の下の「`/demo` を除く」も）・`ARCHITECTURE.md` と `architecture.html` の 1 行ずつ |
| （一致しない URL） | 404（`app/not-found.tsx`）。ナビは無く、「ホームへ戻る」（`/`）のリンクだけ。LINE ログインは始めない |

上の画面（404 と `/demo` を除く）は `app/(app)/` に置く。`(app)` はルートグループで URL には出ない。

### 5.2 UI/UX

- **内訳シート**（`components/drilldown/DrillSheet.tsx`、計算は `lib/drilldown.ts`）: 合計 → カテゴリ → 中項目 / 支払い者 → 明細と潜っていく（モバイルは下からのシート、デスクトップは右のドロワー。パンくずで戻れる。例: 期間の合計 › 食費 › 昼ご飯 › 明細）。各階層に金額・件数・合計に占める割合・1 件平均（カテゴリはホームでは前期比と週ごとの棒）、内訳の行、明細（日付順 / 金額順）。内訳の軸の切り替えは、パンくず・戻るで戻った階層では残し、次の階層を開くと既定に戻す（食費で選んだ「支払い者」を、戻って開いた娯楽に持ち越さない）。明細から編集（`/expenses?edit=<id>`）、カテゴリの階層から支出一覧（`?from=&category=`）へ。読み込み済みの明細から計算し、Firestore を追加で読まない
  - **中項目の段**（#235。§4.1）: 中項目の一覧がある大項目（食費・娯楽。大項目名の完全一致）のシートだけ、内訳を既定で「中項目」別にする（「支払い者」にも切り替えられる）。日用品など一覧の無い大項目と、全部が「中項目なし」の大項目には出さない（中項目が 1 つだけでも、「中項目なし」でなければ出す）。並びは金額の多い順で、「中項目なし」は金額にかかわらず最後。割合は小数 1 桁。`subCategory` に一覧にない値（Web で入れた値など）が入っていれば「その他の食費」「その他の娯楽」に数える（「中項目なし」には入れない）
  - 中項目の行から、その中項目のシート（小計・件数・大項目に占める割合〔「食費の」〕と合計に占める割合・1 件平均・週ごとの棒・支払い者の内訳・明細）へ。前期比と支出一覧へのリンクは出さない（前期の集計と支出一覧は中項目で分けていない）。カテゴリのシートの明細の行には中項目を小さく添え（「中項目なし」は添えない）、明細の画面には「中項目」の行を出す（無ければ「中項目なし」。一覧の無い大項目では行を出さない）
  - 画面に出す中項目の名前は、一覧の名前と「中項目なし」だけ（Firestore の値をそのまま出さない）。一覧は編集画面と同じ `lib/categoryTaxonomy.ts` の `subCategoriesOf`（`toDrillItems` に渡す。bot の一覧との一致は `__tests__/categoryTaxonomy.test.mjs` で確かめる）。精算の内訳シートも同じ部品なので同じ段が出る

- Tailwind CSS v4（CSS 変数トークン、ライト/ダーク/システム切替）
- framer-motion による SPA 風ページ遷移アニメーション＋ SWR キャッシュ（`lib/swrCache.ts`）で再読込感を排除。支出・集計・世帯・以前の立替（`advances:`）・設定のキャッシュは localStorage にも保存し（14 日で破棄。別の LINE アカウントに切り替わったら消す）、LINE から開き直したときも前回の内容をすぐ出して裏で取り直す
- レスポンシブ: デスクトップはサイドバー、モバイルはボトムタブ。タブは **ホーム / 支出 / 精算 / 設定** の 4 つ（`components/layout/nav.ts`）
- AppShell（`components/layout/AppShell.tsx`。ナビと、マウント時の LINE ログイン〔`lib/lineAuth.ts`〕・PWA の起動）で包むのは `app/(app)/layout.tsx` だけ。ルートの `app/layout.tsx` は html・フォント・テーマ・metadata だけで、`(app)` の外のページ（404）は AppShell・`lib/lineAuth.ts` を読み込まない
- 未ログインの人のデモへの移動（`components/layout/AppShell.tsx`・`lib/guestRedirect.ts`・`lib/lineAuth.ts` の `getLineAuthOutcome`）: `/` `/expenses` `/settlement` `/settings` `/dashboard` を開いて、サインイン処理が終わった結果が `guest` で `lineId` が無いときだけ `router.replace('/demo/')`。`guest` は、LINE ログインを本人がやめて戻ってきた（`error=access_denied`）・LIFF 未設定・外部ブラウザの初めての人が入口（`/`・`/dashboard`・`/terms`・`/privacy`）を開いた（LINE ログイン画面へ送らない）、のいずれか。LINE ログインへ自動で進むのは、LINE の中（アプリ内ブラウザ・LIFF）・ホーム画面のアプリ（PWA）・`?login=1`（デモの「LINE でログイン」）・`?openExternalBrowser=1`（設定の「ホーム画面に追加」で外部ブラウザへ開き直したとき）・入口以外の画面（LINE のカードのリンクやブックマーク）のとき（`shouldStartLineLogin`）。デモの `/demo` 以下から本番へ出るリンクは、この「LINE でログイン」（`DEMO_LOGIN_HREF` = `/?login=1`）の 1 本だけ。通信・認証の失敗で匿名になった本人（`failed`）、処理が長引いているとき（`pending`。20 秒の上限では打ち切らない）、クローラーは送らず、これまでのゲスト表示のまま（行き先の URL を残し、再読み込みで再試行できる）。移る間はスピナー。規約・プライバシー・`/attach`・`/link` は対象外。LIFF 未設定のローカルは `guest` になるので、アプリの画面は開けず `/demo/` に移る
- ログイン処理中（LIFF の初期化・LINE ログイン画面への移動・トークン交換）は `useLineAuth` の `loading` を true のままにし、ゲスト（プレビューモード）の画面を一瞬出さない。ログインが終わっても LINE でサインインしていない場合（匿名へのフォールバック・20 秒の上限切れ・クローラー〔`lib/lineAuth.ts` でログインを始めない〕）だけ、トップはプレビューモードで表示する。前回の失敗で残った匿名セッションも、処理が終わるまでゲストと確定しない
- `/attach` `/link` はナビ chrome なし（`components/layout/AppShell.tsx` の BARE_ROUTES）
- セキュリティヘッダー（`next.config.ts`）: CSP は、`object-src 'none'` `base-uri 'self'` `frame-ancestors 'none'` の 3 つだけを強制し、全体の方針は Report-Only（実機で違反が出ないことを確かめてから強制する。`form-action` も、LINE ログインの遷移を確かめてから）、`X-Frame-Options: DENY`。検索エンジンに出すのはトップ（`/`）だけで、それ以外は `X-Robots-Tag: noindex`（ロゴの `/pwa/` `/favicon.ico` `/apple-icon.png` は除く）で止める（`public/robots.txt` は全許可。Disallow にすると noindex を読めず URL だけが載るため）。検索結果のロゴは `app/layout.tsx` の `icons`（48px の倍数の PNG）、サイト名は `WebSite` の JSON-LD で指定する

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
| `GET /household/category-rules?groupId=<id>` | − | 200 `{ rules: [{ keyword, category }], examples: { <カテゴリ>: [例] }, version, limits: { minKeywordLength, minAsciiKeywordLength, maxRules, maxKeywordLength, maxExamplesPerCategory, maxExampleLength } }` | 400 / 403 / 404 |
| `POST /household/category-rules` | `{ groupId, expectedVersion, rules: [{ keyword, category }], examples: { <カテゴリ>: string[] } }`（丸ごと置き換え） | 200（整えた結果を GET と同じ形で返し、`version` は保存した版）。`groups/{groupId}.categoryRules` に `{ rules, examples, updatedBy, updatedAt }` を書く。上限・カテゴリの一覧・文字を満たさなければ 400（書かない）。`expectedVersion` が今の版と違えば 409 `stale`（書かない） | 400 / 403 / 404 / 409 |
| `POST /household/split-settings` | `{ groupId, collectFromLineId: string \| null }`（有効メンバーの lineId か `null`=解除） | 200 `{ collectFromLineId }`。`groups/{groupId}.splitSettings` に `{ collectFromLineId, updatedBy, updatedAt }` を書く | 400 / 403 / 404 |

- **立替は期間の精算に全額を加算する**: 以前は立替（`advance_pending`）が期間の精算（折半。支払った人 `payerId || lineId` で数える）と別の立替の精算の両方に入り、二重に払うおそれがあった。立替の精算（`GET /household/settlement`・`POST /household/settlement/settle`、LINE の `精算` の記録）はやめ、［自分が立替］にした支出（`advanceFull: true`）は支出の日付の期間の精算で全額を返す。全額にする前の立替（`advanceFull` 無し）は、これまでどおり支払った人の分として折半する（過去の期間の金額を変えないため）。精算が済んでいれば `legacy-advances/settle` で精算済みにする
- **対象範囲**（全額にする前の立替）: `groups/{groupId}.lineGroupId` があれば `lineGroupId` 基準（以前の LINE の `立替一覧` / `精算` と同じ集合）、無ければ `groupId` 基準。期間は見ず、残っている全件
- **期間の精算（折半）**の計算は API を持たない。`web/lib/periodSplit.ts` の `computePeriodSplit` がクライアントで計算する（LINE への通知は同じ式の `bot/src/periodSplit.ts`）: 集金額 = 世帯の支出合計 ÷ 2 − 集金するメンバーの支払い（`payerId`、無ければ `lineId`）＋ 相手の立替（全額）− 集金するメンバーの立替（全額）。合計は `groupId` が一致し `includeInTotal` のもので、`advance_settled` と立替（全額）を除く。立替（全額）は `isFullAdvance`（`status: 'advance_pending'` かつ `advanceFull: true`）のうち日付が期間内で `includeInTotal` のもの（合計から除外した立替は返さず、除外として数える）で、立て替えた人＝支払った人（`payerId` → `advanceBy` → `lineId`。Web の編集で支払った人を変えたらその人に返す）で分ける（集金するメンバー以外の立替は相手の分）。結果の `advanceCount` / `targetAdvanced` / `counterpartAdvanced` が件数と各人の立替の合計。有効メンバーが 2 人でない（`not_two_members`）か集金するメンバー未指定（`no_target`）なら出さない。記録は残さない
- テスト: 純関数は `bot/scripts/smoke-household-api.js` / `smoke-recurring.js`（`npm -w bot test`）、web 側は `web/__tests__/periodSplit.test.mjs` / `renewal-logic.test.mjs`（`npm -w web test`）。ルーター・認証・Firestore を通した確認は `bot/scripts/emulator-household-api.js` / `emulator-recurring.js` / `emulator-settlement-summary.js`（`npm -w bot run test:emulator`。`bot/scripts/firebase.emulator.json` のポート 18080 / 19099 で Firestore・Auth エミュレータを起動する。firebase-tools は依存に入れていないので、別途入れて PATH に置く）

---

## 6. データモデル（Firestore）

| コレクション | 主なフィールド | 備考 |
|---|---|---|
| `expenses` | `lineId`, `appUid?`, `groupId?`, `lineGroupId?`, `amount`, `description`, `date`(YYYY-MM-DD), `category`, `subCategory?`（中項目。任意で、`category`（大項目）とは別に持つ。bot は登録時〔LINE の入力・Gmail の取込〕に辞書と時刻のルール、または辞書で決まらなければ Jev で決まったときだけ書き〔§4.1。決まらなければ項目が無い〕、LINE で大項目を変えたとき〔`set_category`。§2.5〕に辞書と時刻のルールだけで決め直す・決まらなければ消す。Web の編集画面では食費・娯楽の一覧から選べ、「中項目なし」にするか、大項目を変えて選び直さないと消す〔§5.1〕）, `confirmed`, `includeInTotal`, `status`(`pending\|shared\|personal\|advance_pending\|advance_settled`。`advance_pending` は立替、`advance_settled` は以前の立替の精算か、全額にする前の立替を精算済みにしたもの), `inputSource`(`line_text\|gmail_auto\|recurring`。`line_ocr` は OCR 廃止に伴う**レガシー値**で既存データにのみ存在), `payerId`, `payerDisplayName`, `paymentMethod`, `advanceBy?`, `advanceFull?`（立替を全額で精算に加算する扱い。［自分が立替］で `true`。無い `advance_pending` は全額にする前の立替で、新しくは作られない。bot だけが書き、クライアントからは作成・更新とも不可）, `advanceSettledAt?`, `gmailMessageId?`, `usedAt?`, `recurringId?`, `receiptUrl?`, `needsEdit?`（**レガシー**。書き込み・読み出しとも廃止済みで既存データにのみ存在）, `items?[]`, `ocrText?`（レガシー）, `createdAt`, `updatedAt` | 中核コレクション。システムユーザーの `lineId`: Gmail 取込 `gmail-auto-system` / 固定費 `recurring-system`（ルールで世帯メンバーが修正・削除できる） |
| `groups` | `name`, `inviteCode`(8桁・暗号学的乱数。参加には使わない), `createdBy`, `lineGroupId?`, `splitSettings?`(`{ collectFromLineId, updatedBy, updatedAt }`), `categoryRules?`(`{ rules, examples, updatedBy, updatedAt }`。§4) | 汎用グループ機能はコード上「非推奨」— 実運用は LINE グループ共有。クライアント書込不可 |
| `groupMembers/{groupId}_{lineId}` | `groupId`, `lineId`, `displayName`, `isActive`, `joinedAt`, `leftAt?`, `deactivatedReason?` | `isActive == true` が Web アクセス権。LINE グループ退出（`memberLeft`）で bot が `false` にする。発言による自動追加はしない（世帯2名固定、追加は管理スクリプト）。クライアント書込不可 |
| `recurringExpenses` | `groupId`, `name`, `amount`, `category`, `dayOfMonth`, `payment`(`shared\|advance`), `payerLineId`, `active`, `lastPostedMonth`, `startDate`, `createdBy`, `createdAt`, `updatedAt` | 固定費の項目（§3.3）。クライアントからは読み書き不可（`/household/recurring` 経由） |
| `userSettings/{lineId}` | `defaultCategory?`, `dateSettings` | 集計期間設定も格納。本人のみ read、write は使う項目だけを検証して許可 |
| `budgetSettings/{lineId or lineGroupId}` | `monthlyBudget`, `categoryBudgets`, `alertThreshold` | Web が書き、Bot のサマリーも参照。本人のみ read、write は使う項目だけを検証して許可 |
| `userLinks/{appUid}` | `lineId`（1:1, `firestore.ts`。`/auth/line` が作成）／ `lineIds[]`（1:N, `userLinks.ts`。`syncUserLinks` トリガーは書き込みを停止済み） | **2形式が併存**（§8）。クライアントは本人分の read のみ |
| `linkTokens/{token}` | `lineId`, `expiresAt`(15分), `used` | クライアントからは読み書き不可 |
| `userCustomCategories` | `lineId`, `name`, `icon?`, `keywords?[]` | Bot 専用 |
| `categoryFeedback` | `originalCategory`, `correctedCategory`, `description` | 分類改善用ログ。Bot 専用 |
| `system/{gmailToken,gmailState,oauthState,gmailFailures}` | Gmail OAuth トークン・historyId / watch 期限 / 連携中のアカウントのアドレス（Pub/Sub の通知の照合用。GMAIL_AUTO_SPEC §3.2）・CSRF state・処理失敗の記録（試行回数と最初・最後の失敗の時刻・最後の失敗の例外の種類。文言は保存しない） | Bot 専用 |
| `system/gmailCardNotice_{messageId}` | `expenseId`, `lineGroupId`, `card`, `createdAt`, `expireAt` | カード利用通知の送信待ちの印（§3.1。支出の保存と同じトランザクションで作り、送れたら消す。23 時間を過ぎた印・支出が消された印・諦めたメール〔historyId を進めたときだけ〕や historyId が古すぎて飛ばしたメールの印は送らずに消す。`expireAt`〔作ってから 24 時間〕は運用で設定する TTL ポリシー用で、未設定でも動作は変わらない）。Bot 専用 |
| `system/settlementSummary_{groupId}_{YYYY-MM-DD}` | `groupId`, `endDate`, `createdAt`, `sentAt`, `manualSentAt?` | 期間の精算サマリーを送った印（§3.4。同じ期間は 1 回。Web から締まった期間を手動で送ったときは `manualSentAt` を書き、印が無ければ作る。自動で送った `sentAt` は上書きしない）。Bot 専用 |

複合インデックス: `expenses` の `lineId/groupId/lineGroupId × createdAt/date/status` 組合せ、`groupMembers` の `lineId+isActive` / `groupId+isActive`（`firestore.indexes.json`）。

Storage: `receipts/{expenseId}/{fileName}` — cross-service rules で支出を参照し、個人支出は所有者、グループ支出は有効メンバーだけが get / 書込 / 削除できる（list は不可）。書込は 5MB 以下かつ JPEG / PNG / WebP / HEIC / HEIF のみ。精算済み支出のレシートは上書き・削除不可（`storage.rules`）。運用上の前提（IAM ロール）は `docs/SECURITY_OPERATIONS.md` §4。

---

## 7. 認証・認可モデル

- **Web**: LIFF ログイン。`web/lib/lineAuth.ts` が LIFF の ID トークンを bot の `POST /auth/line` へ送り、LINE の verify API で検証（`aud` = `LINE_LIFF_CHANNEL_ID`）した `sub` を `lineId` クレームに持つ **Firebase カスタムトークン**（`uid` = `appUid`）でサインインする。**URL の `?lineId=` は識別に使わない**（LINE のリンクに付いていても無視される）。未ログインなら LINE ログインへ移り、ログイン後は元のページ（`/attach?expenseId=…` など）へ戻る。LIFF 未設定（ローカル・プレビュー）や失敗時は匿名サインインへフォールバックし、`lineId` クレームが無いためルール上は何も読めない（ゲスト表示）
- **Bot**: LINE webhook 署名検証（`LINE_CHANNEL_SECRET`）。`appUid` は Firebase Auth 匿名ユーザーとして裏で発行。Firestore は Admin SDK で操作しルールをバイパスする
- **Firestore ルール**（`firestore.rules`）: `request.auth.token.lineId` と各文書の `lineId`、および `groupMembers/{groupId}_{lineId}.isActive` で判定。`expenses` は所有者と世帯メンバーが読め、**create はクライアントから禁止**（bot だけが登録する）、update / delete はフィールド許可リストと値の検証付き（`status` / `advanceBy` / `advanceFull` / `inputSource` / `groupId` などはクライアント不変、精算済みは金額・日付・支払者の変更と削除不可）。`groups` / `groupMembers` / `userLinks` / `linkTokens` はクライアント書込不可、`userSettings` / `budgetSettings` は本人のみ（書き込みは使う項目だけを型と大きさを確かめて許す。`dateRangeSettings` は書き込み禁止）、未定義パスは既定拒否。要点は `docs/SECURITY_OPERATIONS.md` §3
- **Storage ルール**（`storage.rules`）: §6 の記載どおり。cross-service rules の IAM 前提は `docs/SECURITY_OPERATIONS.md` §4
- **Web 向け API**: §5.4 の ID トークン認証＋メンバー判定。Gmail 管理 API は `ADMIN_SECRET`
- **世帯メンバー管理**: 2 名固定。追加・無効化は `scripts/manage-group-members.mjs`（`docs/SECURITY_OPERATIONS.md` §1–2）

残っているセキュリティ上の課題（脱退者による自分の登録分の読み取り、トークン付き `receiptUrl` など）は `docs/SECURITY_OPERATIONS.md` §6 に集約している。

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
| `TYPESAFE_API_KEY` | カテゴリ分類のメイン（TypeSafe AI の Jev。辞書で決まらない中項目も） |
| `GEMINI_API_KEY` | カテゴリ分類の退避先（Jev が失敗したとき）・フィードバック解析 |
| `FIREBASE_PROJECT_ID` | 既定 `line-kakeibo-0410` |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI` | Gmail OAuth |
| `DEFAULT_GROUP_ID` / `LINE_GROUP_ID` | Gmail 自動登録・通知先。`DEFAULT_GROUP_ID` は要望コマンドの認可（世帯グループ）にも使う（未設定なら要望コマンドは拒否） |
| `ADMIN_SECRET` | Gmail 管理 API 認証 |
| `GITHUB_TOKEN` | フィードバック Issue 起票 |
| `GOOGLE_APPLICATION_CREDENTIALS` | Firebase Admin 認証（ローカルのみ JSON パス。本番は ADC） |

### Web（Vercel, すべてクライアント公開）

`NEXT_PUBLIC_FIREBASE_API_KEY` / `APP_ID` / `AUTH_DOMAIN` / `PROJECT_ID` / `STORAGE_BUCKET` / `MESSAGING_SENDER_ID` / `MEASUREMENT_ID`、LIFF ログイン用 `NEXT_PUBLIC_LIFF_ID` / `NEXT_PUBLIC_AUTH_ENDPOINT`（`api` 関数の `/auth/line`）/ `NEXT_PUBLIC_API_BASE`（任意。未設定なら `AUTH_ENDPOINT` から導出）、開発用フラグ `NEXT_PUBLIC_USE_FIREBASE_EMULATOR`（`NODE_ENV=development` のときだけ有効。`web/lib/firebase.ts`）
