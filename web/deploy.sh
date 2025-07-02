#!/usr/bin/env bash
set -e

echo "🚀 Webアプリケーションのデプロイを開始します..."

# webディレクトリに移動
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Node.js バージョンチェック
NODE_VERSION=$(node --version)
echo "📋 Node.js バージョン: $NODE_VERSION"

# 依存関係のインストール
echo "📦 依存関係をインストール中..."
npm install

# ビルド前のlintチェック
echo "🔍 Lintチェックを実行中..."
npm run lint

# TypeScriptの型チェック（package.jsonにscriptがあれば）
if npm run | grep -q "typecheck"; then
  echo "🔍 TypeScriptの型チェックを実行中..."
  npm run typecheck
fi

# ビルド実行
echo "🔨 アプリケーションをビルド中..."
npm run build

# Vercel CLI のチェック
if ! command -v vercel >/dev/null 2>&1; then
  echo "❌ Error: vercel CLI が見つかりません。"
  echo "   'npm install -g vercel' でインストールしてください。"
  exit 1
fi

# Vercelプロジェクトリンクの確認
if [ ! -d .vercel ] || [ ! -s .vercel/project.json ]; then
  echo "🔗 Vercelプロジェクトにリンクされていません。リンクを作成します..."
  vercel link --yes
fi

# 環境変数の確認と読み込み
echo "🔧 環境変数を確認中..."

# .env.localから環境変数を読み込み
if [ -f .env.local ]; then
  echo "📁 .env.localから環境変数を読み込んでいます..."
  export $(grep -v '^#' .env.local | xargs)
else
  echo "⚠️  .env.localが見つかりません。"
fi

required_vars=(
  "NEXT_PUBLIC_FIREBASE_API_KEY"
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID"
)

missing_vars=()
for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    missing_vars+=("$var")
  fi
done

if [ ${#missing_vars[@]} -gt 0 ]; then
  echo "❌ 以下の環境変数が設定されていません:"
  for var in "${missing_vars[@]}"; do
    echo "   - $var"
  done
  echo "   .env.local または環境変数を設定してください。"
  exit 1
fi

# Base64エンコードされたサービスアカウントキーの確認
if [ ! -f "../bot/sa.b64" ]; then
  echo "❌ Error: ../bot/sa.b64 が見つかりません。"
  echo "   Firebase Admin SDKサービスアカウントキーをBase64エンコードして配置してください。"
  exit 1
fi

# Vercelの環境変数設定
echo "⚙️  Vercel環境変数を設定中..."

# 環境変数をVercelに設定
for var in "${required_vars[@]}"; do
  echo "Setting $var..."
  printf "%s" "${!var}" | vercel env add "$var" production --force 2>/dev/null || true
done

# Firebase Admin SDK key
echo "Setting FIREBASE_SA_BASE64..."
printf "%s" "$(cat ../bot/sa.b64)" | vercel env add "FIREBASE_SA_BASE64" production --force 2>/dev/null || true

# プロダクションデプロイ実行
echo "🚀 Vercelにプロダクションデプロイを実行中..."
vercel --prod

echo "✅ デプロイが完了しました！"
echo "📖 デプロイされたURLは上記に表示されています。"