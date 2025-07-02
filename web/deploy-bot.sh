#!/usr/bin/env bash
set -e

echo "🤖 Bot（Cloud Functions）のデプロイを開始します..."

# プロジェクトルートに移動
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Firebase CLI のチェック
if ! command -v firebase >/dev/null 2>&1; then
  echo "❌ Error: firebase CLI が見つかりません。"
  echo "   'npm install -g firebase-tools' でインストールしてください。"
  exit 1
fi

# Firebase プロジェクトの確認
if [ ! -f ".firebaserc" ]; then
  echo "❌ Error: .firebaserc が見つかりません。"
  echo "   'firebase use --add' でFirebaseプロジェクトを設定してください。"
  exit 1
fi

# Bot依存関係のインストール
echo "📦 Bot依存関係をインストール中..."
cd bot
npm install

# TypeScript コンパイル
echo "🔨 TypeScriptをコンパイル中..."
npm run build

# プロジェクトルートに戻る
cd ..

# Firebase ログイン確認
echo "🔑 Firebase認証を確認中..."
if ! firebase projects:list >/dev/null 2>&1; then
  echo "❌ Firebase にログインしていません。"
  echo "   'firebase login' でログインしてください。"
  exit 1
fi

# 現在のプロジェクト表示
current_project=$(firebase use)
echo "📋 使用中のFirebaseプロジェクト: $current_project"

# Firestore セキュリティルールのデプロイ
echo "🔒 Firestoreセキュリティルールをデプロイ中..."
firebase deploy --only firestore:rules

# Firestore インデックスのデプロイ
echo "📊 Firestoreインデックスをデプロイ中..."
firebase deploy --only firestore:indexes

# Cloud Functions のデプロイ
echo "☁️  Cloud Functionsをデプロイ中..."
firebase deploy --only functions

echo "✅ Bot（Cloud Functions）のデプロイが完了しました！"