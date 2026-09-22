# CLAUDE.md — line-kakeibo（Claude Code 向け）

LINE 連携の家計簿アプリ。既存の CI を尊重しつつ、環境（Mac/サーバ）を問わず同じ「しきたり」で作業するための共通ルールを定義する。

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
2. **自走 PR → マージ**: **master への直コミット禁止**。ブランチを切って PR を作成し、既存の CI（`.github/workflows/` の `ci-cd` / `pr-checks` / `code-review` / `vercel-deploy` など）の完了を待ち、指摘があれば修正・無ければ squash マージまで自走する。
3. **検証**: build / type-check / lint をローカルで通してから PR にする。
4. ロードマップ・実装方針の詳細は `.github/docs/`（`IMPLEMENTATION_ROADMAP` / `IMPLEMENTATION_DECISION` 等）を参照。
5. **設計/UX を変える変更はまずモック**: 方向性の合意を得てから実装に入る。サーバー環境で作業していて実機で見せたい場合は、下記「サーバー環境でのプレビュー」で URL を渡し、実機（iPhone / Mac など SP・PC 両方）で確認してもらう。

## サーバー環境でのプレビュー（tailnet 経由で実機確認）

サーバー（`debian-ai`）で作業中に、モックや変更を **iPhone / Mac の実機ブラウザ（SP・PC 両方）**で見せたいときの手順。共通の前提: tailnet IP のみにバインドして tailnet 内限定で配信（`0.0.0.0` は不可）。URL は `http://<tailscale-ip>:PORT/` か `http://debian-ai.<tailnet>.ts.net:PORT/`（MagicDNS 名）を渡す。停止は `fuser -k <port>/tcp`（`pkill -f http.server` は自分自身のコマンド文字列にマッチして落ちるため使わない）。

- **A. 静的モック（HTML 単体）**: リポジトリ直下は `.env` 等の secret を含むため配信禁止。secret を含まない専用ディレクトリへ HTML を `index.html` としてコピーし、`python3 -m http.server 8000 --bind "$(tailscale ip -4)"` で配信。
- **B. 実アプリ / レスポンシブ確認（web）**: Next dev を tailscale IP にバインド。`npm -w web run dev -- -H "$(tailscale ip -4)"`（既定 3000）。Next は任意ファイルを列挙配信しない（`.env` 非露出）ため実アプリ直出しでよい。PC ブラウザで幅を変えればレスポンシブ切替を実データで確認できる。

補足: `tailscale serve`（HTTPS）は tailnet 側で要有効化（管理コンソール）。未有効なら上記の tailnet IP 直アクセス方式を使う。

## 全環境共通の規約

- **ライブ配信物に生成ツールの痕跡を残さない**: 公開される web の HTML/CSS/JS（第三者が DevTools/View Source で見える成果物）に、AI/ツール由来の文字列・メタ・可視コメント・attribution を残さない。本番ビルドは minify でコメント除去されるため通常は自然に満たされる。**GitHub のソース/コミット履歴・`.github/` は対象外**（判断基準は「通常のサイトから見えるか」だけ）。

## 環境変数（値は秘匿。`.env*` は gitignore 済み・手動配置）

- **web**（`web/.env.local`）: `NEXT_PUBLIC_FIREBASE_*`, `MFKAKEIBO_TOKEN`, `NEXT_PUBLIC_DISABLE_REALTIME`
- **bot**（`bot/.env` / `bot/.env.local`, ルート `.env`）: `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_TOKEN` / `LINE_GROUP_ID` / `DEFAULT_GROUP_ID`, `GMAIL_REDIRECT_URI`, `ADMIN_SECRET`, `GEMINI_API_KEY`, `FIREBASE_PROJECT_ID`, Firebase Admin 認証（`GOOGLE_APPLICATION_CREDENTIALS` の JSON **または** 本番は `FIREBASE_SA_BASE64`）
- 各 `.env.example` を基準に不足キーを確認する。**秘密値は画面に表示しない**。新しい環境（サーバ等）では既存 `.env` を上書きせず、バックアップ/差分確認してから配置し `chmod 600`。
