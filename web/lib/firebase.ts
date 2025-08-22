import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, UserCredential } from 'firebase/auth';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "line-kakeibo-0410.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "line-kakeibo-0410",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "line-kakeibo-0410.appspot.com",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "440748785600",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || "G-PLNC7GY160",
};

// 必須の設定値をチェック
const validateConfig = () => {
  if (typeof window === 'undefined') return true; // SSRでは検証しない
  
  const required = ['apiKey', 'authDomain', 'projectId'];
  const missing = required.filter(key => !config[key as keyof typeof config]);
  
  if (missing.length > 0) {
    console.error(`Firebase configuration error: Missing required fields: ${missing.join(', ')}`);
    console.error('Please ensure all Firebase environment variables are set in Vercel.');
    return false;
  }
  return true;
};

let app;
try {
  app = typeof window === 'undefined'
    ? undefined
    : getApps().length
      ? getApp()
      : validateConfig() ? initializeApp(config) : undefined;
} catch (error) {
  console.error('Failed to initialize Firebase:', error);
  app = undefined;
}

export const db   = app ? getFirestore(app) : undefined;
export const auth = app ? getAuth(app)       : undefined;

// ラッパーにして名前を *signInAnonymous* にそろえる
export const signInAnonymous = (): Promise<UserCredential> =>
  signInAnonymously(auth!);
