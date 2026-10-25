# セキュリティ運用メモ（世帯メンバー・ルール・Storage・外部送信）

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
  - LINE グループに紐づくアプリ内グループが無い場合も、自動では作らない。
  - LINE の「参加 <コード> <表示名>」コマンドは無効化済み（招待コードが漏れると第三者が参加できてしまうため）。
- LINE グループから **退出・削除されたメンバー**（`memberLeft` イベント）は、bot が `isActive:false`、`leftAt`、
  `deactivatedReason: 'line_member_left'` を書き込む。その時点から Web の閲覧・編集・レシート操作ができなくなる。
  - 自分が登録した支出の **読み取り**だけは残る。web の個人支出クエリ（`where('lineId','==',自分)`）を
    ルールで証明できるようにするため。更新・削除・レシート操作はできない。
  - 無効化の対象は、その LINE グループに紐づくアプリ内グループ（`groups.lineGroupId` が一致）のメンバーシップだけ。
    世帯グループが LINE グループに紐づいていない（`list` の「LINE:」が `(なし)`）と何も無効化できず、bot は
    `No app group is linked to LINE group ...` の警告ログを出す。したがって `list` で世帯グループに LINE の ID が
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

**マージ前に必ず確認すること**（§4 のマージ前チェックと合わせて行う）: `list --show-ids` で次の 2 点を確かめる。

- (a) 世帯グループの「LINE:」欄が、実際に使っている世帯の LINE グループ ID と一致している。
- (b) オーナーとパートナーの 2 名が、**その**グループで「有効」になっている。

bot は、発言元の LINE グループに紐づくグループ（`groups.lineGroupId` が一致）で発言者が有効なメンバーでない限り、
LINE グループでの発言を `groupId` も `lineGroupId` も持たない個人支出として保存する（`bot/src/expenseGroupScope.ts`）。
(a) か (b) が崩れていると、マージ直後からオーナー本人の LINE グループでの発言が Web 一覧・LINE 集計・精算から消える。
このとき bot は `... is not an active member of the group linked to LINE group ...; saving as personal expense` の
警告ログ（`console.warn`）を出す。

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
  `subCategory`（中項目。任意）は 50 文字以内の文字列で、削除もできる（Web は大項目を変えるとき、中項目の削除も常に送る）。
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
（無ければ A か B で付与する）。あわせて §2 の「マージ前に必ず確認すること」(a)(b) を確認する。PR 本文のチェックボックス「IAM ロール付与済み・確認済み」にチェックしてからマージする。

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
  （正準名 19 種と、正準名に揃えられるカルーセルの旧名。32 文字以内の文字列）にある値だけを保存する。
  残る制約: `lineGroupId` だけを持つ旧形式の支出は、LINE でも区分・OK・カテゴリを変えられない（「変更できるのは、世帯のメンバーだけです」）。
  変えたいときは §2 の `backfill-group-id` で `groupId` を補う。
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
