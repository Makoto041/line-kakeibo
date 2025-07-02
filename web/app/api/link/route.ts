import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Initialize Firebase Admin SDK
if (!getApps().length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    );
    
    initializeApp({
      credential: cert(serviceAccount),
    });
  } else {
    // Fallback for local development
    initializeApp({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    });
  }
}

const db = getFirestore();
const auth = getAuth();

interface LinkToken {
  lineId: string;
  createdAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
  used: boolean;
}

async function verifyToken(token: string): Promise<string | null> {
  try {
    console.log('Verifying token:', token);
    const doc = await db.collection('linkTokens').doc(token).get();
    
    if (!doc.exists) {
      console.log('Token document does not exist');
      return null;
    }
    
    const data = doc.data() as LinkToken;
    console.log('Token data:', data);
    
    // Check if token is expired or already used
    const now = new Date();
    const expiresAt = data.expiresAt.toDate();
    
    console.log('Current time:', now);
    console.log('Expires at:', expiresAt);
    console.log('Used:', data.used);
    
    if (data.used || now > expiresAt) {
      console.log('Token is expired or used');
      return null;
    }
    
    console.log('Token is valid, returning lineId:', data.lineId);
    return data.lineId;
  } catch (error) {
    console.error('Error verifying token:', error);
    return null;
  }
}

async function markTokenAsUsed(token: string): Promise<void> {
  try {
    await db.collection('linkTokens').doc(token).update({
      used: true,
      usedAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('Error marking token as used:', error);
    throw error;
  }
}

async function linkLineUser(uid: string, lineId: string): Promise<void> {
  try {
    const userLinkRef = db.collection('userLinks').doc(uid);
    
    // Check if LINE user is already linked to another account
    const existingLinks = await db
      .collection('userLinks')
      .where('lineIds', 'array-contains', lineId)
      .get();
    
    if (!existingLinks.empty) {
      // Remove from existing account first
      for (const existingDoc of existingLinks.docs) {
        if (existingDoc.id !== uid) {
          await existingDoc.ref.update({
            lineIds: FieldValue.arrayRemove(lineId),
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      }
    }
    
    // Add to new account
    await userLinkRef.set({
      lineIds: FieldValue.arrayUnion(lineId),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    
    // Set createdAt only if this is a new document
    const doc = await userLinkRef.get();
    if (!doc.data()?.createdAt) {
      await userLinkRef.update({
        createdAt: FieldValue.serverTimestamp()
      });
    }
  } catch (error) {
    console.error('Error linking LINE user:', error);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { token, idToken } = await request.json();
    
    if (!token || !idToken) {
      return NextResponse.json(
        { error: 'Missing token or idToken' },
        { status: 400 }
      );
    }
    
    // Verify Firebase ID token
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (error) {
      console.error('Invalid Firebase ID token:', error);
      return NextResponse.json(
        { error: 'Invalid authentication' },
        { status: 401 }
      );
    }
    
    // Verify link token and get LINE user ID
    const lineId = await verifyToken(token);
    if (!lineId) {
      return NextResponse.json(
        { error: 'Invalid or expired link token' },
        { status: 400 }
      );
    }
    
    // Link the accounts
    await linkLineUser(decodedToken.uid, lineId);
    
    // Mark token as used
    await markTokenAsUsed(token);
    
    return NextResponse.json({
      success: true,
      message: 'Account linked successfully'
    });
    
  } catch (error) {
    console.error('Account linking error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const lineId = searchParams.get('lineId');
  
  console.log('GET /api/link - token:', token, 'lineId:', lineId);
  
  if (!token || !lineId) {
    console.log('Missing token or lineId');
    return NextResponse.json(
      { error: 'Missing token or lineId' },
      { status: 400 }
    );
  }
  
  // Verify the token is valid
  const verifiedLineId = await verifyToken(token);
  
  if (!verifiedLineId || verifiedLineId !== lineId) {
    console.log('Token verification failed. verifiedLineId:', verifiedLineId, 'expected lineId:', lineId);
    return NextResponse.json(
      { error: 'Invalid or expired link token' },
      { status: 400 }
    );
  }
  
  console.log('Token verification successful');
  return NextResponse.json({
    valid: true,
    lineId: verifiedLineId
  });
}