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

# Firebase CLI のチェック
if ! command -v firebase >/dev/null 2>&1; then
  echo "❌ Error: firebase CLI が見つかりません。"
  echo "   'npm install -g firebase-tools' でインストールしてください。"
  exit 1
fi

# Firebase プロジェクトの確認
if [ ! -f ../.firebaserc ]; then
  echo "❌ Error: ../.firebaserc が見つかりません。"
  echo "   'firebase init' でプロジェクトを初期化してください。"
  exit 1
fi

# Firebase プロジェクト設定の確認
if [ ! -f ../firebase.json ]; then
  echo "❌ Error: ../firebase.json が見つかりません。"
  echo "   'firebase init' でプロジェクトを初期化してください。"
  exit 1
fi

# Firebase Hosting にデプロイ
echo "🚀 Firebase Hosting にデプロイを実行中..."
cd .. && firebase deploy --only hosting

echo "✅ デプロイが完了しました！"
echo "📖 デプロイされたURLは上記に表示されています。"