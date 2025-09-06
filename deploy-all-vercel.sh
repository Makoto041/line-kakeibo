#!/usr/bin/env bash
set -e

echo "🚀 LINE家計簿アプリ 全体デプロイを開始します（Vercel + Bot）..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# オプション解析
DEPLOY_BOT=true
DEPLOY_WEB=true
SKIP_CONFIRMATIONS=false

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
    --skip-confirm)
      SKIP_CONFIRMATIONS=true
      shift
      ;;
    --help)
      echo "使用方法: $0 [オプション]"
      echo ""
      echo "オプション:"
      echo "  --bot-only      Botのみデプロイ"
      echo "  --web-only      Webアプリのみデプロイ"
      echo "  --skip-confirm  確認をスキップして自動実行"
      echo "  --help          このヘルプを表示"
      echo ""
      echo "デフォルト: BotとWebアプリの両方をデプロイ"
      echo ""
      echo "例:"
      echo "  $0                    # 両方デプロイ（確認あり）"
      echo "  $0 --web-only         # Webアプリのみ"
      echo "  $0 --skip-confirm     # 確認なしで両方デプロイ"
      exit 0
      ;;
    *)
      echo "❌ 不明なオプション: $1"
      echo "ヘルプを表示するには --help を使用してください。"
      exit 1
      ;;
  esac
done

# デプロイ予定の確認
echo ""
echo "📋 デプロイ予定:"
if [ "$DEPLOY_BOT" = true ]; then
  echo "  ✅ Bot (Cloud Functions)"
fi
if [ "$DEPLOY_WEB" = true ]; then
  echo "  ✅ Webアプリ (Vercel)"
fi
echo ""

# 確認プロンプト（スキップオプションがない場合）
if [ "$SKIP_CONFIRMATIONS" = false ]; then
  echo "⚠️  本番環境にデプロイします。続行しますか？"
  echo "   このプロセスには数分かかる場合があります。"
  echo ""
  read -p "続行する場合は 'y' または 'yes' を入力してください: " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ デプロイをキャンセルしました。"
    exit 0
  fi
fi

echo ""
echo "🚀 デプロイを開始します..."

# タイムスタンプの記録
START_TIME=$(date +%s)

# 1. Bot（Cloud Functions）のデプロイ
if [ "$DEPLOY_BOT" = true ]; then
  echo ""
  echo "===================================="
  echo "🤖 Step 1: Bot（Cloud Functions）デプロイ"
  echo "===================================="
  
  if [ -f "$SCRIPT_DIR/web/deploy-bot.sh" ]; then
    bash "$SCRIPT_DIR/web/deploy-bot.sh"
  else
    echo "❌ web/deploy-bot.sh が見つかりません。"
    exit 1
  fi
  
  BOT_DEPLOY_TIME=$(date +%s)
  BOT_DURATION=$((BOT_DEPLOY_TIME - START_TIME))
  echo "⏱️  Bot デプロイ完了時間: ${BOT_DURATION}秒"
else
  echo "⏭️  Botデプロイをスキップします。"
fi

# 2. Webアプリ（Vercel）のデプロイ
if [ "$DEPLOY_WEB" = true ]; then
  echo ""
  echo "===================================="
  echo "🌐 Step 2: Webアプリ（Vercel）デプロイ"
  echo "===================================="
  
  if [ -f "$SCRIPT_DIR/web/deploy-vercel.sh" ]; then
    bash "$SCRIPT_DIR/web/deploy-vercel.sh"
  else
    echo "❌ web/deploy-vercel.sh が見つかりません。"
    exit 1
  fi
  
  WEB_DEPLOY_TIME=$(date +%s)
  if [ "$DEPLOY_BOT" = true ]; then
    WEB_DURATION=$((WEB_DEPLOY_TIME - BOT_DEPLOY_TIME))
  else
    WEB_DURATION=$((WEB_DEPLOY_TIME - START_TIME))
  fi
  echo "⏱️  Web デプロイ完了時間: ${WEB_DURATION}秒"
else
  echo "⏭️  Webアプリデプロイをスキップします。"
fi

# 完了時間の計算
END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

echo ""
echo "🎉 全体デプロイが完了しました！"
echo "⏱️  総実行時間: ${TOTAL_DURATION}秒"
echo ""

echo "📋 次の手順:"
if [ "$DEPLOY_BOT" = true ]; then
  echo "1. 🤖 LINEボットのWebhook URLを更新してください"
  echo "   - LINE Developers Console: https://developers.line.biz/"
  echo "   - Webhook URL例: https://asia-northeast1-line-kakeibo-0410.cloudfunctions.net/lineWebhook"
  echo ""
fi

if [ "$DEPLOY_WEB" = true ]; then
  echo "2. 🌐 Webアプリでアカウント連携をテストしてください"
  echo "   - Vercel URL でアプリケーションが正常に起動するか確認"
  echo "   - Firebase接続が正常に動作するか確認"
  echo "   - LINEアカウント連携が動作するか確認"
  echo ""
fi

echo "🔗 参考リンク:"
echo "   • Vercelダッシュボード: https://vercel.com/dashboard"
echo "   • Firebase Console: https://console.firebase.google.com/"
echo "   • LINE Developers: https://developers.line.biz/"
echo ""

echo "✨ デプロイ完了！お疲れ様でした！"