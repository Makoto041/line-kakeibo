// web/lib/firebaseAdmin.ts
import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  const json = Buffer
    .from(process.env.FIREBASE_SA_BASE64!, 'base64')
    .toString('utf8');

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(json)),
  });
}

export { admin };