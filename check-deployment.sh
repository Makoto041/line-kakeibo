#!/usr/bin/env bash
set -e

echo "================================================"
echo "Vercel Deployment Status Check"
echo "================================================"
echo ""

# Check deployment status
echo "🔍 Checking deployment status..."
echo ""

# Test main URL
echo "1. Testing main URL: https://line-kakeibo.vercel.app"
response=$(curl -s -o /dev/null -w "%{http_code}" https://line-kakeibo.vercel.app)
echo "   HTTP Status: $response"

if [ "$response" == "200" ]; then
    echo "   ✅ Server is responding"
else
    echo "   ❌ Server error"
fi

echo ""
echo "2. Testing API health endpoint"
api_response=$(curl -s -o /dev/null -w "%{http_code}" https://line-kakeibo.vercel.app/api/health)
echo "   HTTP Status: $api_response"

if [ "$api_response" == "200" ]; then
    echo "   ✅ API is working"
else
    echo "   ❌ API error"
fi

echo ""
echo "================================================"
echo "Next Steps:"
echo "================================================"
echo ""
echo "Environment variables are already set ✅"
echo ""
echo "If you still see 404, please try:"
echo "1. Go to Vercel Dashboard"
echo "2. Check Deployments tab for build logs"
echo "3. Click on latest deployment"
echo "4. Check 'Functions' tab to see if API routes are detected"
echo ""
echo "Or try direct manual redeploy:"
echo "1. In Vercel Dashboard -> Deployments"
echo "2. Click '...' on latest deployment"
echo "3. Select 'Redeploy'"
echo "4. Uncheck 'Use existing Build Cache'"
echo "5. Click 'Redeploy'"
echo ""
echo "================================================"
