# CLAUDE.md — line-kakeibo（Claude Code 向け）

LINE 連携の家計簿アプリ（ふたり暮らし向け）。既存の CI を尊重しつつ、環境（Mac / サーバ / クラウド）を問わず同じ「しきたり」で作業するための共通ルール。

## 構成（npm workspace）

- `web/` … Next.js 16（App Router）。Firebase クライアント SDK で読み取り、状態を変える操作は bot の API 経由
- `bot/` … Firebase Functions gen2（Node 22 / Express）。LINE webhook、Gmail 取込、`/auth/line`、`/household/*`、スケジュール関数
- `docs/` … `ARCHITECTURE`（構成）/ `SPECIFICATION`（仕様）/ `SETUP`（環境構築・デプロイ）/ `SECURITY_OPERATIONS`（ルール・世帯運用）/ `GMAIL_AUTO_SPEC`
- `scripts/` … 世帯メンバー管理（`manage-group-members.mjs`、既定 dry-run）、アイコン生成
- `test/` … Firestore / Storage ルールのテスト（エミュレータ）
- `firestore.rules` / `storage.rules` / `firestore.indexes.json` … CI がデプロイする

## コマンド

```bash
npm -w web run dev | build | lint | test      # web。test は node --test __tests__/*.test.mjs
npm -w bot run dev | build | test             # bot。test = build + scripts/smoke-*.js
npm -w bot run test:emulator                  # /household API・固定費の統合テスト（Firestore/Auth エミュレータ、Java 21）
npm run gen:icons                             # LINE カード用アイコンを web/public/icons に生成
```

型チェックは `npx tsc --noEmit -p web` / `npx tsc --noEmit -p bot`。ルールのテストの実行方法は `docs/SETUP.md §6`。

## 開発フロー（毎回この手順で進める。ユーザーの再指示は不要）

1. **Fable レビュー**: 非自明な実装は Agent ツール（`model: fable`）でサブエージェントを指名し、設計 / コードレビュー → Blocking / Should-fix を修正・再確認してから PR。
2. **自走 PR → マージ**: **master への直コミット禁止**。ブランチを切って PR（ドラフト可）を作成し、CI（`ci-cd.yml`: 型・lint・ビルド・テスト・CodeQL / `pr-checks.yml`: ルールのテスト）の完了を待ち、指摘があれば修正、無ければ squash マージまで自走する。
3. **検証**: build / type-check / lint / test をローカルで通してから PR にする。bot の変更は `test:emulator`、ルールの変更は `test/*.rules.test.mjs` も通す。
4. **PR タイトルは Conventional Commits**（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:` / `ci:`、任意で `(web)` `(bot)` スコープ）。squash マージのコミットになり、リリースノートに使われる。
5. **設計 / UX を変える変更はまずモック**: 方向性の合意を得てから実装に入る。サーバー環境で作業していて実機で見せたい場合は、下記「サーバー環境でのプレビュー」で URL を渡し、実機（iPhone / Mac など SP・PC 両方）で確認してもらう。
6. **マージ後の確認**: Web は Vercel の Git 連携、Bot とルールは `ci-cd.yml` の `deploy-bot` が自動デプロイする。デプロイの成功と本番の疎通（webhook の署名なし 401、`/household/*` のトークンなし 401、Web の主要ページ 200）を確認して報告する。
7. **タグ（リリース）**: 実装を master にマージするたびに `release.yml` が SemVer のタグ `vX.Y.Z` と GitHub Release を自動で作る。上げ幅は前のタグ以降のコミット件名（= PR タイトル）で決まる: `feat` → minor、`!` / 本文行頭の `BREAKING CHANGE:` → major、`fix` / `perf` / `refactor` / `revert` → patch、`docs` / `chore` / `ci` / `test` だけならタグなし。**バージョンは git タグが正**で、`package.json` の `version` は使わない（コミットしない）。まとめて上げたいときや手動で打つときは、Actions の `Release Tag` を master 上で `workflow_dispatch`（`version` を指定）。GitHub UI の Revert は `Revert "..."` になり判定されないので `revert: ...` に改題する。マージ後の報告にはタグ名を含める。

## サーバー環境でのプレビュー（tailnet 経由で実機確認）

サーバー（`debian-ai`）で作業中に、モックや変更を **iPhone / Mac の実機ブラウザ（SP・PC 両方）**で見せたいときの手順。共通の前提: tailnet IP のみにバインドして tailnet 内限定で配信（`0.0.0.0` は不可）。URL は `http://<tailscale-ip>:PORT/` か `http://debian-ai.<tailnet>.ts.net:PORT/`（MagicDNS 名）を渡す。停止は `fuser -k <port>/tcp`（`pkill -f http.server` は自分自身のコマンド文字列にマッチして落ちるため使わない）。

- **A. 静的モック（HTML 単体）**: リポジトリ直下は `.env` 等の secret を含むため配信禁止。secret を含まない専用ディレクトリへ HTML を `index.html` としてコピーし、`python3 -m http.server 8000 --bind "$(tailscale ip -4)"` で配信。
- **B. 実アプリ / レスポンシブ確認（web）**: Next dev を tailscale IP にバインド。`npm -w web run dev -- -H "$(tailscale ip -4)"`（既定 3000）。Next は任意ファイルを列挙配信しない（`.env` 非露出）ため実アプリ直出しでよい。PC ブラウザで幅を変えればレスポンシブ切替を実データで確認できる。

補足: `tailscale serve`（HTTPS）は tailnet 側で要有効化（管理コンソール）。未有効なら上記の tailnet IP 直アクセス方式を使う。

## 全環境共通の規約

- **ライブ配信物に生成ツールの痕跡を残さない**: 公開される web の HTML/CSS/JS（第三者が DevTools/View Source で見える成果物）に、AI/ツール由来の文字列・メタ・可視コメント・attribution を残さない。本番ビルドは minify でコメント除去されるため通常は自然に満たされる。**GitHub のソース/コミット履歴・`.github/` は対象外**（判断基準は「通常のサイトから見えるか」だけ）。
- **`package-lock.json` を消さない・作り直さない**。依存の追加・削除は `npm -w <ws> install|uninstall <pkg>` で差分だけ更新する。
- **`next dev` は AI エージェント環境を検出すると `web/AGENTS.md` / `web/CLAUDE.md` を勝手に作る**。作業後に `git status` で未追跡ファイルを確認し、コミットしない。
- **ログに利用者の入力を書式文字列で埋め込まない**（CodeQL の指摘対象）。`console.warn("...", { id: maskId(x) })` のようにオブジェクトで渡し、ID は `logSafe.ts` の `maskId` で伏せる。
- 世帯は 2 名固定。メンバーの追加・無効化は bot ではなく `scripts/manage-group-members.mjs` で行う（`docs/SECURITY_OPERATIONS.md`）。

## 環境変数（値は秘匿。`.env*` は gitignore 済み・手動配置）

- **web**（`web/.env.local`）: `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_LIFF_ID`, `NEXT_PUBLIC_AUTH_ENDPOINT`, `NEXT_PUBLIC_API_BASE`（任意）
- **bot**（`bot/.env`）: `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_TOKEN` / `LINE_LIFF_CHANNEL_ID`, `ADMIN_SECRET`, `GEMINI_API_KEY`, `GITHUB_TOKEN`, `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REDIRECT_URI`, `FIREBASE_PROJECT_ID`, ローカルの Admin SDK 認証は `GOOGLE_APPLICATION_CREDENTIALS`。本番は Firebase Secret Manager（`firebase functions:secrets:set`）から関数に渡す
- 各 `.env.example` を基準に不足キーを確認する。**秘密値は画面に表示しない・ログに出さない・コミットしない**。新しい環境（サーバ等）では既存 `.env` を上書きせず、バックアップ / 差分確認してから配置し `chmod 600`。
