import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, UserCredential } from 'firebase/auth';

const config = {
  authDomain: "line-kakeibo-0410.firebaseapp.com",
  projectId: "line-kakeibo-0410",
  storageBucket: "line-kakeibo-0410.appspot.com",
  messagingSenderId: "440748785600",
  appId: "",
  measurementId: "G-PLNC7GY160",
};

const app =
  typeof window === 'undefined'
    ? undefined
    : getApps().length
      ? getApp()
      : initializeApp(config);

export const db   = app ? getFirestore(app) : undefined;
export const auth = app ? getAuth(app)       : undefined;

// ラッパーにして名前を *signInAnonymous* にそろえる
export const signInAnonymous = (): Promise<UserCredential> =>
  signInAnonymously(auth!);
