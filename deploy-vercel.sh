#!/usr/bin/env bash
set -e

echo "🚀 Vercelへのデプロイを開始します..."

# プロジェクトルートに移動
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Vercel CLI のチェック
if ! command -v vercel >/dev/null 2>&1; then
  echo "❌ Error: vercel CLI が見つかりません。"
  echo "   'npm install -g vercel' でインストールしてください。"
  exit 1
fi

# Vercel プロジェクトリンクの確認（リポジトリルートで実施）
# 本番 https://line-kakeibo.vercel.app を配信しているのはルートにリンクした
# `line-kakeibo` プロジェクト。ルートの vercel.json が
# buildCommand='cd web && npm run build' / outputDirectory='web/.next' を
# 定義しているため、デプロイもルートから実行する必要がある。
if [ ! -d .vercel ] || [ ! -s .vercel/project.json ]; then
  echo "⚠️ Vercel プロジェクトにリンクされていません。リンクを作成します..."
  vercel link --yes --project line-kakeibo --scope makoto041s-projects
fi

echo "✅ Vercel CLI およびプロジェクトリンクの確認が完了しました。"

# 環境変数ファイルの確認
if [ ! -f web/.env.local ]; then
  echo "❌ Error: web/.env.local が見つかりません。"
  echo "   web/.env.example を参照して作成してください。"
  exit 1
fi

# webディレクトリに移動
cd web

# Node.js バージョンチェック
NODE_VERSION=$(node --version)
echo "📋 Node.js バージョン: $NODE_VERSION"

# 依存関係のインストール
echo "📦 依存関係をインストール中..."
npm install

# ビルド前のlintチェック
echo "🔍 Lintチェックを実行中..."
npm run lint || true # lintエラーがあっても続行

# ビルド実行（ローカル）
echo "🔨 アプリケーションをビルド中..."
npm run build

# プロジェクトルートに戻る
cd ..

# 環境変数は Vercel ダッシュボード（Project Settings > Environment Variables）で
# 管理する。以前はここで web/.env.local の全キーを `vercel env add` に流していたが、
# ローカルの秘密値を機械的に本番へ push してしまううえ、リンク先プロジェクトが
# ずれていると誤ったプロジェクトへ書き込む事故になるため廃止した。

# Vercel production デプロイ（リポジトリルートから実行）
echo "🚀 Vercel に production モードでデプロイを実行中... (tgz アーカイブ)"
vercel --prod --archive=tgz --yes

echo "✅ デプロイが完了しました！"
echo "📖 デプロイされたURLを確認してください。"
echo ""
echo "📝 確認事項:"
echo "  1. https://line-kakeibo.vercel.app にアクセスできるか確認"
echo "  2. https://line-kakeibo.vercel.app/api/health でヘルスチェック"
echo "  3. LINEボットからの連携が正常に動作するか確認"
