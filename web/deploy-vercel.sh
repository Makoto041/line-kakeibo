#!/usr/bin/env bash
set -e

echo "🚀 Vercelへのデプロイを開始します..."

# webディレクトリに移動
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Node.js バージョンチェック
NODE_VERSION=$(node --version)
echo "📋 Node.js バージョン: $NODE_VERSION"

# Vercel CLI のチェック
if ! command -v vercel >/dev/null 2>&1; then
  echo "❌ Error: Vercel CLI が見つかりません。"
  echo "   'npm install -g vercel' でインストールしてください。"
  exit 1
fi

# 依存関係のインストール
echo "📦 依存関係をインストール中..."
npm install

# ビルド前のlintチェック
echo "🔍 Lintチェックを実行中..."
if npm run | grep -q "lint"; then
  npm run lint
else
  echo "⏭️ lint scriptが見つからないため、スキップします。"
fi

# TypeScriptの型チェック（package.jsonにscriptがあれば）
if npm run | grep -q "typecheck"; then
  echo "🔍 TypeScriptの型チェックを実行中..."
  npm run typecheck
else
  echo "⏭️ typecheck scriptが見つからないため、スキップします。"
fi

# ビルド実行（Vercelが自動でビルドするため、ローカルビルドはオプション）
echo "🔨 ローカルでビルドテストを実行中..."
npm run build

# 環境変数の確認
echo "🔍 重要な環境変数の確認..."
if [ -f ".env.local" ]; then
  echo "✅ .env.local ファイルが見つかりました"
  
  # Firebase設定の存在確認（秘密情報は表示しない）
  if grep -q "NEXT_PUBLIC_FIREBASE_API_KEY" .env.local; then
    echo "✅ Firebase API Key が設定されています"
  else
    echo "⚠️ Firebase API Key が設定されていません"
  fi
  
  if grep -q "NEXT_PUBLIC_FIREBASE_PROJECT_ID" .env.local; then
    echo "✅ Firebase Project ID が設定されています"
  else
    echo "⚠️ Firebase Project ID が設定されていません"
  fi
else
  echo "⚠️ .env.local ファイルが見つかりません"
  echo "   Vercelダッシュボードで環境変数が設定されていることを確認してください"
fi

# Vercelプロジェクトの確認
if [ -f ".vercel/project.json" ]; then
  echo "✅ Vercelプロジェクト設定が見つかりました"
else
  echo "⚠️ Vercelプロジェクト設定が見つかりません"
  echo "   初回デプロイの場合は 'vercel link' を実行してください"
fi

# Vercelにデプロイ
echo "🚀 Vercelにデプロイを実行中..."
echo "   プロダクション環境にデプロイします..."

# プロダクション環境にデプロイ（--prodフラグ）
vercel --prod

echo ""
echo "✅ Vercelデプロイが完了しました！"
echo ""
echo "📋 次の手順:"
echo "1. デプロイされたURLでアプリケーションが正常に動作するか確認"
echo "2. Firebase設定が正しく読み込まれているか確認"
echo "3. データベース接続が正常に動作するか確認"
echo ""
echo "🔗 Vercelダッシュボード: https://vercel.com/dashboard"
echo ""