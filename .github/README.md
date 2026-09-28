# GitHub Workflows

## 概要

このディレクトリには、line-kakeibo プロジェクトの CI / セキュリティチェック / Bot デプロイの GitHub Actions ワークフローが含まれています。

- ブランチ運用: `master` が本番。作業ブランチを切って PR → CI 完了 → squash マージ（`develop` ブランチは廃止）
- Web（`web/`）のデプロイは GitHub Actions ではなく **Vercel の Git 連携**が行う（PR ごとにプレビュー、`master` へのマージで本番）
- Bot（Firebase Functions）と Firestore / Storage ルール・インデックスのデプロイは `ci-cd.yml` の `deploy-bot` が行う
- リリース: `release.yml` が master への実装のマージごとに SemVer タグ `vX.Y.Z` と GitHub Release を自動作成（`feat` → minor、`!` / `BREAKING CHANGE` → major、`fix` / `perf` / `refactor` / `revert` → patch、`docs` / `chore` / `ci` / `test` はタグなし）。手動は `Release Tag` を `workflow_dispatch`（`version` 指定）

## ワークフロー一覧

### `ci-cd.yml` — CI / Bot デプロイ

トリガー: `master` への push、`master` 向け PR、`workflow_dispatch`（`master` 上で実行すると `deploy-bot` も走る）。PR では新しい push で古い run を打ち切るが、`master` push はデプロイを含むため打ち切らない。

| ジョブ | 実行条件 | 内容 |
|---|---|---|
| `changes` | 常に | `dorny/paths-filter` で `web` / `bot`（`bot/**`・`firebase.json`・`.firebaserc`・`firestore.rules`・`firestore.indexes.json`・`storage.rules`）/ `deps` の変更を検知 |
| `install-deps` | PR、または上記に変更あり | `npm ci` と `node_modules` のキャッシュ |
| `lint` | PR、または web / bot に変更あり | web / bot それぞれで `npm run lint` と `npx tsc --noEmit`。**失敗は警告扱い**（ジョブは落ちない） |
| `build-and-test` | 同上 | web / bot それぞれで `npm run build` と `npm test`（テストの失敗はジョブを落とす）。bot の `dist` を成果物として保存 |
| `security` | PR のみ（`continue-on-error`） | `npm audit`、TruffleHog（verified secret のみ）、CodeQL（javascript-typescript） |
| `deploy-bot` | `master` への push で bot / ルールに変更あり、または `master` 上の `workflow_dispatch` | `production-bot` Environment。`GCP_SA_KEY` の存在確認 → `google-github-actions/auth` → Storage cross-service rules に必要な IAM ロールの事前確認（確認できなければ `storage` を除外して警告） → `firebase deploy --only functions,firestore:rules,firestore:indexes[,storage]` |
| `post-deploy-check` | `deploy-bot` 成功後 | `https://asia-northeast1-<project>.cloudfunctions.net/webhook/health` への疎通確認（リトライあり）と Slack 通知（`SLACK_WEBHOOK_URL` があれば） |

### `pr-checks.yml` — PR ごとの追加チェック

トリガー: `master` 向け PR。`ci-cd.yml` に無いものだけを置く。

| ジョブ | 内容 |
|---|---|
| `rules-tests` | Firestore / Storage エミュレータ（Java 21）で `test/firestore.rules.test.mjs` と `test/storage.rules.test.mjs` を実行。テスト用ツール（`firebase-tools@15` / `@firebase/rules-unit-testing@5` / `firebase@12`）はリポジトリ外に `--no-save` で入れる。デプロイには関与しない |

## セットアップ

### 必要な Secrets / Environment

`production-bot` Environment の Secrets:

```bash
# Firebase デプロイ用のサービスアカウント鍵（JSON）。未設定だと deploy-bot は最初のステップで失敗する
GCP_SA_KEY={"type":"service_account",...}
```

`onRequest({ secrets: [...] })` を使う関数をデプロイするため、このサービスアカウントには Cloud Functions / Cloud Run のデプロイ権限に加えて Secret Manager の参照権限が必要。Storage ルールを CI からデプロイするには `resourcemanager.projects.getIamPolicy` も要る（無ければ `storage` はスキップされ、警告が出る。`docs/SECURITY_OPERATIONS.md` §4）。

任意の Secrets:

- `FIREBASE_PROJECT_ID` … 未設定なら `line-kakeibo-0410` にフォールバック
- `SLACK_WEBHOOK_URL` … `post-deploy-check` の通知先。未設定でも失敗しない

旧構成の `FIREBASE_TOKEN`（`firebase login:ci`）と `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` は、現在どのワークフローも使っていません（Web のデプロイは Vercel の Git 連携）。

### ローカル検証

```bash
# web のテスト（node --test）
npm -w web test

# bot のビルドとスモークテスト
npm -w bot test

# bot の /household API と固定費を Firestore / Auth エミュレータで検証（firebase-tools を PATH に置く）
npm -w bot run test:emulator

# Firestore / Storage ルールのテスト（JDK 21 が必要）。ツールはリポジトリの外に入れて
# package-lock.json を汚さない。手順は docs/SETUP.md §6 を参照
```

## デプロイとロールバック

- **Bot / ルール**: `master` へのマージで自動デプロイ。再デプロイや復旧は、`master` 上で `ci-cd.yml` を `workflow_dispatch` で実行する（`deploy-bot` が走る）。前のコードに戻すには revert コミットをマージするか、その状態で `workflow_dispatch` する
- **Web**: Vercel の Git 連携が `master` へのマージで本番反映する。ロールバックは Vercel ダッシュボード（Deployments）から以前のデプロイを Promote する
- `deploy-bot` が `storage.rules` をスキップした場合（ジョブサマリーに警告）は、`docs/SECURITY_OPERATIONS.md` §4 の手順で IAM ロールを付与してから再実行するか、手元から `firebase deploy --only storage` を対話実行する

## トラブルシューティング

### ワークフローが実行されない

- `.github/workflows/*.yml` の構文を確認
- `deploy-bot` は `master` への push で bot / ルール類に変更があるときだけ走る（web だけの変更では走らない）
- Environment `production-bot` と Secrets が設定されているか確認

### 実行が失敗する

```bash
# ログ確認
gh run view <run-id> --log

# 再実行
gh run rerun <run-id>
```

### デプロイエラー

- `GCP_SA_KEY` の有無と権限（Secret Manager / Cloud Run / IAM 参照）を確認
- `google-github-actions/auth` が `must specify exactly one of "workload_identity_provider" or "credentials_json"` で落ちる場合は `GCP_SA_KEY` 未設定
- `post-deploy-check` の `/health` は webhook 関数（asia-northeast1）のルート。us-central1 直下の `/health` は存在しない

## 参考リンク

- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Firebase CLI Documentation](https://firebase.google.com/docs/cli)
- [Vercel Git Integration](https://vercel.com/docs/git)

## ライセンス

このプロジェクトのライセンスに従います。

---

<sub>Last updated: 2026-09-28</sub>
