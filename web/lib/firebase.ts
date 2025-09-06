import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getAuth, signInAnonymously, UserCredential } from 'firebase/auth';

// Firebase設定の型定義
interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
}

// Firebase設定を環境変数から取得
const config: FirebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "line-kakeibo-0410.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "line-kakeibo-0410",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "line-kakeibo-0410.appspot.com",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "440748785600",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || "G-PLNC7GY160",
};

// Firebaseの初期化状態を管理
let isInitialized = false;
let initializationError: Error | null = null;

// 設定値の検証
const validateConfig = (): { isValid: boolean; errors: string[] } => {
  const errors: string[] = [];
  
  // 必須フィールドのチェック
  if (!config.apiKey) {
    errors.push('NEXT_PUBLIC_FIREBASE_API_KEY is not set');
  }
  if (!config.projectId) {
    errors.push('NEXT_PUBLIC_FIREBASE_PROJECT_ID is not set');
  }
  
  // 開発環境での警告
  if (process.env.NODE_ENV === 'development') {
    if (!config.apiKey || !config.appId) {
      console.warn('⚠️ Firebase configuration is incomplete. Some features may not work properly.');
      console.warn('Please ensure all Firebase environment variables are set in .env.local or Vercel dashboard.');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// Firebase初期化
let app: ReturnType<typeof initializeApp> | undefined;
let db: ReturnType<typeof getFirestore> | undefined;
let auth: ReturnType<typeof getAuth> | undefined;

// 初期化処理
const initializeFirebase = () => {
  if (typeof window === 'undefined') {
    // SSRでは初期化をスキップ
    return;
  }
  
  if (isInitialized) {
    return;
  }
  
  try {
    const validation = validateConfig();
    
    if (!validation.isValid) {
      const errorMessage = `Firebase initialization failed:\n${validation.errors.join('\n')}`;
      console.error('🔴 ' + errorMessage);
      initializationError = new Error(errorMessage);
      
      // 開発環境では詳細な設定方法を表示
      if (process.env.NODE_ENV === 'development') {
        console.info(
          '📝 Firebase設定方法:\n' +
          '1. .env.localファイルを作成\n' +
          '2. 以下の環境変数を設定:\n' +
          '   NEXT_PUBLIC_FIREBASE_API_KEY=your-api-key\n' +
          '   NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id\n' +
          '   NEXT_PUBLIC_FIREBASE_APP_ID=your-app-id\n' +
          '3. npm run dev でサーバーを再起動'
        );
      }
      return;
    }
    
    // 既存のアプリがあるか確認
    if (getApps().length > 0) {
      app = getApp();
    } else {
      app = initializeApp(config);
      console.log('✅ Firebase initialized successfully');
    }
    
    // Firestore初期化
    db = getFirestore(app);
    
    // Emulator接続（開発環境のみ）
    if (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true') {
      try {
        connectFirestoreEmulator(db, 'localhost', 8080);
        console.log('🔧 Connected to Firestore emulator');
      } catch (error) {
        // すでに接続されている場合はエラーを無視
        if (!(error as Error).message?.includes('already been called')) {
          console.warn('Failed to connect to Firestore emulator:', error);
        }
      }
    }
    
    // Auth初期化
    auth = getAuth(app);
    
    isInitialized = true;
    
    // 接続テスト（開発環境のみ）
    if (process.env.NODE_ENV === 'development') {
      testFirebaseConnection();
    }
  } catch (error) {
    console.error('🔴 Fatal Firebase initialization error:', error);
    initializationError = error as Error;
    
    // エラーの詳細情報を提供
    if ((error as any)?.code === 'auth/invalid-api-key') {
      console.error('Invalid API key. Please check your Firebase configuration.');
    } else if ((error as any)?.code === 'auth/invalid-project-id') {
      console.error('Invalid project ID. Please check your Firebase configuration.');
    }
  }
};

// Firebase接続テスト関数
const testFirebaseConnection = async () => {
  if (!db) {
    console.warn('⚠️ Firebase connection test skipped: Firestore not initialized');
    return false;
  }
  
  try {
    // Firestoreへの簡単な読み取りテスト
    const { collection, limit, getDocs, query } = await import('firebase/firestore');
    const testQuery = query(collection(db, 'expenses'), limit(1));
    await getDocs(testQuery);
    console.log('✅ Firebase connection test successful');
    return true;
  } catch (error) {
    console.error('❌ Firebase connection test failed:', error);
    
    // エラーの種類に応じた対処法を提示
    if ((error as any)?.code === 'permission-denied') {
      console.info(
        '📝 Firestore Security Rules may be blocking access.\n' +
        'Please check your Firestore rules in Firebase Console.'
      );
    } else if ((error as any)?.code === 'unavailable') {
      console.info(
        '📝 Firestore service is unavailable.\n' +
        'Please check your internet connection and Firebase project status.'
      );
    }
    
    return false;
  }
};

// 初期化を実行
if (typeof window !== 'undefined') {
  initializeFirebase();
}

// 匿名認証のラッパー関数
export const signInAnonymous = async (): Promise<UserCredential> => {
  if (!auth) {
    throw new Error('Firebase Auth is not initialized. Please check your configuration.');
  }
  return signInAnonymously(auth);
};

// Firebase初期化状態を確認する関数
export const getFirebaseStatus = () => ({
  isInitialized,
  hasError: !!initializationError,
  error: initializationError,
  config: {
    projectId: config.projectId,
    hasApiKey: !!config.apiKey,
    hasAppId: !!config.appId,
  }
});

// 手動で再初期化を試みる関数
export const retryFirebaseInitialization = () => {
  isInitialized = false;
  initializationError = null;
  initializeFirebase();
  return getFirebaseStatus();
};

// エクスポート
export { db, auth, app, testFirebaseConnection };
