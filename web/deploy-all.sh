#!/usr/bin/env bash
set -e

echo "🚀 LINE家計簿アプリ 全体デプロイを開始します..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# オプション解析
DEPLOY_BOT=true
DEPLOY_WEB=true

while [[ $# -gt 0 ]]; do
  case $1 in
    --bot-only)
      DEPLOY_WEB=false
      shift
      ;;
    --web-only)
      DEPLOY_BOT=false
      shift
      ;;
    --help)
      echo "使用方法: $0 [オプション]"
      echo ""
      echo "オプション:"
      echo "  --bot-only    Botのみデプロイ"
      echo "  --web-only    Webアプリのみデプロイ"
      echo "  --help        このヘルプを表示"
      echo ""
      echo "デフォルト: BotとWebアプリの両方をデプロイ"
      exit 0
      ;;
    *)
      echo "❌ 不明なオプション: $1"
      echo "ヘルプを表示するには --help を使用してください。"
      exit 1
      ;;
  esac
done

# 1. Bot（Cloud Functions）のデプロイ
if [ "$DEPLOY_BOT" = true ]; then
  echo ""
  echo "===================================="
  echo "🤖 Step 1: Bot（Cloud Functions）デプロイ"
  echo "===================================="
  
  if [ -f "$SCRIPT_DIR/deploy-bot.sh" ]; then
    bash "$SCRIPT_DIR/deploy-bot.sh"
  else
    echo "❌ deploy-bot.sh が見つかりません。"
    exit 1
  fi
else
  echo "⏭️  Botデプロイをスキップします。"
fi

# 2. Webアプリ（Vercel）のデプロイ
if [ "$DEPLOY_WEB" = true ]; then
  echo ""
  echo "===================================="
  echo "🌐 Step 2: Webアプリ（Vercel）デプロイ"
  echo "===================================="
  
  if [ -f "$SCRIPT_DIR/deploy.sh" ]; then
    bash "$SCRIPT_DIR/deploy.sh"
  else
    echo "❌ deploy.sh が見つかりません。"
    exit 1
  fi
else
  echo "⏭️  Webアプリデプロイをスキップします。"
fi

echo ""
echo "🎉 全体デプロイが完了しました！"
echo ""
echo "📋 次の手順:"
if [ "$DEPLOY_BOT" = true ]; then
  echo "1. LINEボットのWebhook URLを更新してください"
  echo "   例: https://asia-northeast1-<project-id>.cloudfunctions.net/lineWebhook"
fi
if [ "$DEPLOY_WEB" = true ]; then
  echo "2. Webアプリでアカウント連携をテストしてください"
fi
echo ""