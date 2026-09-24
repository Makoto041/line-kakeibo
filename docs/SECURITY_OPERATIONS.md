# セキュリティ運用メモ（世帯メンバー・ルール・Storage）

家計簿の Web アクセス権は Firestore の `groupMembers/{groupId}_{lineId}` の `isActive == true` で決まる
（`firestore.rules` / `storage.rules` の両方がこれを見る）。この文書は、その運用と一度だけ必要な設定をまとめる。

## 1. 世帯は2名固定

- 世帯（アプリ内グループ）の有効なメンバーはオーナーとパートナーの **2 名だけ**にする。
- bot は **メンバーを自動で追加しない**。
  - LINE グループで支出らしい発言をしても、`groupMembers` は作られず、無効なメンバーが再有効化されることもない。
    有効なメンバーでない人の支出は `groupId` を持たないので、世帯の Web 一覧には出ない。
  - LINE グループに紐づくアプリ内グループが無い場合も、自動では作らない。
  - LINE の「参加 <コード> <表示名>」コマンドは無効化済み（招待コードが漏れると第三者が参加できてしまうため）。
- LINE グループから **退出・削除されたメンバー**（`memberLeft` イベント）は、bot が `isActive:false`、`leftAt`、
  `deactivatedReason: 'line_member_left'` を書き込む。その時点から Web の閲覧・編集・レシート操作ができなくなる。
  - 自分が登録した支出の **読み取り**だけは残る。web の個人支出クエリ（`where('lineId','==',自分)`）を
    ルールで証明できるようにするため。更新・削除・レシート操作はできない。
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
```

環境変数: `FIREBASE_PROJECT_ID`（既定 `line-kakeibo-0410`）、`GCLOUD_BIN`（既定 `gcloud`）。

**リリース後に一度やること**: `list` で有効なメンバーを確認する。過去の自動追加で 3 人目以降が有効になっていれば、
`deactivate-unknown` で無効化する。

## 3. Firestore ルールの要点（`firestore.rules`）

- `expenses` の作成: LINE 本人確認済みで `lineId == 自分`、許可フィールドだけ、型と範囲を検証
  （`amount` は 0〜10,000,000 の数値、`date` は `YYYY-MM-DD`、文字列は長さ上限あり）。
  `groupId` を付けるなら、そのグループの有効なメンバーで、`lineGroupId` はグループのものと一致すること。
  `groupId` を付けずに `lineGroupId` だけを持つ支出は作れない。LINE の集計にだけ入る支出を注入できないようにするため。
- `expenses` の更新: web が実際に編集するフィールドだけを変更できる（許可リスト）。
  `amount` / `description` / `date` / `category` / `includeInTotal` / `payerId` / `payerDisplayName` / `receiptUrl` / `updatedAt`。
  それ以外（`lineId` / `groupId` / `lineGroupId` / `createdAt` / `inputSource` / `status` / `advanceBy` など）は不変。
  変更は bot（Admin SDK）だけが行う。`receiptUrl` は `https://firebasestorage.googleapis.com/` から始まる URL に限る。
- 精算済み（`status == 'advance_settled'`）の支出は、金額・日付の変更と削除ができない。
- グループ支出の更新・削除は有効なメンバーに限る。

web で編集できる項目を増やすときは、`editableExpenseKeys()` と `test/firestore.rules.test.mjs` を更新すること。

## 4. Storage ルールと、一度だけ必要な IAM 設定（`storage.rules`）

レシート（`receipts/{expenseId}/{fileName}`）は cross-service rules（`firestore.get()` / `firestore.exists()`）で
支出と `groupMembers` を参照し、所有者と有効なメンバーだけに get、アップロード、削除を許す。list はできない。
アップロードは 5MB 以下の JPEG / PNG / WebP / HEIC / HEIF に限る（SVG と GIF は不可）。

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

## 5. ルールのテスト

`test/firestore.rules.test.mjs` と `test/storage.rules.test.mjs` を、エミュレータで実行する
（PR では `pr-checks` の `rules-tests` ジョブが実行する）。

```bash
npm i --no-save @firebase/rules-unit-testing firebase-tools@15
npx firebase emulators:exec --only firestore,storage --project demo-kakeibo \
  "node test/firestore.rules.test.mjs && node test/storage.rules.test.mjs"
git checkout -- package.json package-lock.json   # --no-save でもロックファイルが変わった場合
```

Java 21 以上が必要。HTTP(S) プロキシ環境では、Storage エミュレータから Firestore エミュレータへの
cross-service 参照もプロキシに送られて失敗することがある。その場合は `HTTP_PROXY` / `HTTPS_PROXY` を外して実行する。

## 6. 既知の残課題

- `syncUserLinks` トリガーは書き込みを止めた空の関数として残している。関数を export から外すと、
  CI の非対話デプロイが関数の削除確認で失敗するため。不要になったら、手動で `firebase functions:delete syncUserLinks` を実行する。
- レシートはトークン付きのダウンロード URL を `receiptUrl` に保存している。この URL は Storage ルールを経由しない（REC-SEC-2）。
  パスを保存する方式への移行は、別の PR で扱う。
- LINE の postback（区分・立替の変更）で、押した人のメンバーシップを確認していない（SET-18）。
