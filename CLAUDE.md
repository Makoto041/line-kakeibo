# CLAUDE.md — line-kakeibo（Claude Code 向け）

LINE 連携の家計簿アプリ。既存の CI / AIレビュー群を尊重しつつ、環境（Mac/サーバ）を問わず同じ「しきたり」で作業するための共通ルールを定義する。

## 構成（npm workspace）

- `web/` … Next.js（Firebase 連携のフロントエンド）
- `bot/` … LINE Bot（`ts-node-dev`、LINE Messaging API / Gemini / Gmail 連携）

## コマンド

```bash
# web（Next.js）
npm -w web run dev | build | start
# bot
npm -w bot run dev      # ts-node-dev
npm -w bot run build    # tsc
```

## 開発フロー（毎回この手順で進める。ユーザーの再指示は不要）

1. **Fable 5 レビュー**: 非自明な実装は Agent ツール（`model: fable`）でサブエージェント指名し設計/コードレビュー → Blocking/Should-fix を修正・再確認してから PR。
2. **自走 PR → マージ**: **master への直コミット禁止**。ブランチを切って PR を作成し、既存の CI / AIレビュー群（`.github/workflows/` の `pr-checks` / 各 review / `vercel-deploy` など）の完了を待ち、指摘があれば修正・無ければ squash マージまで自走する。
3. **検証**: build / type-check / lint をローカルで通してから PR にする。
4. レビュー方針・ロードマップの詳細は `.github/docs/`（`AI_REVIEW_GUIDE` 等）を参照。

## 全環境共通の規約

- **ライブ配信物に生成ツールの痕跡を残さない**: 公開される web の HTML/CSS/JS（第三者が DevTools/View Source で見える成果物）に、AI/ツール由来の文字列・メタ・可視コメント・attribution を残さない。本番ビルドは minify でコメント除去されるため通常は自然に満たされる。**GitHub のソース/コミット履歴・`.github/` は対象外**（判断基準は「通常のサイトから見えるか」だけ）。

## 環境変数（値は秘匿。`.env*` は gitignore 済み・手動配置）

- **web**（`web/.env.local`）: `NEXT_PUBLIC_FIREBASE_*`, `MFKAKEIBO_TOKEN`, `NEXT_PUBLIC_DISABLE_REALTIME`
- **bot**（`bot/.env` / `bot/.env.local`, ルート `.env`）: `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_TOKEN` / `LINE_GROUP_ID` / `DEFAULT_GROUP_ID`, `GMAIL_REDIRECT_URI`, `ADMIN_SECRET`, `GEMINI_API_KEY`, `FIREBASE_PROJECT_ID`, Firebase Admin 認証（`GOOGLE_APPLICATION_CREDENTIALS` の JSON **または** 本番は `FIREBASE_SA_BASE64`）
- 各 `.env.example` を基準に不足キーを確認する。**秘密値は画面に表示しない**。新しい環境（サーバ等）では既存 `.env` を上書きせず、バックアップ/差分確認してから配置し `chmod 600`。
