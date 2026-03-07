# 実装方針確定書

> Gmail連携自動化プロジェクト - 最終決定事項

## 確定日

2026-03-07

## 関連ドキュメント

- [設計書 v2.0](./GMAIL_AUTO_SPEC_V2.md)
- [実装ロードマップ](./IMPLEMENTATION_ROADMAP.md)
- [ディレクトリ構造](./DIRECTORY_STRUCTURE.md)

---

## 1. 技術方針

### 1.1 ディレクトリ構造

| 決定事項 | 内容 |
|---------|------|
| Firebase Functions | `bot/src/` を継続使用（設計書の `functions/src/` は読み替え） |
| 新規モジュール | `bot/src/gmail/` に追加 |
| LINE拡張 | `bot/src/line/` に追加（段階的） |
| 既存コード | 変更なし（破壊的変更を避ける） |

### 1.2 Gmail連携

| 決定事項 | 内容 |
|---------|------|
| 認証方式 | OAuth 2.0（ユーザー認証型） |
| トークン保管 | Firestore `system/gmailToken` |
| 通知方式 | Gmail API Push (Pub/Sub) |
| Watch更新 | Cloud Scheduler で6日ごと |

### 1.3 対象カード

| 決定事項 | 内容 |
|---------|------|
| 監視対象 | 三井住友ゴールドVISA（NL）のみ |
| フィルタ方法 | Fromドメイン + 本文キーワード |
| 他カード | 完全無視（処理スキップ） |

---

## 2. 開発方針

### 2.1 ブランチ戦略

```
master (本番)
  └── feature/gmail-auto (Step 1)
        └── feature/manual-input (Step 2)
              └── feature/advance (Step 3)
                    └── feature/dashboard (Step 4)
```

### 2.2 リリース順序

| Step | 機能 | 依存関係 |
|------|-----|---------|
| 1 | Gmail自動取得 | なし（独立して実装可能） |
| 2 | 手入力強化 | Step 1と並行可能 |
| 3 | 立替機能 | Step 1, 2 完了後 |
| 4 | ダッシュボード | Step 1-3 完了後 |

### 2.3 テスト方針

| レベル | 方法 |
|-------|------|
| 単体テスト | メールパース、カテゴリ分類 |
| 結合テスト | Gmail → Firestore → LINE の一連の流れ |
| 本番テスト | 実際のカード利用通知で動作確認 |

---

## 3. 運用方針

### 3.1 監視項目

| 項目 | 方法 |
|-----|------|
| Gmail Watch有効期限 | Cloud Scheduler + アラート |
| OAuth トークン有効性 | 定期的なリフレッシュ |
| エラー発生 | Cloud Logging + LINE通知 |

### 3.2 ロールバック手順

```bash
# 問題発生時の即座の対応
git checkout master
firebase deploy --only functions
```

### 3.3 データ保護

| 項目 | 対策 |
|-----|------|
| OAuthトークン | Firebase Secret Manager |
| メール内容 | Firestoreに生データは保存しない |
| 個人情報 | 店舗名・金額のみ抽出 |

---

## 4. 初期作成済みファイル

### 4.1 ドキュメント

| ファイル | 内容 |
|---------|------|
| `.github/docs/GMAIL_AUTO_SPEC_V2.md` | 設計書 |
| `.github/docs/IMPLEMENTATION_ROADMAP.md` | 実装ロードマップ |
| `.github/docs/DIRECTORY_STRUCTURE.md` | ディレクトリ構造 |
| `.github/docs/IMPLEMENTATION_DECISION.md` | 本ファイル |

### 4.2 コード

| ファイル | 内容 |
|---------|------|
| `bot/src/gmail/types.ts` | 型定義 |
| `bot/src/gmail/index.ts` | モジュールエクスポート |

---

## 5. 次のアクション

### 5.1 Google Cloud Console設定

1. [ ] OAuth 2.0 クライアントID作成
2. [ ] Gmail API 有効化
3. [ ] Pub/Sub トピック作成
4. [ ] 権限設定

### 5.2 Step 1 実装開始

1. [ ] `feature/gmail-auto` ブランチ作成
2. [ ] `gmail/auth.ts` 実装
3. [ ] `gmail/parser.ts` 実装
4. [ ] `gmail/watch.ts` 実装
5. [ ] `gmail/handler.ts` 実装
6. [ ] `line/flexMessage.ts` 実装
7. [ ] `line/postback.ts` 実装

### 5.3 デプロイ

1. [ ] 環境変数設定 (Firebase Secrets)
2. [ ] デプロイ
3. [ ] Gmail Watch 初期登録
4. [ ] 動作確認

---

## 6. 承認

- **設計書**: 確定
- **実装方針**: 確定
- **次のステップ**: Step 1 実装開始準備完了
