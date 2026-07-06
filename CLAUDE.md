# LINE家計簿（line-kakeibo）- Claude Code アシスタントガイド

## プロジェクト概要

LINE でレシート画像を送ると OCR で自動読み取りして家計簿化する Web アプリ。npm workspaces で **`bot`（LINE Bot / Firebase Functions・TypeScript）** と **`web`（ダッシュボード / Next.js・Vercel）** を管理する。データは Firestore、OCR は Gemini を利用。

## 開発フロー（毎回この手順で進める。ユーザーの再指示は不要）

変更対応は、以下を**自走で最後まで**完結させる。軽微な変更（typo・単純修正）は 1・3 を省略してよい。

1. **設計/UX を変える変更はまずモック**: HTML モック等で方向性の合意を得てから実装に入る（既存の画面/意匠を踏襲）。**サーバー環境で作業していて実機で見せたい場合は、下記「サーバー環境でのプレビュー」の tailnet 配信で URL を渡し、実機（iPhone / Mac など SP・PC 両方）で確認してもらう。**
2. **差分で実装**: 既存パターン（`bot` の Functions 構成・`web` のコンポーネント/ページ構成）に沿って、ゼロから作り直さず改修する。対象ワークスペースを明確にする（bot か web か）。
3. **Fable 5 レビュー**: 非自明な実装は Fable 5 をサブエージェント（Agent ツール `model: fable`）に指名して設計/コードレビュー → 指摘修正 → 再確認のループを回す（専用 `advisor()` が使えない環境のため、Fable サブエージェントで代替）。
4. **自走で PR → マージ**: 完了したらブランチを切って PR を作成（**base は `master`。master への直コミット禁止**）。CI（`PR Checks` = Bot ビルド / Web lint / Web ビルド、`CI/CD`）と PR レビュー（**CodeRabbit**（全リポジトリで有効）に加え、このリポジトリ独自の `gpt-review` / `codex-review` / `code-review` が PR で自動起動）の完了を待ち、**指摘があれば修正して再確認、無ければ `gh pr merge --squash` でマージ**する。
5. **デプロイ**: マージ後のデプロイはパイプライン側に委ねる（`web` → Vercel、`bot` → Firebase Functions）。手動デプロイが要る場合のみ各 `deploy` スクリプトを使う。認証情報が必要な操作はユーザー側で実行してもらう。
6. **検証**: PR 前にローカルで CI と同じチェックを通す。
   ```bash
   npm ci
   npm run build --workspace=bot     # Bot: tsc 型チェック
   npm run lint  --workspace=web     # Web: ESLint
   npm run build --workspace=web     # Web: next build
   ```

## サーバー環境でのプレビュー（tailnet 経由で実機確認）

サーバー（`debian-ai`）で作業していて、モックや変更を **iPhone / Mac などの実機ブラウザ（SP・PC 両方）**で見せたいときの確立済み手順。SP は実機幅での確認、PC はブラウザ幅を変えてブレークポイントを確認、と用途に応じて下記 A / B を使い分ける。共通の前提: tailnet IP のみにバインドして tailnet 内限定で配信する（`0.0.0.0` は不可）。停止は `fuser -k <port>/tcp`（`pkill -f http.server` は**コマンド文字列が自分自身にマッチして落ちる**ため使わない）。URL は `http://<tailscale-ip>:PORT/` か `http://debian-ai.<tailnet>.ts.net:PORT/`（MagicDNS 名・分かりやすい）を渡す。

### A. 静的モック（HTML 単体を素早く見せる。方向性合意フェーズ向き）
1. **secret を含まない配信ディレクトリを用意**: リポジトリ直下は `.env` 等（本番 secret）を含むため**絶対に配信しない**。scratchpad 等へ HTML を `index.html` としてコピーした専用ディレクトリを作る。
2. tailscale IP のみにバインドして配信:
   ```bash
   TS_IP=$(tailscale ip -4)            # 例: 100.126.238.0
   cd <secret無しの配信ディレクトリ>
   python3 -m http.server 8000 --bind "$TS_IP"
   ```
   → `http://<TS_IP>:8000/` を渡す。PC で見る場合はモックの枠を固定幅にせず、実機幅（SP=375px 等）とデスクトップ幅の両方を並べると誤解が少ない。

### B. 実アプリ / レスポンシブ確認（PC でブレークポイントまで見たいとき）
静的モックでなく**実際のページ（web）**を確認したい場合は、Next dev サーバーを tailscale IP にバインドして公開する。Next は任意ファイルを列挙配信しない（`.env` はファイルとして露出しない）ため、この用途では実アプリを直接出してよい。
```bash
TS_IP=$(tailscale ip -4)
npm run dev --workspace=web -- -H "$TS_IP"    # 既定 3000 番
```
→ `http://debian-ai.<tailnet>.ts.net:3000/` を渡す。PC ブラウザで幅を変えればレスポンシブ切替を実データで確認できる。確認後は dev サーバーを停止（`fuser -k 3000/tcp`）。

補足: `tailscale serve`（HTTPS・きれいな URL）は tailnet 側で未有効。使うなら管理コンソールで一度有効化が必要（`tailscale serve` 実行時に案内 URL が出る）。有効化しない限りは上記の tailnet IP 直アクセス方式を使う。

## コード規約（Mac/サーバ含む全環境で遵守）

上記「開発フロー」に加え、環境を問わず守る規約。

- **ライブ配信物に生成ツールの痕跡を残さない**: 公開する画面が配信する HTML/CSS/JS（第三者が DevTools/View Source で見える成果物）に、AI/ツール由来の文字列・メタ・可視コメント・attribution を残さない。本番ビルドは minify でコメント除去されるため通常は自然に満たされる。**GitHub のソース/コミット履歴は対象外**（判断基準は「通常のアプリから見えるか」だけ）。
- **既存パターンに沿う**: bot/web それぞれの既存のディレクトリ構成・命名・エラーハンドリング方針を踏襲し、ゼロから作り直さない。共通ロジックは重複させず既存の場所に寄せる。
- **secret を絶対にコミットしない**: `.env` 系は gitignore 済み。新規の秘匿値もコミット/配信対象に含めない。

## 技術スタック

- **Bot**: TypeScript / Firebase Functions（LINE Messaging API）。ビルドは `tsc`
- **Web**: Next.js / Vercel（家計簿ダッシュボード）
- **データ**: Firestore（`firestore.rules` / `firestore.indexes.json`）、Storage（`storage.rules`）
- **OCR**: Gemini（`GEMINI_SETUP.md` 参照）
- **Node**: 20 系（`engines` / CI）

## 主要コマンド

```bash
# 依存（workspaces 一括）
npm ci

# Bot（Firebase Functions）
npm run build --workspace=bot     # tsc
npm run dev   --workspace=bot     # ts-node-dev

# Web（Next.js）
npm run dev   --workspace=web
npm run build --workspace=web
npm run lint  --workspace=web
```

## 参考ドキュメント

- `ARCHITECTURE.md` / `SPECIFICATION.md` — 設計・仕様
- `SETUP.md` / `DEPLOYMENT_SETUP.md` / `VERCEL_SETUP.md` / `GEMINI_SETUP.md` — 各種セットアップ
- `.github/docs/` — AI レビュー運用・ディレクトリ構成など
