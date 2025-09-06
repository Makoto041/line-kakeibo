import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import dayjs from 'dayjs';

let db: ReturnType<typeof getFirestore> | null = null;

function getDb() {
  if (!db) {
    db = getFirestore();
  }
  return db;
}

// Group interface for shared household budgets
export interface Group {
  id?: string;
  name: string;             // Group name (e.g., "田中夫婦の家計簿")
  inviteCode: string;       // Unique invite code for joining
  createdBy: string;        // LINE ID of group creator
  lineGroupId?: string;     // LINE Group ID if created from LINE group
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// User settings interface for default category
export interface UserSettings {
  id?: string;
  lineId: string;
  defaultCategory?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// Group membership interface
export interface GroupMember {
  groupId: string;
  lineId: string;
  displayName: string;      // User's display name in the group
  joinedAt?: Timestamp;
  isActive: boolean;
}

// Enhanced Expense interface with group support
export interface Expense {
  id?: string;
  lineId: string;           // LINE User ID (who made the expense)
  appUid?: string;          // Firebase Auth User ID
  groupId?: string;         // Optional: if this expense belongs to a group
  lineGroupId?: string;     // LINE Group ID if from LINE group
  userDisplayName?: string; // Display name of the user who made the expense
  amount: number;
  description: string;
  date: string;             // YYYY-MM-DD format
  category: string;
  confirmed: boolean;
  ocrText?: string;
  items?: Array<{
    name: string;
    price: number;
    quantity?: number;
  }>;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// 統計情報インターフェース
export interface ExpenseStats {
  totalAmount: number;
  expenseCount: number;
  categoryTotals: Record<string, number>;
  dailyTotals: Record<string, number>;
}

// UserLink インターフェース
export interface UserLink {
  lineId: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// カテゴリマスターインターフェース
export interface CategoryMaster {
  id: string;
  name: string;
  keywords?: string[];
  icon?: string;
  isDefault: boolean;
}

// ユーザーカスタムカテゴリインターフェース
export interface UserCustomCategory {
  id: string;
  lineId: string;
  name: string;
  keywords?: string[];
  icon?: string;
  isDefault: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}


export async function saveExpense(expense: Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
  try {
    const now = Timestamp.now();
    
    // Remove undefined values to avoid Firestore validation errors
    const cleanExpense = Object.fromEntries(
      Object.entries(expense).filter(([_, value]) => value !== undefined)
    );
    
    const docRef = await getDb().collection('expenses').add({
      ...cleanExpense,
      createdAt: now,
      updatedAt: now
    });
    
    console.log(`Expense saved with ID: ${docRef.id}, lineId: ${expense.lineId}`);
    return docRef.id;
  } catch (error) {
    console.error('Error saving expense:', error);
    throw error;
  }
}

// LINE IDベースのクエリに変更
export async function getExpenses(lineId: string, limit: number = 50): Promise<Expense[]> {
  try {
    const snapshot = await getDb()
      .collection('expenses')
      .where('lineId', '==', lineId)
      .limit(limit)
      .get();

    // Sort in memory to avoid index requirement
    const expenses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as Expense));

    return expenses.sort((a, b) => {
      const aTime = a.createdAt?.toMillis() || 0;
      const bTime = b.createdAt?.toMillis() || 0;
      return bTime - aTime; // desc order
    });
  } catch (error) {
    console.error('Error getting expenses:', error);
    throw error;
  }
}

// Fast version for LINE Bot quick responses - minimal data transfer
export async function getExpensesSummary(lineId: string, limit: number = 5): Promise<Expense[]> {
  try {
    console.log(`Getting expenses summary for lineId: ${lineId}, limit: ${limit}`);
    
    // Get user's groups to aggregate group expenses (same logic as web app)
    const membershipSnapshot = await getDb()
      .collection('groupMembers')
      .where('lineId', '==', lineId)
      .where('isActive', '==', true)
      .get();
    
    const userGroupIds = membershipSnapshot.docs.map(doc => doc.data().groupId);
    console.log(`User belongs to groups: ${userGroupIds.join(', ')}`);
    
    // Fetch expenses: personal + group expenses
    const expensePromises: Promise<Expense[]>[] = [];
    
    // 1. Personal expenses (individual chat)
    const personalSnapshot = await getDb()
      .collection('expenses')
      .where('lineId', '==', lineId)
      .limit(limit * 2) // Get more to ensure we have enough after merging
      .get();
    
    let allExpenses = personalSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        amount: data.amount || 0,
        description: data.description || 'Unknown',
        date: data.date || '',
        createdAt: data.createdAt
      } as Expense;
    });
    
    // 2. Group expenses (if user belongs to groups)
    if (userGroupIds.length > 0) {
      for (const groupId of userGroupIds) {
        const groupSnapshot = await getDb()
          .collection('expenses')
          .where('groupId', '==', groupId)
          .limit(limit * 2)
          .get();
        
        const groupExpenses = groupSnapshot.docs.map(doc => {
          const data = doc.data();
          return {
            id: doc.id,
            amount: data.amount || 0,
            description: data.description || 'Unknown',
            date: data.date || '',
            createdAt: data.createdAt
          } as Expense;
        });
        
        allExpenses = allExpenses.concat(groupExpenses);
      }
    }
    
    // Remove duplicates
    const uniqueExpenses = allExpenses.filter((expense, index, self) => 
      index === self.findIndex(e => e.id === expense.id)
    );
    
    console.log(`Found ${uniqueExpenses.length} total expenses (personal + group)`);
    
    const expenses = uniqueExpenses;

    return expenses.sort((a, b) => {
      const aTime = a.createdAt?.toMillis() || 0;
      const bTime = b.createdAt?.toMillis() || 0;
      return bTime - aTime; // desc order
    });
  } catch (error) {
    console.error('Error getting expenses summary:', error);
    throw error;
  }
}

// LINE IDベースのクエリに変更
export async function getExpensesByDateRange(
  lineId: string, 
  startDate: string, 
  endDate: string
): Promise<Expense[]> {
  try {
    const snapshot = await getDb()
      .collection('expenses')
      .where('lineId', '==', lineId)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    // Sort in memory to avoid index requirement
    const expenses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as Expense));

    return expenses.sort((a, b) => b.date.localeCompare(a.date)); // desc order by date
  } catch (error) {
    console.error('Error getting expenses by date range:', error);
    throw error;
  }
}

export async function updateExpense(id: string, updates: Partial<Expense>): Promise<void> {
  try {
    await getDb().collection('expenses').doc(id).update({
      ...updates,
      updatedAt: Timestamp.now()
    });
  } catch (error) {
    console.error('Error updating expense:', error);
    throw error;
  }
}

export async function deleteExpense(id: string): Promise<void> {
  try {
    await getDb().collection('expenses').doc(id).delete();
  } catch (error) {
    console.error('Error deleting expense:', error);
    throw error;
  }
}

// LINE IDベースの統計取得
export async function getMonthlyStats(lineId: string, year: number, month: number): Promise<ExpenseStats> {
  try {
    const startDate = dayjs(`${year}-${month.toString().padStart(2, '0')}-01`).format('YYYY-MM-DD');
    const endDate = dayjs(startDate).endOf('month').format('YYYY-MM-DD');
    
    const expenses = await getExpensesByDateRange(lineId, startDate, endDate);
    
    const totalAmount = expenses.reduce((sum, expense) => sum + expense.amount, 0);
    const categoryTotals = expenses.reduce((acc, expense) => {
      acc[expense.category] = (acc[expense.category] || 0) + expense.amount;
      return acc;
    }, {} as Record<string, number>);
    
    const dailyTotals = expenses.reduce((acc, expense) => {
      acc[expense.date] = (acc[expense.date] || 0) + expense.amount;
      return acc;
    }, {} as Record<string, number>);
    
    return {
      totalAmount,
      expenseCount: expenses.length,
      categoryTotals,
      dailyTotals
    };
  } catch (error) {
    console.error('Error getting monthly stats:', error);
    throw error;
  }
}

// UserLinks管理機能
export async function createUserLink(appUid: string, lineId: string): Promise<void> {
  try {
    const now = Timestamp.now();
    await getDb().collection('userLinks').doc(appUid).set({
      lineId,
      createdAt: now,
      updatedAt: now
    });
    console.log(`UserLink created: ${appUid} -> ${lineId}`);
  } catch (error) {
    console.error('Error creating user link:', error);
    throw error;
  }
}

export async function getUserLink(appUid: string): Promise<UserLink | null> {
  try {
    const doc = await getDb().collection('userLinks').doc(appUid).get();
    if (doc.exists) {
      return doc.data() as UserLink;
    }
    return null;
  } catch (error) {
    console.error('Error getting user link:', error);
    throw error;
  }
}

export async function findAppUidByLineId(lineId: string): Promise<string | null> {
  try {
    const snapshot = await getDb()
      .collection('userLinks')
      .where('lineId', '==', lineId)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return null;
    }
    
    return snapshot.docs[0].id; // document ID is the appUid
  } catch (error) {
    console.error('Error finding appUid by lineId:', error);
    throw error;
  }
}

// Group management functions
export async function createGroup(name: string, createdBy: string, lineGroupId?: string): Promise<string> {
  try {
    const now = Timestamp.now();
    const inviteCode = generateInviteCode();
    
    const groupData: any = {
      name,
      inviteCode,
      createdBy,
      createdAt: now,
      updatedAt: now
    };
    
    if (lineGroupId) {
      groupData.lineGroupId = lineGroupId;
    }
    
    const docRef = await getDb().collection('groups').add(groupData);

    // Add creator as first member
    await addGroupMember(docRef.id, createdBy, "作成者");
    
    console.log(`Group created: ${docRef.id} by ${createdBy}${lineGroupId ? ` (LINE Group: ${lineGroupId})` : ''}`);
    return docRef.id;
  } catch (error) {
    console.error('Error creating group:', error);
    throw error;
  }
}

export async function joinGroup(inviteCode: string, lineId: string, displayName: string): Promise<string | null> {
  try {
    // Find group by invite code
    const groupSnapshot = await getDb()
      .collection('groups')
      .where('inviteCode', '==', inviteCode)
      .limit(1)
      .get();
    
    if (groupSnapshot.empty) {
      return null; // Invalid invite code
    }
    
    const groupDoc = groupSnapshot.docs[0];
    const groupId = groupDoc.id;
    
    // Check if user is already a member
    const memberSnapshot = await getDb()
      .collection('groupMembers')
      .where('groupId', '==', groupId)
      .where('lineId', '==', lineId)
      .limit(1)
      .get();
    
    if (!memberSnapshot.empty) {
      // User is already a member, just activate them
      await getDb().collection('groupMembers').doc(memberSnapshot.docs[0].id).update({
        isActive: true,
        displayName
      });
    } else {
      // Add new member
      await addGroupMember(groupId, lineId, displayName);
    }
    
    console.log(`User ${lineId} joined group ${groupId}`);
    return groupId;
  } catch (error) {
    console.error('Error joining group:', error);
    throw error;
  }
}

export async function addGroupMember(groupId: string, lineId: string, displayName: string): Promise<void> {
  try {
    const now = Timestamp.now();
    await getDb().collection('groupMembers').add({
      groupId,
      lineId,
      displayName,
      joinedAt: now,
      isActive: true
    });
  } catch (error) {
    console.error('Error adding group member:', error);
    throw error;
  }
}

export async function getUserGroups(lineId: string): Promise<Array<Group & { memberInfo: GroupMember }>> {
  try {
    // Get all active memberships for this user
    const memberSnapshot = await getDb()
      .collection('groupMembers')
      .where('lineId', '==', lineId)
      .where('isActive', '==', true)
      .get();
    
    if (memberSnapshot.empty) {
      return [];
    }
    
    // Get group details for each membership
    const groups = [];
    for (const memberDoc of memberSnapshot.docs) {
      const memberData = memberDoc.data() as GroupMember;
      const groupDoc = await getDb().collection('groups').doc(memberData.groupId).get();
      
      if (groupDoc.exists) {
        groups.push({
          id: groupDoc.id,
          ...groupDoc.data() as Group,
          memberInfo: memberData
        });
      }
    }
    
    return groups;
  } catch (error) {
    console.error('Error getting user groups:', error);
    throw error;
  }
}

export async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  try {
    const snapshot = await getDb()
      .collection('groupMembers')
      .where('groupId', '==', groupId)
      .where('isActive', '==', true)
      .get();
    
    return snapshot.docs.map(doc => ({
      ...doc.data() as GroupMember
    }));
  } catch (error) {
    console.error('Error getting group members:', error);
    throw error;
  }
}

// Enhanced expense functions for group support
export async function getGroupExpenses(groupId: string, limitCount: number = 50): Promise<Expense[]> {
  try {
    const snapshot = await getDb()
      .collection('expenses')
      .where('groupId', '==', groupId)
      .limit(limitCount)
      .get();

    const expenses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as Expense));

    return expenses.sort((a, b) => {
      const aTime = a.createdAt?.toMillis() || 0;
      const bTime = b.createdAt?.toMillis() || 0;
      return bTime - aTime; // desc order
    });
  } catch (error) {
    console.error('Error getting group expenses:', error);
    throw error;
  }
}

// Get expenses for a specific LINE group
export async function getLineGroupExpenses(lineGroupId: string, limitCount: number = 50): Promise<Expense[]> {
  try {
    const snapshot = await getDb()
      .collection('expenses')
      .where('lineGroupId', '==', lineGroupId)
      .limit(limitCount)
      .get();

    const expenses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as Expense));

    return expenses.sort((a, b) => {
      const aTime = a.createdAt?.toMillis() || 0;
      const bTime = b.createdAt?.toMillis() || 0;
      return bTime - aTime; // desc order
    });
  } catch (error) {
    console.error('Error getting LINE group expenses:', error);
    throw error;
  }
}

// LINE Group integration functions
export async function findOrCreateLineGroup(lineGroupId: string, lineUserId: string, userDisplayName: string): Promise<string> {
  try {
    // Check if a group already exists for this LINE group
    const existingGroupSnapshot = await getDb()
      .collection('groups')
      .where('lineGroupId', '==', lineGroupId)
      .limit(1)
      .get();
    
    if (!existingGroupSnapshot.empty) {
      const existingGroup = existingGroupSnapshot.docs[0];
      const groupId = existingGroup.id;
      
      // Check if user is already a member
      const memberSnapshot = await getDb()
        .collection('groupMembers')
        .where('groupId', '==', groupId)
        .where('lineId', '==', lineUserId)
        .limit(1)
        .get();
      
      if (memberSnapshot.empty) {
        // Add user as member
        await addGroupMember(groupId, lineUserId, userDisplayName);
        console.log(`Added user ${lineUserId} to existing LINE group ${groupId}`);
      } else {
        // Update user display name if changed
        await getDb().collection('groupMembers').doc(memberSnapshot.docs[0].id).update({
          displayName: userDisplayName,
          isActive: true
        });
      }
      
      return groupId;
    }
    
    // Create new group for this LINE group
    const groupName = `LINEグループ ${lineGroupId.substring(0, 8)}`;
    const groupId = await createGroup(groupName, lineUserId, lineGroupId);
    
    console.log(`Created new group ${groupId} for LINE group ${lineGroupId}`);
    return groupId;
  } catch (error) {
    console.error('Error finding or creating LINE group:', error);
    throw error;
  }
}

export async function getGroupByLineGroupId(lineGroupId: string): Promise<Group | null> {
  try {
    const snapshot = await getDb()
      .collection('groups')
      .where('lineGroupId', '==', lineGroupId)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return null;
    }
    
    const doc = snapshot.docs[0];
    return {
      id: doc.id,
      ...doc.data() as Group
    };
  } catch (error) {
    console.error('Error getting group by LINE group ID:', error);
    throw error;
  }
}

// User settings functions
export async function saveUserSettings(lineId: string, defaultCategory: string): Promise<void> {
  try {
    const db = getDb();
    const userSettingsRef = db.collection('userSettings').doc(lineId);
    
    await userSettingsRef.set({
      lineId,
      defaultCategory,
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now()
    }, { merge: true });
    
    console.log('User settings saved for:', lineId);
  } catch (error) {
    console.error('Error saving user settings:', error);
    throw error;
  }
}

export async function getUserSettings(lineId: string): Promise<UserSettings | null> {
  try {
    const db = getDb();
    const doc = await db.collection('userSettings').doc(lineId).get();
    
    if (!doc.exists) {
      return null;
    }
    
    return {
      id: doc.id,
      ...doc.data() as UserSettings
    };
  } catch (error) {
    console.error('Error getting user settings:', error);
    throw error;
  }
}

export async function updateUserSettings(lineId: string, updates: Partial<UserSettings>): Promise<void> {
  try {
    const db = getDb();
    const userSettingsRef = db.collection('userSettings').doc(lineId);
    
    await userSettingsRef.update({
      ...updates,
      updatedAt: Timestamp.now()
    });
    
    console.log('User settings updated for:', lineId);
  } catch (error) {
    console.error('Error updating user settings:', error);
    throw error;
  }
}

export async function deleteUserSettings(lineId: string): Promise<void> {
  try {
    const db = getDb();
    await db.collection('userSettings').doc(lineId).delete();
    
    console.log('User settings deleted for:', lineId);
  } catch (error) {
    console.error('Error deleting user settings:', error);
    throw error;
  }
}

// Utility function to generate unique invite codes
function generateInviteCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Category feedback interface
export interface CategoryFeedback {
  id?: string;
  lineId: string;
  originalCategory: string;
  correctedCategory: string;
  description: string;
  amount?: number;
  createdAt?: Timestamp;
}

// Category management functions
export async function getAllUserCategories(lineId: string): Promise<Array<CategoryMaster | UserCustomCategory>> {
  try {
    // Get default categories
    const defaultCategories: CategoryMaster[] = [
      { id: 'food', name: '食費', icon: '🍱', isDefault: true, keywords: ['食', 'ランチ', 'ディナー', '弁当', 'コンビニ', 'レストラン', 'カフェ', 'マクドナルド', 'スターバックス'] },
      { id: 'transport', name: '交通費', icon: '🚃', isDefault: true, keywords: ['電車', 'バス', 'タクシー', '交通', '地下鉄', '新幹線', '高速', 'ガソリン'] },
      { id: 'daily', name: '日用品', icon: '🧻', isDefault: true, keywords: ['日用品', 'ティッシュ', '洗剤', 'シャンプー', '歯ブラシ', 'タオル', '石鹸'] },
      { id: 'entertainment', name: '娯楽', icon: '🎮', isDefault: true, keywords: ['ゲーム', '映画', '娯楽', 'カラオケ', 'ボウリング', '遊園地', 'コンサート', 'ライブ'] },
      { id: 'clothing', name: '衣服', icon: '👕', isDefault: true, keywords: ['服', '衣類', 'ユニクロ', 'しまむら', '靴', '帽子', 'バッグ', 'アクセサリー'] },
      { id: 'health', name: '医療・健康', icon: '💊', isDefault: true, keywords: ['病院', '薬', '医療', '歯医者', 'サプリメント', '整体', 'マッサージ', 'ジム'] },
      { id: 'education', name: '教育', icon: '📚', isDefault: true, keywords: ['本', '教育', '学習', '参考書', '資格', '講座', 'セミナー', '文房具'] },
      { id: 'utility', name: '光熱費', icon: '💡', isDefault: true, keywords: ['電気', 'ガス', '水道', '携帯', 'インターネット', 'Wi-Fi'] },
      { id: 'housing', name: '住居費', icon: '🏠', isDefault: true, keywords: ['家賃', '管理費', '住宅ローン', '修繕費', '家具', '家電', 'リフォーム'] },
      { id: 'insurance', name: '保険', icon: '🛡️', isDefault: true, keywords: ['生命保険', '医療保険', '自動車保険', '火災保険', '年金'] },
      { id: 'tax', name: '税金', icon: '📋', isDefault: true, keywords: ['所得税', '住民税', '固定資産税', '自動車税', '国民健康保険'] },
      { id: 'beauty', name: '美容', icon: '💄', isDefault: true, keywords: ['化粧品', '美容院', 'ネイル', 'エステ', 'スキンケア', 'コスメ'] },
      { id: 'communication', name: '通信費', icon: '📱', isDefault: true, keywords: ['スマホ', '携帯電話', 'インターネット', 'プロバイダ', 'Wi-Fi', '通信料'] },
      { id: 'subscription', name: 'サブスク', icon: '📺', isDefault: true, keywords: ['Netflix', 'Amazon Prime', 'Spotify', 'YouTube Premium', 'サブスクリプション'] },
      { id: 'gift', name: 'プレゼント', icon: '🎁', isDefault: true, keywords: ['プレゼント', 'ギフト', 'お祝い', 'お返し', '誕生日', 'クリスマス'] },
      { id: 'travel', name: '旅行', icon: '✈️', isDefault: true, keywords: ['旅行', 'ホテル', '宿泊', '観光', '温泉', '航空券', '新幹線'] },
      { id: 'pet', name: 'ペット', icon: '🐕', isDefault: true, keywords: ['ペット', '犬', '猫', 'ペットフード', '動物病院', 'トリミング'] },
      { id: 'savings', name: '貯金', icon: '💰', isDefault: true, keywords: ['貯金', '投資', '積立', '定期預金', '株式', '投資信託'] },
      { id: 'other', name: 'その他', icon: '📝', isDefault: true, keywords: [] }
    ];

    // Get user custom categories
    const customSnapshot = await getDb()
      .collection('userCustomCategories')
      .where('lineId', '==', lineId)
      .get();
    
    const customCategories = customSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as UserCustomCategory));

    return [...defaultCategories, ...customCategories];
  } catch (error) {
    console.error('Error getting all user categories:', error);
    // Return basic default categories on error
    return [
      { id: 'food', name: '食費', icon: '🍱', isDefault: true },
      { id: 'transport', name: '交通費', icon: '🚃', isDefault: true },
      { id: 'daily', name: '日用品', icon: '🧻', isDefault: true },
      { id: 'entertainment', name: '娯楽', icon: '🎮', isDefault: true },
      { id: 'other', name: 'その他', icon: '📝', isDefault: true }
    ];
  }
}

export async function getUserCategoryFeedback(
  lineId: string,
  limit: number = 100
): Promise<CategoryFeedback[]> {
  try {
    const snapshot = await getDb()
      .collection('categoryFeedback')
      .where('lineId', '==', lineId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    } as CategoryFeedback));
  } catch (error) {
    console.error('Error getting category feedback:', error);
    return [];
  }
}

export async function recordCategoryFeedback(feedback: Omit<CategoryFeedback, 'id' | 'createdAt'>): Promise<void> {
  try {
    await getDb().collection('categoryFeedback').add({
      ...feedback,
      createdAt: Timestamp.now()
    });
    console.log(`Category feedback recorded for ${feedback.lineId}`);
  } catch (error) {
    console.error('Error recording category feedback:', error);
    throw error;
  }
}