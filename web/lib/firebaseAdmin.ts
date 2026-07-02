// web/lib/firebaseAdmin.ts
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  const json = Buffer
    .from(process.env.FIREBASE_SA_BASE64!, 'base64')
    .toString('utf8');

  initializeApp({
    credential: cert(JSON.parse(json)),
  });
}

export const db = getFirestore();
