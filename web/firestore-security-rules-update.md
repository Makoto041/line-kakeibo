# Firestore Security Rules 更新が必要

承認者申請システムで新しく `approvalRequests` コレクションを使用しているため、Firestore Security Rulesを更新する必要があります。

## 追加が必要なルール

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 既存のルール...
    
    // 承認者申請のルール
    match /approvalRequests/{requestId} {
      // 認証済みユーザーは自分の申請を作成・読み取り可能
      allow create, read: if request.auth != null 
        && request.auth.uid == resource.data.userId;
      
      // 承認者は全ての申請を読み取り・更新可能
      allow read, update: if request.auth != null 
        && isApprover(request.auth.uid);
    }
    
    // 承認者チェック関数
    function isApprover(userId) {
      return exists(/databases/$(database)/documents/settings/approval) 
        && userId in get(/databases/$(database)/documents/settings/approval).data.approvers;
    }
  }
}
```

## 対処方法

1. Firebase Console にアクセス
2. Firestore Database > ルール
3. 上記のルールを追加
4. デプロイ

## 暫定対処法（開発環境）

開発中は以下のルールを使用可能：

```javascript
// 開発環境用（本番では使用しないこと）
match /approvalRequests/{requestId} {
  allow read, write: if request.auth != null;
}
```