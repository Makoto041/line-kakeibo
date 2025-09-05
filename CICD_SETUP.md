#!/bin/bash

# CI/CDセットアップガイド
echo "🚀 Line-Kakeibo CI/CD Setup Guide"
echo "================================="
echo ""

# カラー設定
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 必要なシークレットのリスト
REQUIRED_SECRETS=(
  "VERCEL_TOKEN"
  "VERCEL_ORG_ID"
  "VERCEL_PROJECT_ID"
  "FIREBASE_TOKEN"
  "FIREBASE_PROJECT_ID"
  "GCP_SA_KEY"
  "NEXT_PUBLIC_FIREBASE_API_KEY"
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID"
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"
  "NEXT_PUBLIC_FIREBASE_APP_ID"
  "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID"
)

OPTIONAL_SECRETS=(
  "SLACK_WEBHOOK_URL"
)

echo -e "${YELLOW}📋 Required GitHub Secrets:${NC}"
echo ""
for secret in "${REQUIRED_SECRETS[@]}"; do
  echo "  ✓ $secret"
done

echo ""
echo -e "${YELLOW}📋 Optional GitHub Secrets:${NC}"
echo ""
for secret in "${OPTIONAL_SECRETS[@]}"; do
  echo "  ○ $secret"
done

echo ""
echo "================================="
echo ""
echo -e "${GREEN}🔧 Setup Instructions:${NC}"
echo ""

echo "1. Vercel Setup:"
echo "   - Install Vercel CLI: npm i -g vercel"
echo "   - Link project: vercel link"
echo "   - Get tokens from: https://vercel.com/account/tokens"
echo ""

echo "2. Firebase Setup:"
echo "   - Install Firebase CLI: npm i -g firebase-tools"
echo "   - Login: firebase login:ci"
echo "   - This will provide FIREBASE_TOKEN"
echo ""

echo "3. Google Cloud Service Account:"
echo "   - Go to: https://console.cloud.google.com/iam-admin/serviceaccounts"
echo "   - Create service account with necessary permissions"
echo "   - Download JSON key and encode: base64 < service-account.json"
echo "   - Set as GCP_SA_KEY secret"
echo ""

echo "4. Add Secrets to GitHub:"
echo "   - Go to: Settings > Secrets and variables > Actions"
echo "   - Add each secret from the list above"
echo ""

echo "================================="
echo ""
echo -e "${GREEN}🎯 Workflow Features:${NC}"
echo ""
echo "✅ Monorepo support with workspaces"
echo "✅ Intelligent change detection"
echo "✅ Dependency caching with pnpm"
echo "✅ Parallel builds and tests"
echo "✅ Preview deployments for PRs"
echo "✅ Security scanning (SAST, secrets, dependencies)"
echo "✅ Code quality checks (ESLint, TypeScript)"
echo "✅ Automated dependency updates (Dependabot)"
echo "✅ Bundle size analysis"
echo "✅ Performance monitoring (Lighthouse)"
echo "✅ Health checks after deployment"
echo "✅ Slack notifications (optional)"
echo ""

echo "================================="
echo ""
echo -e "${YELLOW}📚 Available Workflows:${NC}"
echo ""
echo "1. ci-cd-improved.yml - Main CI/CD pipeline"
echo "2. preview.yml - Preview deployments for PRs"
echo "3. code-review.yml - Automated code review"
echo "4. dependabot.yml - Dependency updates"
echo ""

echo "================================="
echo ""
echo -e "${GREEN}🚀 Quick Start:${NC}"
echo ""
echo "# Install pnpm (recommended)"
echo "npm install -g pnpm"
echo ""
echo "# Install all dependencies"
echo "pnpm install"
echo ""
echo "# Run local development"
echo "pnpm run dev:web  # Web app"
echo "pnpm run dev:bot  # Bot server"
echo ""
echo "# Run tests"
echo "pnpm test"
echo ""
echo "# Build projects"
echo "pnpm run build"
echo ""

echo "================================="
echo ""
echo -e "${YELLOW}⚙️ Configuration Files:${NC}"
echo ""
echo "- .github/workflows/ci-cd-improved.yml - Improved CI/CD pipeline"
echo "- .github/workflows/preview.yml - PR preview deployments"
echo "- .github/workflows/code-review.yml - Automated code review"
echo "- .github/dependabot.yml - Dependency update configuration"
echo ""

echo "================================="
echo ""
echo -e "${GREEN}✨ Migration Guide:${NC}"
echo ""
echo "To migrate from the current CI/CD to the improved version:"
echo ""
echo "1. Review and update secrets in GitHub"
echo "2. Install pnpm: npm install -g pnpm"
echo "3. Generate pnpm-lock.yaml: pnpm import"
echo "4. Test locally: pnpm install && pnpm run build"
echo "5. Rename old workflow: mv ci-cd.yml ci-cd-old.yml"
echo "6. Activate new workflow: mv ci-cd-improved.yml ci-cd.yml"
echo "7. Commit and push changes"
echo ""

echo "================================="
echo ""
echo -e "${RED}⚠️ Important Notes:${NC}"
echo ""
echo "- Ensure all secrets are properly configured before deploying"
echo "- The improved pipeline uses pnpm instead of npm for better performance"
echo "- Preview deployments require Vercel Pro plan or trial"
echo "- Health checks need /api/health endpoints to be implemented"
echo ""

echo "================================="
echo "Setup guide complete! 🎉"
