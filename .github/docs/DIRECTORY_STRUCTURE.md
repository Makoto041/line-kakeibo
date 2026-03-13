# ディレクトリ構造計画

> Gmail連携自動化後の最終的なディレクトリ構造

## 現在の構造

```
line-kakeibo/
├── .github/
│   ├── docs/                    # ドキュメント
│   │   ├── GMAIL_AUTO_SPEC_V2.md
│   │   ├── IMPLEMENTATION_ROADMAP.md
│   │   └── DIRECTORY_STRUCTURE.md
│   └── workflows/               # CI/CD
├── bot/                         # Firebase Functions
│   ├── src/
│   │   ├── index.ts             # エントリーポイント
│   │   ├── parser.ts            # レシートパース
│   │   ├── textParser.ts        # テキストパース
│   │   ├── firestore.ts         # Firestore操作
│   │   ├── geminiCategoryClassifier.ts  # Gemini分類
│   │   ├── enhancedParser.ts    # 高度なパース
│   │   ├── imageOptimizer.ts    # 画像最適化
│   │   ├── costMonitor.ts       # コスト監視
│   │   ├── userLinks.ts         # ユーザーリンク
│   │   ├── linkUserResolver.ts  # ユーザー解決
│   │   ├── syncUserLinks.ts     # ユーザー同期
│   │   ├── importMoneyForward.ts # MF連携
│   │   ├── categoryNormalization.ts # カテゴリ正規化
│   │   └── enhancedCategoryClassifier.ts
│   ├── dist/                    # ビルド出力
│   ├── package.json
│   └── tsconfig.json
├── web/                         # Next.js Webアプリ
│   ├── app/
│   │   ├── dashboard/
│   │   ├── page.tsx
│   │   └── layout.tsx
│   ├── components/
│   └── package.json
├── firebase.json
├── firestore.rules
└── firestore.indexes.json
```

## 計画後の構造

```
line-kakeibo/
├── .github/
│   ├── docs/
│   │   ├── GMAIL_AUTO_SPEC_V2.md     # 設計書
│   │   ├── IMPLEMENTATION_ROADMAP.md # 実装計画
│   │   └── DIRECTORY_STRUCTURE.md    # 本ファイル
│   └── workflows/
├── bot/
│   ├── src/
│   │   ├── index.ts
│   │   │
│   │   ├── gmail/                    # 🆕 Gmail連携モジュール
│   │   │   ├── index.ts              # エクスポート
│   │   │   ├── types.ts              # 型定義
│   │   │   ├── auth.ts               # OAuth2認証
│   │   │   ├── watch.ts              # Gmail Watch管理
│   │   │   ├── parser.ts             # メールパース
│   │   │   └── handler.ts            # Pub/Subハンドラー
│   │   │
│   │   ├── line/                     # 🆕 LINE関連を整理
│   │   │   ├── index.ts              # エクスポート
│   │   │   ├── flexMessage.ts        # Flex Message生成
│   │   │   ├── postback.ts           # Postback処理
│   │   │   ├── commands.ts           # テキストコマンド
│   │   │   └── notify.ts             # 通知送信
│   │   │
│   │   ├── gemini/                   # 🆕 Gemini関連を整理
│   │   │   ├── index.ts              # エクスポート
│   │   │   └── categorize.ts         # カテゴリ分類
│   │   │
│   │   ├── report/                   # 🆕 レポート機能
│   │   │   ├── index.ts              # エクスポート
│   │   │   └── monthly.ts            # 月次レポート
│   │   │
│   │   ├── expense/                  # 🆕 支出関連を整理
│   │   │   ├── index.ts              # エクスポート
│   │   │   ├── types.ts              # 型定義
│   │   │   ├── service.ts            # CRUD操作
│   │   │   └── settlement.ts         # 精算計算
│   │   │
│   │   ├── parser.ts                 # 既存（後にexpense/に移動検討）
│   │   ├── textParser.ts             # 既存
│   │   ├── firestore.ts              # 既存
│   │   ├── geminiCategoryClassifier.ts  # 既存（gemini/に移動検討）
│   │   ├── enhancedParser.ts
│   │   ├── imageOptimizer.ts
│   │   ├── costMonitor.ts
│   │   └── ...
│   │
│   ├── scripts/                      # 🆕 セットアップスクリプト
│   │   └── setup-gmail-oauth.ts      # OAuth初期設定
│   │
│   ├── dist/
│   ├── package.json
│   └── tsconfig.json
│
├── web/
│   ├── app/
│   │   ├── dashboard/
│   │   │   ├── page.tsx
│   │   │   ├── components/           # 🆕 ダッシュボード専用
│   │   │   │   ├── BudgetProgress.tsx
│   │   │   │   ├── CategoryChart.tsx
│   │   │   │   └── ExpenseList.tsx
│   │   │   └── ...
│   │   ├── settings/                 # 🆕 設定画面
│   │   │   ├── page.tsx
│   │   │   └── budget/
│   │   │       └── page.tsx
│   │   ├── page.tsx
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ui/                       # 共通UIコンポーネント
│   │   └── ...
│   └── package.json
│
├── firebase.json
├── firestore.rules
└── firestore.indexes.json
```

## モジュール依存関係

```
                    ┌─────────────────┐
                    │    index.ts     │
                    │  (エントリー)    │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│    gmail/     │   │    line/      │   │   report/     │
│ OAuth, Watch  │   │ Flex, Notify  │   │   Monthly     │
│   Parser      │   │  Postback     │   │               │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                            ▼
                   ┌────────────────┐
                   │   gemini/      │
                   │  categorize    │
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │   expense/     │
                   │   service      │
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │  firestore.ts  │
                   │   (既存)       │
                   └────────────────┘
```

## 移行方針

### Phase 1: 新規モジュール追加（破壊的変更なし）

1. `gmail/` ディレクトリを新規作成
2. `line/flexMessage.ts`, `line/postback.ts` を新規作成
3. `report/monthly.ts` を新規作成
4. 既存コードはそのまま維持

### Phase 2: 段階的リファクタリング（オプション）

1. `geminiCategoryClassifier.ts` → `gemini/categorize.ts`
2. LINE関連コードを `line/` に集約
3. 支出関連コードを `expense/` に集約

### 注意点

- Phase 1は既存機能に影響を与えない追加実装のみ
- Phase 2は機能追加後、安定稼働を確認してから実施
- リファクタリング時はすべてのテストがパスすることを確認
