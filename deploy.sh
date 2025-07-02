#!/usr/bin/env bash
set -e

# このスクリプトはプロジェクトルートで実行してください
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Vercel CLI のチェック
if ! command -v vercel >/dev/null 2>&1; then
  echo "Error: vercel CLI が見つかりません。'npm install -g vercel' でインストールしてください。"
  exit 1
fi
if [ ! -d .vercel ] || [ ! -s .vercel/project.json ]; then
  echo "Vercel プロジェクトにリンクされていません。リンクを作成します..."
  vercel link --yes
fi

echo "Vercel CLI およびプロジェクトリンクの確認が完了しました。" "Error: vercel CLI が見つかりません。'npm install -g vercel' でインストールしてください。"
  exit 1
fi

# .env.production の生成
cat > .env.production <<EOF
NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY}
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN}
NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID}
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET}
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=${NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID}
NEXT_PUBLIC_FIREBASE_APP_ID=${NEXT_PUBLIC_FIREBASE_APP_ID}
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=${NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID}
FIREBASE_SA_BASE64=$(cat bot/sa.b64)
EOF

echo ".env.production を作成しました。"

# Vercel に環境変数を追加

echo "Vercel の production 環境に環境変数を追加しています..."
while IFS= read -r line; do
  # 空行またはコメント行はスキップ
  if [[ -z "$line" || "$line" == \#* ]]; then
    continue
  fi
  KEY="${line%%=*}"
  VALUE="${line#*=}"
  echo "Setting $KEY..."
  # パイプで値を渡して対話式プロンプトを回避
  printf "%s" "$VALUE" | vercel env add "$KEY" production
done < .env.production

echo "環境変数の追加が完了しました。"

# Vercel production デプロイ

echo "Vercel に production モードでデプロイを実行します..."
vercel --prod

echo "デプロイが完了しました。"
