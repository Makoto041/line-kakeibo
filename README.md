# 📱 LINE家計簿 - レシート自動読み取りアプリ

LINEでレシート画像を送信するだけで自動的にOCR処理・家計簿管理できるWebアプリケーションです。

[![CI/CD](https://github.com/makoto041s/line-kakeibo/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/makoto041s/line-kakeibo/actions)

## ✨ 特徴

- 📸 **レシート画像自動読み取り**: Google Cloud Vision APIでOCR処理
- 💬 **LINE Bot統合**: 日常のLINE使用で自然に家計簿記録
- 📊 **リアルタイム分析**: 月次統計・カテゴリ別グラフ・日別推移
- 🔐 **セキュア**: Firebase認証・Firestoreルールで個人データ保護
- 📱 **レスポンシブ**: モバイルファーストなUI/UX
- ⚡ **高速**: Next.js 15 + App Router でサーバーサイドレンダリング

## 🏗️ 技術スタック（理想設計準拠）

### アーキテクチャ
```
┌───────────────┐   HTTPS/WebSocket   ┌───────────────┐
│ Next.js Web   │  ── Firestore SDK ─▶│   Firestore   │
│ (Vercel)      │ ◀─ Cloud Functions ──│   (GCP)       │
└───────────────┘                     └───────────────┘
        ▲│                                       ▲
        ││ REST API                   Pub/Sub    │
        │▼                                       │
┌───────────────┐  webhook  ┌───────────────┐    │
│  LINE Bot     │──────────▶│ Cloud Func.   │────┘
│ (Functions)   │           └───────────────┘
└───────────────┘
```

### Tech Stack
- **Frontend**: Next.js 15 + React 19 + TypeScript + Tailwind CSS
- **Backend**: Node.js 20 + Express + Firebase Functions 2nd Gen
- **Database**: Firestore (NoSQL) + セキュリティルール
- **Authentication**: Firebase Auth (匿名 → Google連携)
- **OCR**: Google Cloud Vision API
- **Hosting**: Vercel (Web) + Firebase Functions (API)
- **CI/CD**: GitHub Actions

### データモデル（1:1マッピング設計）
```typescript
// 理想設計: シンプルな2コレクション構成
interface Expense {
  appUid: string;      // Firebase Auth UID (主キー)
  lineId: string;      // LINE User ID  
  amount: number;
  category: string;
  date: string;        // YYYY-MM-DD
  // ...
}

interface UserLink {
  lineId: string;      // 1:1マッピング
}
```

## 🚀 クイックスタート

### 1. リポジトリクローン
```bash
git clone https://github.com/makoto041s/line-kakeibo.git
cd line-kakeibo
```

### 2. 依存関係インストール
```bash
# Bot
cd bot && npm install

# Web  
cd ../web && npm install
```

### 3. 環境設定
```bash
# Firebase プロジェクト作成
firebase login
firebase init

# 環境変数設定
cp web/.env.example web/.env.local
# .env.local を編集
```

### 4. ローカル開発
```bash
# Web (http://localhost:3000)
cd web && npm run dev

# Bot (http://localhost:8080) 
cd bot && npm run dev
```

### 5. デプロイ
```bash
# ワンコマンドデプロイ
cd web && npm run deploy:all

# 個別デプロイ
npm run deploy        # Web only
npm run deploy:bot    # Bot only
```

## 📱 使用方法

### LINE Bot
1. QRコードでBotを友達追加
2. 📸 レシート画像送信 → 自動OCR・登録
3. 💬 「家計簿」送信 → 最近の支出表示
4. 💬 「500 ランチ」→ テキスト直接登録

### Web アプリ
- 📊 **ダッシュボード**: 月次統計・グラフ表示
- 📋 **支出一覧**: フィルタ・ソート・編集
- ✏️ **編集機能**: 金額・カテゴリ・日付修正
- 🔗 **アカウント連携**: Google認証でデータ同期

## 🔧 開発ガイド

### プロジェクト構成（理想設計）
```
line-kakeibo/
├─ bot/              # Cloud Functions (Node 20)
│  ├─ src/
│  │  ├─ index.ts    # LINE webhook
│  │  ├─ parser.ts   # Vision OCR
│  │  └─ firestore.ts # DB操作
│  └─ package.json
├─ web/              # Next.js (App Router)
│  ├─ app/
│  │  ├─ page.tsx    # Dashboard  
│  │  ├─ expenses/   # 支出管理
│  │  └─ api/        # API Routes
│  ├─ lib/
│  │  ├─ firebase.ts # Client SDK
│  │  └─ hooks.ts    # React Hooks
│  └─ package.json
├─ types/            # 共通型定義
├─ firestore.rules   # セキュリティルール
└─ .github/workflows/ # CI/CD
```

### データフロー
1. **LINE → OCR**: レシート画像 → Vision API
2. **Parser**: OCR結果 → 構造化データ
3. **Firestore**: appUid で 1:1 保存
4. **Web**: リアルタイム表示・編集

### セキュリティ（appUidベース）
```javascript
// firestore.rules
match /expenses/{id} {
  allow read, write: if request.auth.uid == resource.data.appUid;
}
```

## 📊 運用・監視

### ログ確認
```bash
# Cloud Functions
firebase functions:log

# Vercel
vercel logs
```

### パフォーマンス
- 📈 **Vercel Analytics**: Web パフォーマンス
- 📊 **Firebase Console**: Firestore使用量
- 🔍 **Cloud Logging**: エラー監視

### スケーリング
- ⚡ **Functions**: 自動スケール（256MB〜）
- 🌐 **Vercel**: Edge Network + CDN
- 💾 **Firestore**: 読み取り最適化済み

## 🎯 ロードマップ

### v1.0 (完了)
- ✅ LINE Bot基本機能
- ✅ OCR処理・データ抽出  
- ✅ Web ダッシュボード
- ✅ 理想設計準拠アーキテクチャ

### v1.1 (開発中)
- [ ] PWA対応
- [ ] ダークモード
- [ ] 通知機能

### v2.0 (計画中)  
- [ ] 多通貨対応
- [ ] AI カテゴリ自動分類
- [ ] 家族共有機能

## 🤝 コントリビュート

1. Fork this repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📄 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) ファイルを参照

## 🙏 謝辞

- [Firebase](https://firebase.google.com/) - バックエンドインフラ
- [Google Cloud Vision](https://cloud.google.com/vision/) - OCR API
- [LINE Messaging API](https://developers.line.biz/) - Bot プラットフォーム
- [Next.js](https://nextjs.org/) - Webフレームワーク
- [Vercel](https://vercel.com/) - ホスティング

---

⭐ **気に入ったらStarをお願いします！** ⭐