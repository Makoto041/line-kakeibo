import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { randomBytes } from 'crypto';

let db: ReturnType<typeof getFirestore> | null = null;

function getDb() {
  if (!db) {
    db = getFirestore();
  }
  return db;
}

export interface UserLink {
  lineIds: string[];
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface LinkToken {
  lineId: string;
  createdAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
  used: boolean;
}

// Generate a secure token for linking accounts
export function generateLinkToken(): string {
  return randomBytes(32).toString('hex');
}

// Check if a LINE user is already linked to any Firebase Auth user
export async function isLineUserLinked(lineId: string): Promise<boolean> {
  try {
    const snapshot = await getDb()
      .collection('userLinks')
      .where('lineIds', 'array-contains', lineId)
      .limit(1)
      .get();
    
    return !snapshot.empty;
  } catch (error) {
    console.error('Error checking if LINE user is linked:', error);
    return false;
  }
}

// Store a link token temporarily for verification
export async function storeLinkToken(lineId: string, token: string): Promise<void> {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minute expiry
    
    console.log('Storing link token:', { lineId, token, now, expiresAt });
    
    await getDb().collection('linkTokens').doc(token).set({
      lineId,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: expiresAt,
      used: false
    });
    
    console.log('Link token stored successfully');
  } catch (error) {
    console.error('Error storing link token:', error);
    throw error;
  }
}

// Get LINE user by token (for verification in API route)
export async function getLineUserByToken(token: string): Promise<string | null> {
  try {
    const doc = await getDb().collection('linkTokens').doc(token).get();
    
    if (!doc.exists) {
      return null;
    }
    
    const data = doc.data() as LinkToken;
    
    // Check if token is expired or already used
    const now = new Date();
    const expiresAt = data.expiresAt.toDate();
    
    if (data.used || now > expiresAt) {
      return null;
    }
    
    return data.lineId;
  } catch (error) {
    console.error('Error getting LINE user by token:', error);
    return null;
  }
}

// Mark token as used
export async function markTokenAsUsed(token: string): Promise<void> {
  try {
    await getDb().collection('linkTokens').doc(token).update({
      used: true,
      usedAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('Error marking token as used:', error);
    throw error;
  }
}

// Add LINE user to Firebase Auth user's linked accounts
export async function linkLineUser(uid: string, lineId: string): Promise<void> {
  try {
    const userLinkRef = getDb().collection('userLinks').doc(uid);
    
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

// Get linked LINE user IDs for a Firebase Auth user
export async function getLinkedLineUsers(uid: string): Promise<string[]> {
  try {
    const doc = await getDb().collection('userLinks').doc(uid).get();
    
    if (!doc.exists) {
      return [];
    }
    
    const data = doc.data() as UserLink;
    return data.lineIds || [];
  } catch (error) {
    console.error('Error getting linked LINE users:', error);
    return [];
  }
}