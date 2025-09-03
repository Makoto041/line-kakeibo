# Gemini分類機能 セットアップと使用方法

## 🚀 概要

line-kakeiboプロジェクトでは、Gemini AIを使用した高度な支出カテゴリ自動分類機能が実装されています。

## 🔧 セットアップ

### 1. Gemini API Keyの取得

1. [Google AI Studio](https://aistudio.google.com/app/apikey) にアクセス
2. "Create API Key" をクリック
3. 生成されたAPIキーをコピー

### 2. 環境変数の設定

`.env` ファイルの `GEMINI_API_KEY` を実際のキーに置き換えてください：

```bash
# .env ファイル
GEMINI_API_KEY=AIzaSyC1234567890abcdefghijklmnopqrstuvwxyz
```

## 🧪 テスト方法

### Gemini分類機能のテスト

```bash
cd bot
npx ts-node test-gemini.ts
```

### APIエンドポイントのテスト

開発サーバーを起動：
```bash
npm run dev
```

#### 分類統計の確認
```bash
curl http://localhost:8080/classification-stats
```

#### テスト分類の実行
```bash
curl -X POST http://localhost:8080/test-classification \\
  -H "Content-Type: application/json" \\
  -d '{"description": "スーパーで食材購入"}'
```

## 📊 機能説明

### 主な機能

1. **AI自動分類**: Gemini 1.5 Flash を使用した高精度なカテゴリ分類
2. **フォールバック機能**: Gemini分類が失敗した場合のキーワードベース分類
3. **統計トラッキング**: 分類成功率と信頼度の追跡
4. **テストエンドポイント**: 分類機能の動作確認用API

### 分類プロセス

1. **優先**: Gemini AIによる高度な分類（信頼度 >= 0.6）
2. **フォールバック**: キーワードベース分類
3. **統計更新**: 分類結果の統計情報を更新

## 🔍 トラブルシューティング

### よくある問題

1. **GEMINI_API_KEY not found エラー**
   - `.env` ファイルでAPIキーが正しく設定されているか確認

2. **分類結果が null**
   - ユーザーのカテゴリが正しく設定されているか確認
   - Gemini APIの応答が正しい形式かログで確認

3. **Node.js バージョン警告**
   - Node.js 20推奨ですが、18.x でも動作します

## 📁 関連ファイル

- `src/geminiCategoryClassifier.ts` - Gemini分類ロジック
- `src/textParser.ts` - テキスト解析とカテゴリ統合
- `src/index.ts` - APIエンドポイント（統計・テスト）
- `test-gemini.ts` - テストスクリプト
