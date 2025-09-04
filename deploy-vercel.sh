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

# .vercelディレクトリの存在確認（web 配下で実施）
if [ ! -d web/.vercel ] || [ ! -s web/.vercel/project.json ]; then
  echo "⚠️ Vercel プロジェクトにリンクされていません（web）。リンクを作成します..."
  vercel link --yes --cwd web
fi

echo "✅ Vercel CLI および（web ディレクトリの）プロジェクトリンクの確認が完了しました。"

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

# Vercel に環境変数を設定（必要に応じて）
echo "🔐 Vercel環境変数を設定中..."

# web/.env.localから環境変数を読み込んで設定
while IFS='=' read -r key value; do
  # 空行やコメント行はスキップ
  if [[ -z "$key" || "$key" == \#* ]]; then
    continue
  fi

  # Vercelに環境変数を追加（エラーを無視）
  echo "Setting $key..."
  echo "$value" | vercel env add "$key" production --cwd web 2>/dev/null || true
done <web/.env.local

# Vercel production デプロイ
echo "🚀 Vercel に production モードでデプロイを実行中... (tgz アーカイブ + web ディレクトリ)"
vercel --prod --archive=tgz --cwd web --yes

echo "✅ デプロイが完了しました！"
echo "📖 デプロイされたURLを確認してください。"
echo ""
echo "📝 確認事項:"
echo "  1. https://line-kakeibo.vercel.app にアクセスできるか確認"
echo "  2. https://line-kakeibo.vercel.app/api/health でヘルスチェック"
echo "  3. LINEボットからの連携が正常に動作するか確認"
