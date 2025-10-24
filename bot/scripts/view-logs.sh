#!/bin/bash

# Firebase Functions ログ表示スクリプト
# 使い方: ./scripts/view-logs.sh [オプション]

PROJECT_ID="line-kakeibo-0410"
FUNCTION_NAME="webhook"

# 色付け
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ヘルプ表示
show_help() {
    echo "Firebase Functions ログビューアー"
    echo ""
    echo "使い方:"
    echo "  ./scripts/view-logs.sh [オプション]"
    echo ""
    echo "オプション:"
    echo "  -h, --help              このヘルプを表示"
    echo "  -n, --limit NUM         表示する行数（デフォルト: 50）"
    echo "  -e, --error             エラーログのみ表示"
    echo "  -p, --profile           プロフィール関連ログ"
    echo "  -m, --member            メンバー表示問題関連"
    echo "  -g, --gemini            Gemini分類関連"
    echo "  -f, --follow            リアルタイム監視（Ctrl+Cで終了）"
    echo "  -t, --timeout           タイムアウトエラーのみ"
    echo ""
    echo "例:"
    echo "  ./scripts/view-logs.sh                 # 最新50件"
    echo "  ./scripts/view-logs.sh -n 100          # 最新100件"
    echo "  ./scripts/view-logs.sh -e              # エラーのみ"
    echo "  ./scripts/view-logs.sh -p              # プロフィール関連"
    echo "  ./scripts/view-logs.sh -f              # リアルタイム監視"
}

# デフォルト値
LIMIT=50
FILTER=""

# 引数解析
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -n|--limit)
            LIMIT="$2"
            shift 2
            ;;
        -e|--error)
            FILTER="AND severity>=ERROR"
            shift
            ;;
        -p|--profile)
            FILTER="AND textPayload=~\"(PROFILE|displayName|getProfile|getGroupMemberProfile)\""
            shift
            ;;
        -m|--member)
            FILTER="AND textPayload=~\"(FINAL USER DEBUG|メンバー|displayName)\""
            shift
            ;;
        -g|--gemini)
            FILTER="AND textPayload=~\"(Gemini|CATEGORY|classification)\""
            shift
            ;;
        -t|--timeout)
            FILTER="AND textPayload=~\"timeout\""
            shift
            ;;
        -f|--follow)
            echo -e "${BLUE}リアルタイムログ監視中... (Ctrl+Cで終了)${NC}"
            echo ""
            gcloud logging tail "resource.type=cloud_run_revision AND resource.labels.service_name=$FUNCTION_NAME" --project=$PROJECT_ID --format="value(timestamp,severity,textPayload)" | while IFS=$'\t' read -r timestamp severity payload; do
                if [[ $severity == "ERROR" ]]; then
                    echo -e "${RED}[ERROR]${NC} $timestamp"
                    echo "$payload" | head -c 500
                    echo ""
                elif [[ $severity == "WARNING" ]]; then
                    echo -e "${YELLOW}[WARN]${NC} $timestamp"
                    echo "$payload" | head -c 500
                    echo ""
                else
                    echo -e "${GREEN}[INFO]${NC} $timestamp"
                    echo "$payload" | head -c 200
                    echo ""
                fi
            done
            exit 0
            ;;
        *)
            echo "不明なオプション: $1"
            show_help
            exit 1
            ;;
    esac
done

# ログ取得
echo -e "${BLUE}最新 ${LIMIT} 件のログを取得中...${NC}"
echo ""

gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$FUNCTION_NAME $FILTER" \
    --limit=$LIMIT \
    --format="value(timestamp,severity,textPayload)" \
    --project=$PROJECT_ID | while IFS=$'\t' read -r timestamp severity payload; do

    # タイムスタンプをフォーマット
    formatted_time=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${timestamp:0:19}" "+%m/%d %H:%M:%S" 2>/dev/null || echo "${timestamp:0:19}")

    # 重要度に応じて色付け
    if [[ $severity == "ERROR" ]]; then
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${RED}[ERROR]${NC} $formatted_time"
        echo "$payload"
        echo ""
    elif [[ $severity == "WARNING" ]]; then
        echo -e "${YELLOW}[WARN]${NC} $formatted_time"
        echo "$payload"
        echo ""
    else
        # 重要なキーワードをハイライト
        if echo "$payload" | grep -qi "FINAL USER DEBUG\|SUCCESS\|completed successfully"; then
            echo -e "${GREEN}[INFO]${NC} $formatted_time"
            echo "$payload" | grep --color=always -E "FINAL USER DEBUG|SUCCESS|completed successfully|displayName:|岩渕 誠|$"
        elif echo "$payload" | grep -qi "FAILED\|timeout\|error"; then
            echo -e "${YELLOW}[INFO]${NC} $formatted_time"
            echo "$payload" | grep --color=always -E "FAILED|timeout|error|$"
        else
            echo "[INFO] $formatted_time"
            echo "$payload" | head -c 300
        fi
        echo ""
    fi
done

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ ログ取得完了${NC}"
