# セキュリティ運用メモ（世帯メンバー・ルール・Storage・外部送信・ログ・管理 API）

家計簿の Web アクセス権は Firestore の `groupMembers/{groupId}_{lineId}` の `isActive == true` で決まる
（`firestore.rules` / `storage.rules` の両方がこれを見る）。この文書は、その運用と一度だけ必要な設定をまとめる。

## 1. 世帯は2名固定

- 世帯（アプリ内グループ）の有効なメンバーはオーナーとパートナーの **2 名だけ**にする。
- bot は **メンバーを自動で追加しない**。
  - LINE グループで支出らしい発言をしても、`groupMembers` は作られず、無効なメンバーが再有効化されることもない。
    LINE グループに紐づくアプリ内グループの有効なメンバーでない人（第三者、脱退済みの元メンバー、別の家計グループを
    作った人など）が世帯の LINE グループで支出を登録すると、`groupId` も `lineGroupId` も付けない **個人支出** として
    保存する（`bot/src/expenseGroupScope.ts`）。世帯の Web 一覧に出ないだけでなく、LINE 側の `家計簿` 集計
    （`lineGroupId` で引く）や期間の精算（折半。`groupId` で引く）にも入らない。
  - LINE の `家計簿` コマンドの集計（当月の合計・上位カテゴリ・直近の支出）も、LINE グループでは、発言元の LINE グループに
    紐づくアプリ内グループ（`groups.lineGroupId` が一致するものが**ちょうど 1 つ**）の有効なメンバー
    （`groupMembers/{groupId}_{lineId}` の `isActive == true`）にだけ返す（`bot/src/line/commands/kakeibo.ts`。#271）。
    それ以外の人（脱退済みの元メンバー、第三者、`userId` の無い発言）と、紐づくグループが無い・2 つ以上ある LINE グループでは、
    集計を返さず、拒否の文と Web のリンク（ID なし）だけを返す。所属の確認に失敗したときも返さない。
    1 対 1 のトークは送った本人の支出（`lineId` で引く）だけを集計するので、所属を確かめない。
    複数人トーク（room）と未知の種類のトークでは返さない。
  - **残るリスク**: 集計は LINE グループへの返信なので、メンバーが送れば、そのときグループにいる**全員**に見える。
    無効化した元メンバーや第三者が LINE グループに残っていれば、メンバーが送った集計は見える（自分で送っても返さないだけ）。
    そのため、**世帯のメンバーでない人は LINE グループから外す**（`memberLeft` で自動的に無効化される。§2 で無効化しただけの人は
    LINE グループに残るので、LINE アプリで退出させる）。
  - LINE グループに紐づくアプリ内グループが無い場合も、自動では作らない。
  - LINE の「参加 <コード> <表示名>」コマンドは無効化済み（招待コードが漏れると第三者が参加できてしまうため）。
- LINE グループから **退出・削除されたメンバー**（`memberLeft` イベント）は、bot が `isActive:false`、`leftAt`、
  `deactivatedReason: 'line_member_left'` を書き込む。その時点から Web の閲覧・編集・レシート操作ができなくなる。
  - 自分が登録した支出の **読み取り**だけは残る。web の個人支出クエリ（`where('lineId','==',自分)`）を
    ルールで証明できるようにするため。更新・削除・レシート操作はできない。
  - 無効化の対象は、その LINE グループに紐づくアプリ内グループ（`groups.lineGroupId` が一致）のメンバーシップだけ。
    世帯グループが LINE グループに紐づいていない（`list` の「LINE:」が `(なし)`）と何も無効化できず、bot は
    `No app group is linked to the LINE group; cannot deactivate the leaving members. ...` の警告ログを出す。したがって `list` で世帯グループに LINE の ID が
    表示されていることを確認しておく（§2 マージ前に確認すること）。
- bot 自身がグループから外された場合（`leave` イベント）は、メンバーシップを変更しない。誤操作で世帯全員の Web アクセスを失わないようにするため。

## 2. メンバーの確認・追加・無効化（管理スクリプト）

`scripts/manage-group-members.mjs` を使う。既定は dry-run で、実際に書き換えるには `--apply` を付ける。
gcloud のオーナー権限（`gcloud auth login` 済み）で Firestore REST API を呼ぶ。

```bash
# 一覧（lineId は伏せ字。--show-ids で全体を表示）
node scripts/manage-group-members.mjs list
node scripts/manage-group-members.mjs list --show-ids

# 世帯の2名以外の有効なメンバーを無効化する（まず dry-run で対象を確認）
node scripts/manage-group-members.mjs deactivate-unknown --group <groupId> --keep <ownerLineId>,<partnerLineId>
node scripts/manage-group-members.mjs deactivate-unknown --group <groupId> --keep <ownerLineId>,<partnerLineId> --apply

# 1 名を無効化する
node scripts/manage-group-members.mjs deactivate --group <groupId> --line-id <lineId> --apply

# メンバーを追加（または再有効化）する。有効なメンバーが既に2名いると拒否する
node scripts/manage-group-members.mjs add --group <groupId> --line-id <Uxxxxxxxx...> --name <表示名> --apply

# 読み取り専用: lineGroupId だけを持ち groupId を持たない旧形式の支出を数える
node scripts/manage-group-members.mjs legacy-expenses

# 旧形式の支出に groups.lineGroupId から groupId を補う（まず dry-run で件数を確認）
node scripts/manage-group-members.mjs backfill-group-id
node scripts/manage-group-members.mjs backfill-group-id --apply
```

環境変数: `FIREBASE_PROJECT_ID`（既定 `line-kakeibo-0410`）、`GCLOUD_BIN`（既定 `gcloud`）。

**マージ前に必ず確認すること**（§4 のマージ前チェックと合わせて行う）: `list --show-ids` で (a)(b) を、`backfill-group-id`（dry-run）で (c) を確かめる。

- (a) 世帯グループの「LINE:」欄が、実際に使っている世帯の LINE グループ ID と一致している。
- (b) オーナーとパートナーの 2 名が、**その**グループで「有効」になっている。
- (c) 世帯の LINE グループ ID を持つグループ文書が**1 つだけ**である（メンバーが全員無効の古いグループも数える）。
  `backfill-group-id`（`--apply` なしの dry-run。何も書き換えない）で
  「複数のグループに紐づく LINE グループがあります」の警告が出ないことを確かめる。2 つ以上あると、LINE グループでの
  `家計簿` コマンドは正規のメンバーにも集計を返さない（bot は `more than one group is linked to the LINE group` の警告ログを出す）。

bot は、発言元の LINE グループに紐づくグループ（`groups.lineGroupId` が一致）で発言者が有効なメンバーでない限り、
LINE グループでの発言を `groupId` も `lineGroupId` も持たない個人支出として保存する（`bot/src/expenseGroupScope.ts`）。
(a) か (b) が崩れていると、マージ直後からオーナー本人の LINE グループでの発言が Web 一覧・LINE 集計・精算から消える。
このとき bot は `Poster is not an active member of the group linked to the LINE group; saving as personal expense` の
警告ログ（`console.warn`。利用者と LINE グループの ID は伏せる）を出す。

**マージ前後に一度やること**:

1. `list` で有効なメンバーを確認する。過去の自動追加で 3 人目以降が有効になっていれば、`deactivate-unknown` で無効化する。
2. `legacy-expenses` を実行する。新しいルールでは、groupId を持たずに lineGroupId だけを持つ旧形式の支出は、
   登録者本人でも Web から編集・削除できない（レシートの添付もできない）。LINE のカードのボタン（区分・OK・カテゴリの変更など）
   でも変えられない（§6）。
3. 該当があれば `backfill-group-id`（dry-run で件数を確認してから `--apply`）で、`groups.lineGroupId` から `groupId` を補う。
   紐づくグループがちょうど 1 つの支出だけを対象にし、`groupId` 以外は変更しない。補った後は、その支出はグループ支出として
   有効なメンバーが編集・削除できる。

**無効化の反映タイミング**: スクリプトでの無効化は、Firestore ルール（Web の閲覧・編集・レシート操作）には即時に反映される。
bot では、LINE グループでの発言は発言ごとに所属を読み直すため、次の発言から個人支出になる。
LINE グループでの `家計簿` コマンドも送るたびに所属を読むため（キャッシュしない）、次の送信から集計を返さなくなる。
個人チャットは、bot プロセス内のユーザー情報キャッシュ（取得した時点から 15 分。キャッシュに当たっても延ばさない）に残った所属を使う。
このキャッシュは `memberLeft` 経路でしか消えないため、スクリプトで無効化した元メンバーの個人チャットの入力は、最大 15 分間は
世帯の支出として保存され、カテゴリ分類で Jev・Gemini も呼ばれうる。即時に切りたい場合は関数を再デプロイ（再起動）する。

## 3. Firestore ルールの要点（`firestore.rules`）

- `expenses` の作成: LINE 本人確認済みで `lineId == 自分`、許可フィールドだけ、型と範囲を検証
  （`amount` は 0〜10,000,000 の数値、`date` は `YYYY-MM-DD`、文字列は長さ上限あり）。
  `groupId` を付けるなら、そのグループの有効なメンバーで、`lineGroupId` はグループのものと一致すること。
  `groupId` を付けずに `lineGroupId` だけを持つ支出は作れない。LINE の集計にだけ入る支出を注入できないようにするため。
- `expenses` の更新: web が実際に編集するフィールドだけを変更できる（許可リスト）。
  `amount` / `description` / `date` / `category` / `subCategory` / `includeInTotal` / `payerId` / `payerDisplayName` / `receiptUrl` / `updatedAt`。
  `subCategory`（中項目。任意）は 50 文字以内の文字列で、削除もできる（Web の編集画面は食費・娯楽の固定の一覧から選んだ値を送り、
  「中項目なし」と、大項目を変えて選び直さないときは削除を送る）。
  それ以外（`lineId` / `groupId` / `lineGroupId` / `createdAt` / `inputSource` / `status` / `advanceBy` / `advanceFull` など）は不変。
  変更は bot（Admin SDK）だけが行う。`receiptUrl` は `https://firebasestorage.googleapis.com/` から始まる URL に限る。
- 精算済み（`status == 'advance_settled'`。以前の立替の精算か、全額にする前の立替を Web の精算タブで精算済みにしたもの）の支出は、
  金額・日付・支払者（`payerId` / `payerDisplayName`）の変更と削除ができない。
  web の編集ドロワーは、精算済みの支出ではこれらを送らない。
- グループ支出の更新・削除は有効なメンバーに限る。
- 個人支出（`groupId` も `lineGroupId` も持たない）の更新・削除は所有者に限る。`groupId` を持たず `lineGroupId` だけを
  持つ旧形式の支出は LINE 側の集計に入るため、クライアントからは更新・削除できない（Storage のレシート操作も同じ）。
- クレーム `lineId` は `request.auth.token.get('lineId', null)` で参照する。クレームの無いトークン（匿名）でも評価エラーにならず、
  単に拒否される。

web で編集できる項目を増やすときは、`editableExpenseKeys()` と `test/firestore.rules.test.mjs` を更新すること。

## 4. Storage ルールと、一度だけ必要な IAM 設定（`storage.rules`）

レシート（`receipts/{expenseId}/{fileName}`）は cross-service rules（`firestore.get()` / `firestore.exists()`）で
支出と `groupMembers` を参照し、所有者と有効なメンバーだけに get、アップロード、削除を許す。list はできない。
アップロードは 5MB 以下の JPEG / PNG / WebP / HEIC / HEIF に限る（SVG と GIF は不可）。
精算済み（`status == 'advance_settled'`）の支出では、既存レシート（精算額の証跡）の上書きと削除を禁止する。
新しいレシートの追加（web は常に新しいファイル名で上げる）は、精算後に添付する導線として許可する。

### 必要な IAM ロール

cross-service rules を評価するには、Cloud Storage for Firebase のサービスエージェントに
**`roles/firebaserules.firestoreServiceAgent`** が付いている必要がある。

- サービスエージェント: `service-<PROJECT_NUMBER>@gcp-sa-firebasestorage.iam.gserviceaccount.com`
- ロールが無いと `firestore.get()` が失敗し、レシートの表示・アップロード・削除が **すべて拒否される**（フェイルクローズ）。

firebase-tools 15.31.0 の実装（`lib/rulesDeploy.js` の `checkStorageRulesIamPermissions`）では、次のように動く。

- ルールに `firestore.get` / `firestore.exists` が含まれ、かつ **対話モード**のときだけ、ロールの有無を確認する。
  無ければ「Grant the new role?」と尋ねて付与する。
- CI（stdin が TTY でない場合は自動的に `nonInteractive`）では、確認も付与も **スキップ** する。
  デプロイ自体は成功するので、パイプラインは壊れない。ただしロールが無ければ実行時にレシート機能が止まる。

したがって、**このルールを本番にデプロイする前に一度だけ**、オーナーが次のいずれかを行う。

```bash
# A. gcloud で直接付与する（PROJECT_NUMBER は `gcloud projects describe line-kakeibo-0410 --format='value(projectNumber)'`）
gcloud projects add-iam-policy-binding line-kakeibo-0410 \
  --member="serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-firebasestorage.iam.gserviceaccount.com" \
  --role="roles/firebaserules.firestoreServiceAgent"

# B. 手元から対話モードで一度だけ Storage ルールをデプロイし、プロンプトで Yes を選ぶ
firebase deploy --only storage --project line-kakeibo-0410
```

確認方法:

```bash
gcloud projects get-iam-policy line-kakeibo-0410 \
  --flatten="bindings[].members" \
  --filter="bindings.role:roles/firebaserules.firestoreServiceAgent" \
  --format="value(bindings.members)"
```

Firebase コンソールで過去に cross-service rules を有効にしたことがあれば、既に付いている場合がある。

### マージ前チェック（必須）

master へのマージで CI の `deploy-bot` ジョブが `firebase deploy --only functions,firestore:rules,firestore:indexes,storage`
を実行し、このルールがそのまま本番に出る。上のロールが無い状態でマージすると、その瞬間から本番のレシート表示・
アップロード・削除がすべて拒否される。したがって、**このルールを含む PR をマージする前に**、オーナーが上の確認コマンドで
`serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-firebasestorage.iam.gserviceaccount.com` が表示されることを確かめる
（無ければ A か B で付与する）。あわせて §2 の「マージ前に必ず確認すること」(a)〜(c) を確認する。PR 本文のチェックボックス「IAM ロール付与済み・確認済み」にチェックしてからマージする。

**自走マージの対象外**: この PR（および cross-service rules を初めて含む PR）は、オーナーが上の確認を明示的に
済ませるまでマージしない。

補助として、CI の `deploy-bot` ジョブには事前確認ステップ（`Check Storage cross-service rules IAM (preflight)`）がある。

- 上の確認コマンドと同じクエリを実行し、ロールの存在を **確認できた場合だけ** `storage` を含めてデプロイする。
- ロールが無い場合、またはデプロイ用サービスアカウントに `resourcemanager.projects.getIamPolicy` が無い・gcloud が使えない
  などで確認できない場合は、`storage` を除外してデプロイし、警告（`::warning`）とジョブサマリーに
  「storage.rules は未デプロイ」を出す。パイプライン自体は失敗させない。
  旧 Storage ルールが残るので、レシート機能がフェイルクローズで止まることはないが、`firestore.rules` と `storage.rules` が
  食い違った状態になる。ジョブサマリーに警告が出たら、上の A で付与して次のデプロイを待つか、B で一度手動デプロイする。
- 事前確認ステップ自体が実行されなかった場合（ワークフロー編集ミスなど）も storage は除外してデプロイする。
- このステップはパイプラインを壊さないための必須要素ではない（非対話デプロイはロールが無くても成功する）。
  ロール無しで新ルールが本番に出る事故を防ぐための、防御的な追加である。

## 5. ルールのテスト

`test/firestore.rules.test.mjs` と `test/storage.rules.test.mjs` を、エミュレータで実行する
（PR では `pr-checks` の `rules-tests` ジョブが実行する）。

```bash
npm i --no-save @firebase/rules-unit-testing@5 firebase@12 firebase-tools@15
npx firebase emulators:exec --only firestore,storage --project demo-kakeibo \
  "node test/firestore.rules.test.mjs && node test/storage.rules.test.mjs"
git checkout -- package.json package-lock.json   # --no-save でもロックファイルが変わった場合
```

Java 21 以上が必要。

ローカルで Storage テストの許可ケース（cross-service の `firestore.get()` を含むもの）だけが失敗し、拒否ケースは通る場合は、
ルールではなく環境の問題を疑う。

- Storage エミュレータは、JVM が起動時に stderr へ出力したもの（例: `Picked up JAVA_TOOL_OPTIONS ...`）を
  ルール実行時エラー（`Unexpected rules runtime error`）として扱う。`JAVA_TOOL_OPTIONS` が設定された環境では、これで全許可ケースが落ちる。
- HTTP(S) プロキシ環境では、Storage エミュレータから Firestore エミュレータへの参照がプロキシに送られて失敗することがある。

回避策として、これらの変数を外して実行する。

```bash
env -u JAVA_TOOL_OPTIONS -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
  npx firebase emulators:exec --only firestore,storage --project demo-kakeibo \
  "node test/firestore.rules.test.mjs && node test/storage.rules.test.mjs"
```

GitHub ホストランナーはこれらを設定しないため、CI には影響しない。

## 6. 既知の残課題

- `syncUserLinks` トリガーは書き込みを止めた空の関数として残している。関数を export から外すと、
  CI の非対話デプロイが関数の削除確認で失敗するため。廃止した `importMoneyForward` も同じ扱い。オーナーが手動で
  `firebase functions:delete syncUserLinks importMoneyForward --region asia-northeast1` を実行したあと、`bot/src/index.ts` の export を消す。
- レシートはトークン付きのダウンロード URL を `receiptUrl` に保存している。この URL は Storage ルールを経由しない（REC-SEC-2）。
  パスを保存する方式への移行は、別の PR で扱う。
- LINE の postback で支出を変えるボタン（区分の［除外］［戻す］、［自分が払った］［自分が立替］［取り消す］、OK、カテゴリの変更）は、
  期間の精算（折半）の金額や集計が変わるため（OK とカテゴリの変更は未確認の支出を共同費にする）、トランザクション内で
  `groupMembers/{groupId}_{lineId}` の `isActive` を確かめてから変更する。カテゴリ選択のカルーセル（支出 ID 入りのボタン）も、
  表示する前に同じ確認をする（SET-18・#266 は対応済み。`groupId` の無い個人の支出は登録した本人だけ）。カテゴリは選択肢の一覧
  （正準名 19 種と、正準名に揃えられるカルーセルの旧名。32 文字以内の文字列）にある値だけを保存する。支出 ID は最初に
  `/household` API と同じ形式の検証（`isValidDocId`）を行い、不正なら何もしない。
  残る制約: `lineGroupId` だけを持つ旧形式の支出は、LINE でも区分・OK・カテゴリを変えられない（「変更できるのは、世帯のメンバーだけです」）。
  変えたいときは §2 の `backfill-group-id` で `groupId` を補う。
- LINE の `家計簿` コマンドは、LINE グループでは世帯の有効メンバーにだけ集計を返す（#271 は対応済み。§1。返した集計が
  LINE グループの全員に見えるのは残る）。1 対 1 のトークでは送った本人の支出だけを集計するため、脱退済みの元メンバーも、自分が登録した世帯の支出を含む自分の分の集計は見られる
  （次の項目の Web の読み取りと同じ範囲）。
- 脱退済み（`isActive:false`）の元メンバーも、自分が登録したグループ支出の **読み取り**（とそのレシートの取得）だけはできる。
  web の個人支出クエリ `where('lineId','==',自分)` をルールで証明できるようにするため。閉じるには、個人支出クエリに
  `groupId` の制約（または専用フラグ）を足し、read の所有者条件を `groupId` なしに限定する必要がある。
  後続の対応案: bot / Gmail 取込が個人支出に `groupId: null` を明示的に書くようにし、web の個人支出クエリに
  `where('groupId','==',null)` を足してから、read を `(ownsDoc() && docGroupId() == null) || isMemberOfDocGroup()` に絞る
  （テスト「read は残る」も assertFails に変える）。
- web から削除した支出のレシートは、クライアントからは取得も削除もできなくなり、バケットに残り続ける
  （Storage ルールが支出ドキュメントの存在を要求するため。フェイルクローズ側なので許容する）。
  後続で、web の削除時に `receipts/{id}/*` を先に消すか、bot（Admin SDK）で孤立レシートを掃除する。
- `receiptUrl` は `https://firebasestorage.googleapis.com/` から始まる URL だけを許可する。ローカルの Storage エミュレータが
  返す URL（`http://127.0.0.1:9199/...`）は拒否されるため、レシート添付の導線を端から端まで確認するときは本番（または
  実バケットのある検証用プロジェクト）で行う。

## 7. 外部への送信（カテゴリ分類）

支出のカテゴリを決めるため、bot は外部の API（TypeSafe AI の Jev）に次のものを送る
（`bot/src/jevCategoryClassifier.ts`・`bot/src/geminiCategoryClassifier.ts`）。

送るのはモデルで分類するときだけ。キャッシュで決まったとき、LINE のテキストで `textParser.ts` がカテゴリとして認識した名前を書いたときやキーワード辞書で決まったときは送らない
（カード利用通知の店名は辞書より先にモデルに送る）。LINE のテキストの送信者が世帯のメンバー（LINE グループに紐づく世帯の有効メンバー）で
ないときも送らない（#245。所属の確認そのものに失敗したときは送る。SPECIFICATION.md §2.3）。

- 送るもの: 入力の先頭 100 文字、質問文、選択肢、モデル名、リクエストのヘッダー。
  - 入力は、カード利用通知なら店名。LINE のテキストなら、`textParser.ts` が金額・日付・支払方法・カテゴリとして取り出した
    トークン（それぞれ最初の 1 つ）を除いた残り。2 つ目以降の数字、認識できない形の日付（例: 曜日付き、「昨日」）、
    実在しない日付は説明に残り、そのまま送られる。
  - 選択肢は、カテゴリ名（利用者のカスタムカテゴリ名を含む）と、既定のカテゴリの説明（コードに持つ固定の文）。
    カスタムカテゴリの説明は送らない（説明なしで渡す）。
  - ヘッダーは `Authorization`（鍵）、`User-Agent` / `X-TypeSafe-SDK`（`typesafe-sdk/<版>`）、
    `X-TypeSafe-Runtime`（`node/<版> (<OS>; <arch>)`）など。個人情報は含まない。
- 送らないもの: 利用者 ID・世帯 ID・メール本文。
- Jev が失敗したとき（SPECIFICATION.md §4）は、同じ入力とカテゴリ一覧（既定のカテゴリの説明つき）を Gemini にも送る。
  入力は先頭 100 文字に切る（従来は切らずに送っていた）。
- Jev の接続先とログレベル（`warn`）はコードで固定している（環境変数 `TYPESAFE_BASE_URL` / `TYPESAFE_LOG_LEVEL` では変わらない）。
  Jev の呼び出しでは、ログに入力・店名・利用者 ID・API の応答本文を出さない（失敗時はエラーの種類と HTTP ステータスだけ）。
- Gemini の呼び出し（`bot/src/geminiClient.ts`）でも、ログにプロンプト・応答本文を出さない。応答を JSON として解釈できないとき
  （`Gemini response is not valid JSON`）と HTTP ステータスの無い失敗のときは、エラー名（`errorName`）だけを出す（`JSON.parse` の
  `SyntaxError` の文言には応答の一部が入るため）。通信の失敗（`fetch failed`）では、原因のエラーコード（`cause.code`。`ECONNRESET`・
  `UND_ERR_CONNECT_TIMEOUT` など、英大文字・数字・`_` だけのとき）も `code` として出す（文言・原因の文言は出さない）。
  API のエラーは HTTP ステータスと API のエラー文の先頭 300 文字を出す。
- 鍵（`TYPESAFE_API_KEY`）は Firebase の Secret Manager で管理し、`firebase functions:secrets:set TYPESAFE_API_KEY` で登録する。
  コード・ログ・`.env.example` に値を書かない。止めるときの手順は SETUP.md §4「Jev（TypeSafe AI）」。
- 開発者の手元で評価スクリプト（`bot/scripts/eval/eval-classifier.js --provider jev`）を実行するときは、評価データ（実際の支出の説明文・店名。
  リポジトリには含めない）を、先頭 100 文字に切らずに Jev に送る。接続先とログレベルは本番と同じ値に固定している。
  階層化の評価（`--scheme stage2`）は 1 件につき最大 2 回（2 回目は中項目を選ばせる要求）送る。`--scheme stage2|flat` は Gemini には送らない。
  `--provider gemini` でも、評価データを本番の処理を通して（先頭 100 文字に切って）Gemini に送る。評価用の Gemini の鍵は、
  本番と別の Google プロジェクトのものを使う（過去に本番の無料枠を使い切った）。

### 提供元（TypeSafe AI）の扱い

公式ページの記載に基づく（取得日 2026-10-24。WebFetch 経由で取得した内容で、**ブラウザでの原文確認は未了**）。

- プライバシーポリシー（https://typesafe.ai/legal/privacy-policy 、最終更新 2025-11-19）:
  - サービスは米国でホストされる。
  - 入力でモデルの学習・ファインチューニングをしない。入力はサービス提供者以外の第三者に開示しない。
  - 保持は「サービス提供に合理的に必要な期間」とだけ書かれ、具体的な期間はない。
- 利用契約（MCA。https://typesafe.ai/legal/mca 、最終更新 2026-09-23）:
  - 入力と出力が Customer Data。モデルの重みを変える学習に Customer Data を使うには、顧客の事前同意が要る。
  - 一方、Customer Data から生成した Telemetry（技術ログ、ハッシュ、要約統計、分類結果、指標など）は、
    サービス改善を含めて制限なく処理できる。
  - Customer Data を保存・保持する義務はなく、いつでも削除しうる。
  - 稼働を保証しない（SLA なし）。課金は前払いのクレジットで、自動リフィルはオプトイン。準拠法はカリフォルニア州法。
- DPA（https://typesafe.ai/legal/data-processing 、最終更新 2026-04-24）:
  - 保持は「処理の目的に照らして必要な期間」。
  - サブプロセッサの一覧は https://trust.typesafe.ai/subprocessors を参照と書かれているが、ページ本文を取得できなかった。
- 単価・レート制限・支出上限の公式な記載は確認できなかった。

**未確認事項**（原文を確認したら、この節を更新する）:

- API の入力・応答の具体的な保持期間。
- サブプロセッサの実名と地域。

あわせて、Telemetry に入力文そのものが含まれるかも未確認（定義に「分類結果」「ハッシュ」などは含まれるが、入力文が含まれるかは読み取れない）。

### 運用（マージ後に行う）

- Cloud Logging のログベース指標で `Jev classification failed` を数え、(a) 15 分で N 件以上（N は運用で決める）、
  (b) `status` が 401・402・403 のものが 1 件でもあれば（鍵・残高の問題は自然に回復しない）通知する。
- Jev の失敗率 = `Jev classification failed` の件数 ÷（その件数 + `provider` が `jev` の `Category classified` の件数）。
  退避の頻度 = `provider` が `gemini` の `Category classified` の件数。答えなし・選択肢にないカテゴリは別の警告
  （`Jev returned no category` / `Jev suggested a category outside the list`）で出るため、この式には入らない。
- bot は `firebase-functions/logger` を使わず `console.warn('…', {…})` で出すので、Cloud Logging では `textPayload` の 1 行になる。
  ログベース指標で `status` や `provider` を絞るには、`textPayload =~ "…"` の正規表現が要る。
- マージ後に、辞書に無い語を LINE で送り、`Category classified` の `provider` が `jev` になることを確かめる。
- 費用の天井: TypeSafe のクレジットは前払いで、自動リフィルを切る（または上限を決める）と、費用に天井ができる
  （単価・上限の公式な記載は確認できていない）。

## 8. 外部への送信と公開 Issue（要望・改善・不具合・フィードバックのコマンド）

LINE で「要望」「改善」「不具合」「フィードバック」で始まるメッセージを送ると、bot は本文の全文を Gemini に送って整理し、
`GITHUB_TOKEN` で公開リポジトリ `Makoto041/line-kakeibo` に Issue を作る（`bot/src/line/commands/feedback.ts`・
`bot/src/issueCreator.ts`）。Issue には整理した内容と元の本文が載る。Gemini の鍵（`GEMINI_API_KEY`）はカテゴリ分類の退避先と同じ。

公式アカウントは誰でも友だち追加できるため、分類と同じ Gemini の無料枠を使い切られたり（過去に使い切った記録がある）、
任意の文面の Issue を公開リポジトリに作られたりしないよう、次をすべて満たすときだけ受け付ける（#260）。
満たさなければ Gemini も GitHub も呼ばず、短い返信だけを返す。

- **送った人が、`DEFAULT_GROUP_ID` の世帯グループの有効メンバー**: 環境変数 `DEFAULT_GROUP_ID`（Gmail 取込が支出に付ける
  `groupId` と同じ）の `groupMembers/{DEFAULT_GROUP_ID}_{userId}` を `householdMembers.ts` の `readActiveMember` で読み、
  `isActive == true` で文書の `groupId`・`lineId` も一致するときだけ通す（LINE の postback の認可〔`postback.ts` の `presserAsMember`〕と
  同じ判定）。世帯ではないグループ（「グループ作成」で作った自分だけのグループ、以前に bot が LINE グループごとに作った
  グループなど）のメンバーや、無効化された元メンバーは通らない。読み取りは 1 回で一定で、送られるたびに読み、キャッシュしない
  （管理スクリプトでの無効化はすぐ反映される）。
  - どのトークから送っても、この 1 つの判定で決める。1 対 1、LINE グループ（世帯に紐づかないグループを含む）、
    複数人トーク（room）のどれも、1 対 1 と同じ扱い。
  - `DEFAULT_GROUP_ID` が未設定・空のとき、所属の確認に失敗したとき（Firestore の障害）は **受け付けない**（分類は失敗したら
    モデルを呼ぶが、こちらは公開 Issue を作る操作なので拒否側に倒す）。送った人の userId が無い（LINE グループで、Bot を
    友だち追加していない人）ときも、読まずに受け付けない。
- **本文が 1,000 文字以内**（コードポイントで数える。絵文字も 1 文字）。超えたら切らずに「内容が長すぎます」と返す。
  `createIssueFromFeedback` も同じ上限を確かめ、超えたら Gemini も GitHub も呼ばない。
- **同じ人が 10 分に 3 件まで**（`FEEDBACK_RATE_LIMIT` / `FEEDBACK_RATE_WINDOW_MS`）。数えるのはメンバーの確認と長さの確認を通った
  ものだけで、Gemini・GitHub を呼ぶ前に 1 件分を使う（Issue の作成に失敗しても戻さない）。

公開 Issue に載せる内容（`issueCreator.ts`）: 他人へのメンション、他の Issue・リポジトリへの参照（相互参照の通知）、HTML コメントでの
隠し文、リンク先の偽装を起こさないようにする。

- 元の本文は、本文中のバッククォートの最長の連続より長いフェンスのコードブロックに入れる（中は Markdown として解釈されない。
  空行で引用を抜けることもない）。
- Gemini が返したタイトル・概要・詳細・受け入れ条件（Gemini が使えないときに本文から作る代わりの文も）は、HTML コメント（中の隠し文ごと）・
  Markdown のリンク先（リンクと画像は表示する文字だけ残す）・参照リンクの定義を、変わらなくなるまで繰り返し除く（除いた跡から新しいコメントが
  できないように）。この除去は入れ子の角括弧（`[a [b] c](…)`・`[[x]](…)`）・改行をまたぐリンクやラベル・リスト項目の中の参照定義で
  迂回できるので、本文ではさらに角括弧 `[` `]` をエスケープし、リンク・画像・参照定義の構文そのものを成立させない（こちらが本線。
  受け入れ条件の `- [ ] ` は無害化の外で付ける。タイトルはリンクとして描画されないので対象外）。
  `@`・`#`（数字の前）・`GH-`・`://`・`www.`（`_www.` のように前が単語の文字でも）の直後にはゼロ幅スペースを挟む（`@user`・`@org/team`・
  `owner/repo#1`・`#1`・自動リンクが働かない）。HTML タグは正規表現で除かず（`<scr<b>ipt>` のように除いた跡から新しいタグができる。CodeQL
  `js/incomplete-multi-character-sanitization`）、1 文字ずつ無効にする: 本文では `& < >` を文字参照にし（タグは文字として表示され、
  HTML として働かない）、タイトル（HTML として描画されない）からは `<` `>` を除く。本文ではバッククォート・チルダ・バックスラッシュも
  エスケープする（コードブロックを開いて元の本文のフェンスを閉じさせない）。
- 長さの上限: タイトル 80 文字（無害化して空なら「LINE からのフィードバック」）、概要 500、詳細 2,000、受け入れ条件は 1 つ 200 文字で 5 つまで。
  ラベルは `user-feedback` と種別（機能要件 / 非機能要件の 2 値）で固定。
- 使い方の返信と、Issue を作れたときの返信に「公開リポジトリ（GitHub）の Issue に載ります。個人情報（カード番号・名義・住所など）は
  書かないでください」と付ける（プライバシーポリシー〔`web/app/(app)/privacy/page.tsx`〕にも公開 Issue に載ることを書いている）。

ログ: 拒否は `Feedback rejected: ...` の固定文と、伏せた利用者 ID（`maskId`）・長さなどのオブジェクトで出す。本文は出さない。
Gemini での整理に失敗したときも、例外の文言（本文や応答の断片が入りうる）は出さず、`Gemini feedback analysis error` の固定文と
エラー名（`errorName`）だけを出す（Gemini の呼び出しそのもののログは §7）。
`DEFAULT_GROUP_ID` が無いときは `Feedback rejected: DEFAULT_GROUP_ID is not set` を error で出す。

**残る制約**: 件数は関数のインスタンスのメモリで数える（Firestore には持たない）。webhook は `maxInstances: 10` なので、
リクエストが別々のインスタンスに振られると、同じ人でも最悪 10 分に 30 件まで通る。インスタンスの再起動・デプロイで件数は消える。
メンバー（2 名）だけが使えるようになったため、当面はこれで足りると判断した。厳密に数える必要が出たら、Firestore のカウンタ
（利用者ごとの文書をトランザクションで更新）に置き換える。`express-rate-limit`（`/household` などで使用）は HTTP の要求を
数える Express のミドルウェアで、1 回の webhook に複数のイベントが入りうるコマンドの件数には使えず、既定の保存先も
インスタンスのメモリなので、再利用していない。

## 9. ログの規約（bot）

Cloud Logging に、利用者の入力・伏せていない ID・秘密値を残さないための書き方。`bot/src/logSafe.ts` のヘルパーを使う。

- **固定文とオブジェクトで出す**: `console.error('固定文', { user: maskId(lineId), ...errorFields(error) })` のように、
  1 つ目の引数は固定の文字列にする。値をテンプレートリテラル（書式文字列）に埋め込まない（`%s` などの書式の解釈や、
  改行でログ行を偽造されるのを防ぐ。CodeQL の `js/tainted-format-string` の対象）。
- **ID は `maskId` で伏せる**: LINE の userId / groupId、Firebase の uid、支出・世帯・固定費・Gmail のメッセージの ID は、
  末尾 4 文字だけを出す。
- **例外は `errorFields(error)` で種類だけを出す**: 名前（`errorName`）、コード（`errorCode`。Firestore の gRPC のコードなどの数、
  `ECONNRESET` のような英大文字・数字・`_` だけの文字列、`auth/id-token-expired` のような Firebase の形の文字列、
  gaxios の打ち切り・中断の `TimeoutError` / `AbortError` のときだけ）、
  原因のコード（`errorCause`。`fetch failed` の `cause.code`）、HTTP の状態（`errorStatus`。LINE の API・Gmail API・axios）。
  例外そのもの・文言（`message`）・原因の文言は出さない。理由は次のとおり。
  - Firestore のエラーの文言には文書のパスが入る（例: `NOT_FOUND: No document to update: …/documents/groupMembers/{groupId}_{lineId}`）。
    文書 ID に LINE の ID を使う文書がある。
  - `JSON.parse` の `SyntaxError` の文言には、解釈しようとした文字列（利用者の入力・API の応答）の一部が入る。
  - 生の例外には、送ったリクエストの設定（gaxios・axios の `config`。Authorization ヘッダーのアクセストークン・GitHub のトークン）や、
    応答のヘッダー・本文（LINE の `HTTPFetchError`）が入る。
- 例外として、Gemini の API のエラーは HTTP ステータスと API のエラー文の先頭 300 文字を出す（§7）。
  次の ESLint の規則の唯一の例外で、`bot/src/geminiClient.ts` のその行に `eslint-disable-next-line` と理由を付けている。
- **ESLint で検査する**: `bot/eslint.config.mjs` の `no-restricted-syntax`（`bot/src/**/*.ts` の `console.log` / `warn` / `error` /
  `info` / `debug`。error）で、次の書き方を報告する。
  - 1 つ目の引数のテンプレートリテラルと、値（識別子）を含む `+` の連結（`'saved ' + id`）。固定の文字列どうしの連結
    （長い固定文の折り返し）は対象外。
  - `e` / `err` / `error` / 〜`Error` という名前の変数をそのまま渡すこと（`isError` / `hasError` のように `is` / `has` の次が
    大文字の名前は真偽値とみなして除く）。引数・オブジェクトの値（`{ error }`・入れ子を含む）・
    展開（`{ ...error }`）・配列・`` `${error}` ``・`'…' + error`・`String(error)`・`JSON.stringify(error)`・`error ?? null`・
    `as` / `!` を付けたものが対象。`errorFields(error)` のように関数に渡す・`error.response?.status` のようにプロパティを読む・
    `typeof error` / `instanceof` は対象外。
  - `.message` / `.stack` を読むこと（`(error as Error).message`・`err?.message`・関数の引数の中を含む）。
    名前が `message` のプロパティはすべて対象にしている（LINE のイベントの `event.message.text` も利用者の入力のため）。
  - **誤検知の例と回避策**: 次は値をそのまま出さないが報告される。ログの外で別の名前の変数に入れてから渡すか
    （`const messageType = event.message.type;` → `{ type: messageType }`）、その行に理由付きの
    `eslint-disable-next-line no-restricted-syntax -- 理由` を付ける。誤検知の除外は次の「例外」に当たらないので、この節への追記は要らない。
    - `console.log('Unhandled', { type: event.message.type })`（LINE のイベントの `message` が `.message` の規則に当たる）
    - 〜`Error` という名前の、例外でない値（`{ validationError: '金額が空' }` のような固定の値を入れた変数）
  - **例外**（値を出すことを認めるもの）を足すときは、この節に理由を書いてから、その行に
    `eslint-disable-next-line no-restricted-syntax -- 理由` を付ける。今は上の Gemini の行だけ。
  - **検出できないもの**（レビューで見る）: 名前と書き方で判定するため、別の名前の変数（`ex`・`reason`）、分割代入した `message`、
    一度変数に入れた文言、`ok && error`（`&&` の右側。`error && error.code` を誤検知しないため対象外）、`console['error'](…)` の
    ように角かっこで呼ぶもの、タグ付きテンプレート（`` String.raw`…${id}` ``）、1 つ目の引数に変数をそのまま渡すもの。
  - **テストと強制**: CI の lint（`ci-cd.yml` の `npm run lint`）は失敗しても落ちない（`|| echo` で警告にする）。この規則は
    `bot/scripts/smoke-log-lint.js`（`npm -w bot test`。CI の build-and-test で実行）で強制する。違反と適合の例の文字列を ESLint の
    Node API で検査するほか、実際の `bot/src/**/*.ts` を検査して、この規則の報告（と、使われなくなった `eslint-disable`）が 0 件で、
    規則の重さが error であることを確かめる。手元では `npm -w bot run lint`（違反があると終了コードが 1）でも気づける。
- 自前の固定文の例外は名前を付けて投げる（`TimeoutError`・`LineCredentialsMissingError`・`GmailTokenMissingError` など）。
  文言を出さないログでも、`errorName` で原因を見分けられるようにするため。
- **関数の外へ投げる例外は固定文にする**: 関数の外へ投げた例外は、`console.*` を通らずに実行環境が Cloud Logging に出す。
  functions-framework（Pub/Sub の関数）は `console.error(err.stack || err)` で名前・文言・スタックを、
  firebase-functions のスケジュール関数（`onSchedule`）は `logger.error(err.message)` で文言を出す。そのため、関数の外へ
  投げるところでは、元の例外を `errorFields` でログに出してから、名前を付けた固定文の Error を投げる。
  - `bot/src/gmail/handler.ts` の `handleGmailPubSub`（`GmailImportError`。Pub/Sub の再送のために投げる）、
    `bot/src/index.ts` の `renewGmailWatch`（`GmailWatchRenewalError`）・`postRecurringExpenses`（`DailyBatchError`。
    失敗した件数はオブジェクトでログに出す）。投げるかどうか（再送・再試行が働くか）は元の例外のときと同じ。
  - 元の例外は `cause` に付けない。`err.stack` には `cause` が入らないので実行環境のログでは診断に使えず、
    `console.error(err)`（`util.inspect`）で出すと `cause` の文言・項目まで出るため。
  - `importMoneyForward`・`syncUserLinks` は何もしない関数で、投げない。HTTP の関数（`webhook`・`api`）のルートは、
    例外を受けて固定文で応答する。
- **既知の例外（アプリ側では安全に防げない）: 解析できない本文が、そのままログに出る**: HTTP の関数（`webhook`・`api`。
  どちらも認証なしで呼べる）では、functions-framework がアプリより先に本文を解析する（body-parser）。
  解析に失敗すると（`Content-Type: application/json` の壊れた JSON など）、そのエラー（`type: 'entity.parse.failed'`。`body` に生の本文、
  文言に本文の断片）が functions-framework の Express の既定のエラー処理に渡り、`console.error(err)` で本文ごと出る
  （LINE の署名の検証より前。応答は 400）。アプリの Express app（`webhookApp` のエラーハンドラ・`api` の `express.json()`）
  には届かない。
  - functions-framework には、本文の解析を止める設定も、解析の前に処理を差し込む口も無い（設定は port・target・
    signature-type・timeout・ignored-routes・log-execution-id だけ）。
  - 防ぐ方法は 2 つあるが、どちらも採らない。`console.error` をプロセス全体で包んで書き換える方法は、ほかのログ
    （実行環境・ライブラリのもの）まで変えうる。環境変数 `NODE_ENV=test` にする方法（Express が既定のエラー処理でログを
    出さなくなる）は、functions-framework が関数の失敗の文言（`err.message`）を HTTP の応答で返すようになる
    （functions-framework の `logger.js` は `NODE_ENV !== 'production'` のときに文言を返す。本番は `NODE_ENV=production`
    の前提で、そのときは状態だけを返す）。
  - 取り込みたくなければ、Cloud Logging の除外フィルタで取り込まないようにする（次の手順。オーナーが行い、エージェントは
    実行しない）。除外は記録を伏せるのではなく取り込まない（ログベースの指標・アラートにも使われない）。取り込み済みの
    ログは保持期間（`_Default` は 30 日）まで残る。
    1. 本番に出ているかを、ログ エクスプローラ（`line-kakeibo-0410`）で次のクエリで確かめる（Cloud Functions 第 2 世代の
       ログは `cloud_run_revision` の項目で、サービス名は関数名の小文字）。1 件の項目の `textPayload` に、
       `entity.parse.failed` と `body: '…'` の行がそろっているか（複数行の出力が行ごとの項目に分かれていないか）を見る。

       ```
       resource.type="cloud_run_revision"
       resource.labels.service_name=("webhook" OR "api")
       textPayload:"entity.parse.failed"
       ```

    2. そろっていれば、同じ条件の除外を `_Default` シンクに足す（コンソールの「ログ ルーター」→ `_Default` の
       「シンクを編集」→「除外フィルタを追加」。または次のコマンド）。このコマンド・条件は本番では実行・確認していない。

       ```bash
       gcloud logging sinks update _Default --project=line-kakeibo-0410 \
         --add-exclusion='name=body-parse-failed,filter=resource.type="cloud_run_revision" AND resource.labels.service_name=("webhook" OR "api") AND textPayload:"entity.parse.failed"'
       ```

    3. 行ごとの項目に分かれていれば、上の条件では本文の行（`body: '…'`）と文言の行（`SyntaxError: … JSON …`）が
       外れない。次の条件を手順 1 のクエリとして実行し、外したい項目だけに当たることを確かめてから除外にする
       （確かめていない案）。

       ```
       resource.type="cloud_run_revision"
       resource.labels.service_name=("webhook" OR "api")
       (textPayload:"entity.parse.failed" OR textPayload=~"^\s*body: '" OR textPayload=~"^SyntaxError: .*JSON")
       ```

- テストは `bot/scripts/smoke-log-safety.js`（例外の文言・文書のパス・ヘッダーに入れた目印がログに出ないこと。
  postback の認可の拒否のログ〔押した人・支出の ID は伏せ、action は既知の名前だけ〕を含む）と
  `bot/scripts/smoke-function-errors.js`（関数の外へ投げる例外・functions-framework と firebase-functions が出すログ・
  Gmail の失敗の記録に目印が無いこと、再送の判定が変わらないこと）。
  HTTP の応答や管理 API の戻り値（`/gmail/*` の `error`・`message`）は対象外（ログではない）。

## 10. 管理 API（`/gmail/*`）のレート制限

`bot/src/gmail/adminRouter.ts`。`ADMIN_SECRET`（`Authorization: Bearer`）で守る管理 API の上限。

- **総当たりへの耐性は `ADMIN_SECRET` の強度による**（128 bit 以上のランダム。`openssl rand -base64 32` などで作り、
  32 文字以上にする。`docs/SETUP.md`・`bot/.env.example`）。下の認証前の枠は推測の回数を制限しない。前後の空白を落として
  32 文字より短いと、管理 API の最初の要求で固定文の警告（`ADMIN_SECRET is shorter than the recommended 32 characters; ...`）を
  プロセスごとに 1 回出す（値も長さも出さない）。本番の値の長さは確かめていないので、短くても 503 にはしない
  （管理の操作が止まるため）。この警告が出たら、`firebase functions:secrets:set ADMIN_SECRET` で差し替えて再デプロイする。
- **キーは接続元の IP**: `X-Forwarded-For` の末尾で数える。`/household` の認証前の上限と同じ関数（`householdApi.ts` の
  `clientIpKey`）を使う。Google のフロントエンドが末尾に接続元の IP を足す前提で、実測では確かめていない（#173 の docs にも
  実測の記述は無い）。`trust proxy` は設定していないので、`req.ip` は Cloud Run の前段のアドレスにまとまる。以前は既定の
  キー（`req.ip`）だったため、認証の無い要求を 1 分に 30 回送り続ければ、正規の管理者（トークンが漏れたときに revoke を
  急いで呼ぶ場合を含む）もこの limiter で 429 になりえた。
- **枠を認証の前後で分ける**（`/callback` 以外の全ルート。並びは `adminGuards`）:
  - 認証の前（`adminPreAuthLimiter`）: 認証に失敗する要求だけを数える（接続元ごとに 30 回/分）。認証に成功する要求は
    `skip` で数えも止めもしない。**推測の回数は制限しない**（枠を使い切った接続元でも、正しい値の要求は通るので、
    200 が返るまで推測を続けられる）。目的は、連打による負荷の分離と、認証に失敗する要求の可視化（401 の warn と 429）。
    以前（`req.ip` で、成功も失敗も 30 回/分/インスタンス）は推測の回数も抑えていたので、その点は後退している。
  - 認証の後（`adminPostAuthLimiter`）: 認証に成功した要求の上限（接続元ごとに 30 回/分）。取込・分類・LINE の通知を
    呼ぶ操作の連打を抑える。
- **採らなかった案**: `skip` をやめて「認証に失敗した要求だけを数え、枠を超えたら正しい値の要求も 429 にする」
  （`skipSuccessfulRequests` など）と、推測の回数は抑えられる。ただし、接続元が共通のアドレスにまとまる環境
  （`X-Forwarded-For` の末尾が Google のフロントエンドの付けた値でない・読めない場合）では、認証の無い連打で正規の
  管理者が締め出される。上のとおり末尾の値は実測で確かめていないので、締め出しを避ける側を選び、総当たりへの耐性は
  秘密値の強度に置く。
- `/callback`（Google からのリダイレクト先。Admin 認証なし）は、接続元ごとに 5 分で 20 回。
- **残る制約**: 数はインスタンスのメモリで数える（`api` は maxInstances: 5 なので、最大その倍数まで通る）。アプリ内の
  limiter で 429 にならなくても、認証の無い要求を並行で大量に送られると、インスタンスが埋まり Cloud Run 自体が
  429 / 503 を返しうる。
- テストは `bot/scripts/smoke-gmail-watch.js`（ルーターのスタックを走査して全ルートに同じ並びが付くこと、
  `X-Forwarded-For` の末尾で枠が分かれること、認証の無い連打で管理者の要求が 429 にならないこと、短い `ADMIN_SECRET` の警告）。
