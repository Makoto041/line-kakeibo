'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  collection, 
  query, 
  where, 
  limit, 
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  deleteField,
  FirestoreError
} from 'firebase/firestore';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { db, auth, getFirebaseStatus, ensureFirebaseInitialized } from './firebase';
import { initLineAuth } from './lineAuth';
import dayjs from 'dayjs';
import { normalizeCategoryName } from './categoryNormalization';
import { getCached, setCached, hasCached, clearCached, updateCachedByPrefix } from './swrCache';
import { timestampToMillis } from './expenseState';
import { buildExpenseUpdate, shouldClearSubCategory } from './expenseEdit';
import {
  fetchLegacyAdvances,
  householdErrorCode,
  isHouseholdApiConfigured,
  type AdvancesResponse,
  type HouseholdErrorCode,
} from './householdApi';

// Firestore document data shape for expenses (avoids explicit any)
export type FirestoreExpenseData = Partial<Expense> & { category?: string };

// Group interface for shared household budgets
export interface Group {
  id: string;
  name: string;
  inviteCode: string;
  createdBy: string;
  lineGroupId?: string;     // LINE Group ID if created from LINE group
  createdAt?: Date | { seconds: number; nanoseconds: number };
  updatedAt?: Date | { seconds: number; nanoseconds: number };
}

// Group membership interface
export interface GroupMember {
  groupId: string;
  lineId: string;
  displayName: string;
  joinedAt?: Date | { seconds: number; nanoseconds: number };
  isActive: boolean;
}

// Expense status type (matches bot/src/firestore.ts ExpenseStatusType)
export type ExpenseStatus = 'pending' | 'shared' | 'personal' | 'advance_pending' | 'advance_settled';

// Input source type (matches bot/src/firestore.ts InputSourceType)
export type InputSource = 'line_text' | 'line_ocr' | 'gmail_auto' | 'recurring';

// Firestore Timestamp-like type for client-side use
export type FirestoreTimestamp = Date | { seconds: number; nanoseconds: number };

// Enhanced Expense interface with group support (matches bot/src/firestore.ts)
export interface Expense {
  id: string;
  lineId: string;           // LINE User ID (who made the expense)
  appUid?: string;          // Firebase Auth User ID
  groupId?: string;         // Optional: if this expense belongs to a group
  lineGroupId?: string;     // LINE Group ID if from LINE group
  userDisplayName?: string; // Display name of the user who made the expense
  amount: number;
  description: string;
  date: string;             // YYYY-MM-DD format
  category: string;
  subCategory?: string;     // 中項目。任意。category（大項目）とは別
  confirmed?: boolean;      // 確認済みフラグ
  includeInTotal: boolean;  // 合計に含めるかどうか
  status?: ExpenseStatus;   // 支出ステータス（確認待ち、共同費、立替など）
  inputSource?: InputSource; // 入力元（LINE テキスト、OCR、Gmail自動取得）
  payerId?: string;          // LINE User ID of the person who paid (defaults to lineId)
  payerDisplayName?: string; // Display name of the person who paid (defaults to userDisplayName)
  ocrText?: string;
  items?: Array<{
    name: string;
    price: number;
    quantity?: number;
  }>;
  // 立替機能フィールド
  advanceBy?: string;             // 立替者のLINE ID
  advanceFull?: boolean;          // 立替を全額で返す扱い（期間の精算に全額を加算。無ければ全額にする前の立替）
  advanceSettledAt?: FirestoreTimestamp; // 精算日時
  paymentMethod?: string;         // 支払い方法（cash, paypay, card）
  gmailMessageId?: string;        // Gmail自動取得時のメッセージID
  receiptUrl?: string;            // レシート画像のURL（Firebase Storage）
  createdAt?: FirestoreTimestamp;
  updatedAt?: FirestoreTimestamp;
}

// 統計情報インターフェース
export interface ExpenseStats {
  totalAmount: number;
  expenseCount: number;
  categoryTotals: Record<string, number>;
  dailyTotals: Record<string, number>;
}

// Firebaseエラーハンドリングヘルパー
const handleFirestoreError = (error: unknown): string => {
  console.error('Firestore Error:', error);
  
  if (error instanceof FirestoreError) {
    switch (error.code) {
      case 'permission-denied':
        return 'アクセス権限がありません。Firebaseのセキュリティルールを確認してください。';
      case 'unavailable':
        return 'Firestoreサービスに接続できません。インターネット接続を確認してください。';
      case 'not-found':
        return 'リクエストされたデータが見つかりません。';
      case 'already-exists':
        return 'データが既に存在します。';
      case 'failed-precondition':
        return '操作の前提条件が満たされていません。';
      case 'resource-exhausted':
        return 'リソースの上限に達しました。しばらくしてから再試行してください。';
      case 'invalid-argument':
        return '無効な引数が提供されました。';
      case 'unauthenticated':
        return '認証が必要です。再度ログインしてください。';
      default:
        return `Firestoreエラー: ${error.message}`;
    }
  }
  
  if (error instanceof Error) {
    return `エラー: ${error.message}`;
  }
  
  return '予期しないエラーが発生しました。';
};

// Firebase接続チェック関数（リトライ付き）
const checkFirebaseConnection = (): boolean => {
  // SSRでは常にfalseを返す
  if (typeof window === 'undefined') {
    return false;
  }

  const status = getFirebaseStatus();

  if (!status.isInitialized) {
    console.error('Firebase is not initialized', status);
    return false;
  }

  if (status.hasError) {
    console.error('Firebase initialization error:', status.error);
    return false;
  }

  if (!db) {
    console.error('Firestore database is not available');
    return false;
  }

  return true;
};

// Firebase初期化を待機する関数
const waitForFirebase = async (maxWaitMs: number = 5000, signal?: AbortSignal): Promise<boolean> => {
  if (typeof window === 'undefined') return false;

  // アボートされている場合は即座に終了
  if (signal?.aborted) return false;

  // まず初期化を明示的に試みる
  ensureFirebaseInitialized();

  // 初期化エラーがある場合は再試行しない
  const status = getFirebaseStatus();
  if (status.hasError) {
    return false;
  }

  // 既に接続できている場合は即座に返す
  if (checkFirebaseConnection()) {
    return true;
  }

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    // アボートされた場合は終了
    if (signal?.aborted) return false;

    if (checkFirebaseConnection()) {
      return true;
    }

    // 初期化エラーがない場合のみ再試行
    const currentStatus = getFirebaseStatus();
    if (!currentStatus.hasError && !currentStatus.isInitialized) {
      ensureFirebaseInitialized();
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return checkFirebaseConnection();
};

// 認証は Firebase の onAuthStateChanged + カスタムクレームで駆動する。
// URL の lineId は一切信用しない（旧方式の脆弱性の除去）。
// - uid      … appUid（auth.currentUser.uid）
// - lineId   … 検証済み LINE userId（ID トークンの custom claim。匿名時は null）
// - isAnonymous … 匿名フォールバック（＝lineId なし。データにアクセスできない）
// 解決結果はモジュールに保持し、ページ再マウント時に即時復元してスピナーの点滅を防ぐ。
interface LineAuthState {
  uid: string;
  lineId: string | null;
  isAnonymous: boolean;
}

let cachedLineAuth: LineAuthState | null = null;

// サインイン済みの Firebase ユーザー（uid = appUid）と LINE userId の対応（localStorage）。
// uid には常に同じ lineId のクレームが付く（bot の /auth/line は lineId から appUid を決めて発行する）ので、
// 開き直したときは ID トークンの読み直し（1 時間で期限が切れ、切れていれば通信が要る）を待たずに使い、
// 裏でクレームを確かめる。lineId はキャッシュのキーと表示に使うだけで、読み書きの可否はルールが判定する。
const LINE_ID_BY_UID_KEY = 'kakeibo:lineIdByUid';

function readKnownLineId(uid: string): string | null {
  try {
    const raw = localStorage.getItem(LINE_ID_BY_UID_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
    const value = map && typeof map === 'object' ? map[uid] : null;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * 確かめた lineId を覚える。前に覚えていた人と違う人（別の LINE アカウントでログインし直した）なら、
 * 前の人のキャッシュ（localStorage に残る支出など）を消す
 */
function rememberLineId(uid: string, lineId: string | null): void {
  try {
    const raw = localStorage.getItem(LINE_ID_BY_UID_KEY);
    const previous = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
    const previousLineIds = previous && typeof previous === 'object' ? Object.values(previous) : [];
    if (previousLineIds.some((id) => id !== lineId)) clearCached();
    if (lineId) localStorage.setItem(LINE_ID_BY_UID_KEY, JSON.stringify({ [uid]: lineId }));
    else localStorage.removeItem(LINE_ID_BY_UID_KEY);
  } catch {
    // 保存できない環境では毎回クレームを読む
  }
}

/** ID トークンの lineId クレーム。読めなかった（通信の失敗など）ときは undefined、クレームが無ければ null */
async function readLineIdClaim(user: User): Promise<string | null | undefined> {
  try {
    const result = await user.getIdTokenResult();
    const lineId = result.claims.lineId;
    return typeof lineId === 'string' && lineId ? lineId : null;
  } catch (e) {
    console.error('Failed to read lineId claim:', e);
    return undefined;
  }
}

export function useLineAuth() {
  const [state, setState] = useState<LineAuthState | null>(() => cachedLineAuth);
  const [loading, setLoading] = useState(() => cachedLineAuth === null);

  useEffect(() => {
    ensureFirebaseInitialized();
    // 起動時サインイン（LIFF もしくは匿名フォールバック）を確実に開始する
    initLineAuth();

    if (!auth) {
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        cachedLineAuth = null;
        setState(null);
        setLoading(false);
        return;
      }

      const apply = (lineId: string | null) => {
        const resolved: LineAuthState = {
          uid: fbUser.uid,
          lineId,
          isAnonymous: fbUser.isAnonymous || !lineId,
        };
        cachedLineAuth = resolved;
        setState(resolved);
        setLoading(false);
      };

      // 匿名（LIFF が使えないときのフォールバック）は lineId を持たない。覚えている対応には触れない
      // （一度の失敗で、次に開いたときの近道を消さない）
      if (fbUser.isAnonymous) {
        apply(null);
        return;
      }

      // 前回この uid で確かめた lineId があれば先に使う（上のコメント参照）
      const known = readKnownLineId(fbUser.uid);
      if (known) apply(known);

      // lineId は検証済みクレームから取得。読めなかった（通信の失敗など）ときは、覚えていた値のまま続ける
      const lineId = await readLineIdClaim(fbUser);
      if (lineId === undefined) {
        if (!known) apply(null);
        return;
      }
      rememberLineId(fbUser.uid, lineId);
      if (lineId !== known) apply(lineId);
    });

    return () => unsubscribe();
  }, []);

  // 旧: URL に lineId を引き回すヘルパー。現在は認証が Firebase に永続化されるため
  // URL への付与は不要。互換のため関数は残し、パスをそのまま返す。
  const getUrlWithLineId = (path: string) => path;

  return {
    lineId: state?.lineId ?? null,
    loading,
    getUrlWithLineId,
  };
}

/**
 * 自分が所属する（有効な）グループの groupId 一覧を取得する。
 *
 * 以前はユーザー自身の支出を最大200件走査して lineGroupId を集めていたが、
 * (1) 支出を一度も登録していないメンバーはグループを検出できない
 * (2) 200件を超えると取りこぼしうる
 * (3) セキュリティルールがメンバーシップで判定するようになったため、
 *     グループの所在は groupMembers を正とすべき
 * という理由から、groupMembers から引く方式に変更した。
 *
 * このクエリ形（where lineId == 自分）はルールの「自分のメンバーシップは読める」
 * 条項で許可される。
 */
// 所属グループはほぼ変わらない（世帯は 2 名固定）ので、同じ lineId の問い合わせは同時に走らせず
// しばらく使い回す（ホームは支出・今期・前期の集計で 3 回引いていた）。失敗したら捨てて次に引き直す
const GROUP_IDS_TTL_MS = 5 * 60 * 1000;
const groupIdsCache = new Map<string, { at: number; promise: Promise<string[]> }>();

function fetchMyActiveGroupIds(lineId: string): Promise<string[]> {
  const hit = groupIdsCache.get(lineId);
  if (hit && Date.now() - hit.at < GROUP_IDS_TTL_MS) return hit.promise;
  const promise = queryMyActiveGroupIds(lineId);
  groupIdsCache.set(lineId, { at: Date.now(), promise });
  promise.catch(() => {
    if (groupIdsCache.get(lineId)?.promise === promise) groupIdsCache.delete(lineId);
  });
  return promise;
}

async function queryMyActiveGroupIds(lineId: string): Promise<string[]> {
  if (!db) return [];
  const snapshot = await getDocs(
    query(
      collection(db, 'groupMembers'),
      where('lineId', '==', lineId),
      where('isActive', '==', true)
    )
  );
  const groupIds = new Set<string>();
  snapshot.docs.forEach((d) => {
    const groupId = (d.data() as { groupId?: string }).groupId;
    if (groupId) groupIds.add(groupId);
  });
  return Array.from(groupIds);
}

const NO_EXPENSES: Expense[] = [];

// 支出を書き換えた回数。取得の途中で書き換えがあったら、その取得結果（書き換え前の内容）は
// 使わずに取り直す（確認したばかりの行が「要確認」に戻るのを防ぐ）
let expensesWriteGen = 0;

export function useExpenses(userId: string | null, periodDays: number = 50, limitCount: number = 200, customStartDate?: string) {
  const expensesCacheKey = `expenses:${userId}:${periodDays}:${limitCount}:${customStartDate || ''}`;
  const [expenses, setExpenses] = useState<Expense[]>(() => getCached<Expense[]>(expensesCacheKey) ?? []);
  const [loading, setLoading] = useState(() => !hasCached(expensesCacheKey));
  const [error, setError] = useState<string | null>(null);
  // refetch() で増やして取り直す（キャッシュがあれば出したまま裏で取り直す）
  const [refetchNonce, setRefetchNonce] = useState(0);
  // 今の取得条件（キー）の結果が state に入っているか。条件が変わった直後の描画で、
  // 前の条件の一覧や「読み込み済み・0 件」を出さないために使う
  const [resultKey, setResultKey] = useState<string | null>(() =>
    hasCached(expensesCacheKey) ? expensesCacheKey : null
  );

  // ローカル書き換えの土台を今の条件の一覧にするため、最新の resultKey を持っておく
  const resultKeyRef = useRef(resultKey);
  useEffect(() => {
    resultKeyRef.current = resultKey;
  }, [resultKey]);

  useEffect(() => {
    if (!userId || userId === 'guest') {
      setLoading(false);
      setExpenses([]);
      setResultKey(expensesCacheKey);
      return;
    }

    // 条件が変わった・アンマウントした後に届いた結果で state を上書きしない
    let active = true;
    const gen = expensesWriteGen;

    // 再訪時はキャッシュを即表示し、裏で再取得（スピナーを出さない）。
    const cached = getCached<Expense[]>(expensesCacheKey);
    if (cached) {
      setExpenses(cached);
      setLoading(false);
      setResultKey(expensesCacheKey);
    } else {
      setLoading(true);
    }

    const fetchExpenses = async () => {
      // Firebase初期化を待機
      const isConnected = await waitForFirebase();
      if (!active) return;
      if (!isConnected) {
        const status = getFirebaseStatus();
        setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
        setLoading(false);
        setResultKey(expensesCacheKey);
        return;
      }

      // 取得の途中で書き換えがあった（結果は書き換え前の可能性がある）
      let superseded = false;
      try {
        setError(null);

        // Firebase接続の再確認
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません。設定を確認してください。');
        }
        
        // NOTE: 一般的なグループ機能は廃止、LINEグループのみを使用

        // 期間（条件は従来どおり。クエリの形はルールの許可条件に合わせてある）
        let range: { startDate: string; endDate: string } | null = null;
        if (customStartDate) {
          range = {
            startDate: customStartDate,
            endDate: dayjs(customStartDate).add(1, 'month').subtract(1, 'day').format('YYYY-MM-DD'),
          };
        } else if (periodDays > 0) {
          range = {
            startDate: dayjs().subtract(periodDays, 'day').format('YYYY-MM-DD'),
            endDate: dayjs().format('YYYY-MM-DD'),
          };
        }
        const firestore = db;
        const buildQuery = (field: 'lineId' | 'groupId', value: string, max: number) =>
          range
            ? query(
                collection(firestore, 'expenses'),
                where(field, '==', value),
                where('date', '>=', range.startDate),
                where('date', '<=', range.endDate),
                limit(max)
              )
            : query(collection(firestore, 'expenses'), where(field, '==', value), limit(max));
        const toExpense = (snap: { id: string; data: () => unknown }) => {
          const data = snap.data() as FirestoreExpenseData;
          return { id: snap.id, ...data, category: normalizeCategoryName(data.category) } as Expense;
        };

        // 所属グループの支出（groupMembers を正として引く。支出の走査はしない）。
        // 取れなくても自分の支出は出す
        const loadGroupExpenses = async (): Promise<Expense[]> => {
          try {
            const userGroupIds = await fetchMyActiveGroupIds(userId);
            const snapshots = await Promise.all(
              userGroupIds.map((groupId) => getDocs(buildQuery('groupId', groupId, Math.max(limitCount, 500))))
            );
            return snapshots.flatMap((snapshot) => snapshot.docs.map(toExpense));
          } catch (groupError) {
            console.error("LINEグループ支出取得エラー:", groupError);
            return [];
          }
        };

        // 自分の支出と所属グループの支出は並べて取る（以前は 3 往復を順に待っていた）
        const [personalSnapshot, lineGroupExpenses] = await Promise.all([
          getDocs(buildQuery('lineId', userId, limitCount)),
          loadGroupExpenses(),
        ]);
        const personalExpenses = personalSnapshot.docs.map(toExpense);

        // Combine all expenses and remove duplicates
        const allExpensesMap = new Map<string, Expense>();
        [...personalExpenses, ...lineGroupExpenses].forEach(expense => {
          allExpensesMap.set(expense.id, expense);
        });

        // 登録の新しい順（並べ替えはメモリで行い、複合インデックスを要らなくする）
        const sortedExpenses = Array.from(allExpensesMap.values()).sort(
          (a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt)
        );
        
        if (gen !== expensesWriteGen) {
          superseded = true;
          if (active) setRefetchNonce(n => n + 1);
          return;
        }
        // キーはこの取得の条件そのものなので、画面が離れていてもキャッシュは更新してよい
        setCached(expensesCacheKey, sortedExpenses);
        if (!active) return;
        setExpenses(sortedExpenses);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching expenses:', err);
        if (!active) return;
        setError(errorMessage);
        // キャッシュがある場合は消さず、前回値を残す（取得失敗でも空にしない）
        if (!hasCached(expensesCacheKey)) {
          setExpenses([]);
        }
      } finally {
        if (active && !superseded) {
          setLoading(false);
          setResultKey(expensesCacheKey);
        }
      }
    };

    fetchExpenses();
    return () => {
      active = false;
    };
  }, [userId, periodDays, limitCount, customStartDate, expensesCacheKey, refetchNonce]);

  // ローカルの一覧とキャッシュを書き換える。前の条件の一覧が state に残っている間は、
  // 今の条件のキャッシュを土台にする（前の条件の一覧で今の条件のキャッシュを上書きしない）
  const applyLocal = (fn: (list: Expense[]) => Expense[]) => {
    expensesWriteGen += 1;
    if (!hasCached(expensesCacheKey) && resultKeyRef.current !== expensesCacheKey) {
      // 今の条件の一覧がまだ無い（読み込み中）。書き換え後の内容で取り直す
      setRefetchNonce(n => n + 1);
      return;
    }
    setExpenses(prev => {
      const base = getCached<Expense[]>(expensesCacheKey) ?? prev;
      const next = fn(base);
      setCached(expensesCacheKey, next);
      return next;
    });
    setResultKey(expensesCacheKey);
  };

  /**
   * @param original 元の支出。大項目（category）を変えるときに渡すと、元の支出が中項目
   *   （subCategory）を持っていれば中項目を消す（buildExpenseUpdate）。
   */
  const updateExpense = async (
    id: string,
    updates: Partial<Expense>,
    original?: Pick<Expense, 'category' | 'subCategory'>
  ) => {
    if (!checkFirebaseConnection()) {
      throw new Error('Firebase接続エラー: データベースが利用できません');
    }

    if (!db) {
      throw new Error('Firestoreデータベースが初期化されていません');
    }

    try {
      // category は渡されたときだけ正規化する（差分だけの保存で category を消さない）
      const normalizedUpdates: Partial<Expense> = {
        ...updates,
        ...(updates.category !== undefined ? { category: normalizeCategoryName(updates.category) } : {}),
      };

      // Remove undefined values to avoid Firestore errors
      const cleanUpdates = Object.fromEntries(
        Object.entries(normalizedUpdates).filter(([, value]) => value !== undefined)
      ) as Partial<Expense>;
      const clearSubCategory = shouldClearSubCategory(cleanUpdates, original);

      expensesWriteGen += 1;
      await updateDoc(doc(db, 'expenses', id), {
        ...buildExpenseUpdate(cleanUpdates, original, deleteField),
        updatedAt: new Date()
      });

      // Update local state（キャッシュも同期して再訪時の巻き戻りを防ぐ）。
      // 消した中項目は、削除の印（deleteField の値）ではなくキーごと取り除く
      applyLocal(list =>
        list.map(expense => {
          if (expense.id !== id) return expense;
          const next = { ...expense, ...cleanUpdates };
          if (clearSubCategory) delete next.subCategory;
          return next;
        })
      );
    } catch (err) {
      const errorMessage = handleFirestoreError(err);
      console.error('Error updating expense:', err);
      throw new Error(errorMessage);
    }
  };

  const deleteExpense = async (id: string) => {
    if (!checkFirebaseConnection()) {
      throw new Error('Firebase接続エラー: データベースが利用できません');
    }
    
    if (!db) {
      throw new Error('Firestoreデータベースが初期化されていません');
    }
    
    try {
      expensesWriteGen += 1;
      await deleteDoc(doc(db, 'expenses', id));
      
      // Update local state（キャッシュも同期）
      applyLocal(list => list.filter(expense => expense.id !== id));
    } catch (err) {
      const errorMessage = handleFirestoreError(err);
      console.error('Error deleting expense:', err);
      throw new Error(errorMessage);
    }
  };

  // サーバー経由の変更（確認など）の結果を、再取得せずに一覧へ反映する。
  // 他の画面が持つ同じ支出のキャッシュも揃える。
  const patchLocal = useCallback((id: string, patch: Partial<Expense>) => {
    expensesWriteGen += 1;
    setExpenses(prev => prev.map(expense => (expense.id === id ? { ...expense, ...patch } : expense)));
    patchCachedExpenses([id], patch);
  }, []);

  // 条件が変わった直後（effect がまだ走っていない描画）は、新しい条件のキャッシュか空の読み込み中を返す
  const current = resultKey === expensesCacheKey;
  return { 
    expenses: current ? expenses : (getCached<Expense[]>(expensesCacheKey) ?? NO_EXPENSES), 
    loading: current ? loading : !hasCached(expensesCacheKey), 
    error: current ? error : null, 
    updateExpense, 
    deleteExpense,
    patchLocal,
    // 取り直す（以前の実装は effect を再実行できず読み込み中のまま止まっていた）
    refetch: () => {
      if (userId) setRefetchNonce(n => n + 1);
    }
  };
}

export function useMonthlyStats(userId: string | null, year: number, month: number, startDay: number = 1, customStartDate?: string, customEndDate?: string) {
  const statsCacheKey = `stats:${userId}:${customStartDate || ''}:${customEndDate || ''}:${year}:${month}:${startDay}`;
  const [stats, setStats] = useState<ExpenseStats | null>(() => getCached<ExpenseStats>(statsCacheKey) ?? null);
  const [loading, setLoading] = useState(() => !hasCached(statsCacheKey));
  const [error, setError] = useState<string | null>(null);
  // refetch() で増やして再取得する（キャッシュは先に出したまま裏で取り直す）
  const [refetchNonce, setRefetchNonce] = useState(0);
  // 今の条件（キー）の結果が state に入っているか（useExpenses と同じ。前の期間の値を出さないため）
  const [resultKey, setResultKey] = useState<string | null>(() =>
    hasCached(statsCacheKey) ? statsCacheKey : null
  );

  useEffect(() => {
    if (!userId || userId === 'guest') {
      setLoading(false);
      setResultKey(statsCacheKey);
      return;
    }

    // 条件が変わった・アンマウントした後に届いた結果で state を上書きしない
    let active = true;

    // 再訪時はキャッシュを即表示し、スピナーを出さずに裏で再取得する。
    const cached = getCached<ExpenseStats>(statsCacheKey);
    if (cached) {
      setStats(cached);
      setLoading(false);
      setResultKey(statsCacheKey);
    } else {
      setLoading(true);
    }

    const fetchStats = async () => {
      // Firebase初期化を待機
      const isConnected = await waitForFirebase();
      if (!active) return;
      if (!isConnected) {
        const status = getFirebaseStatus();
        setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
        setLoading(false);
        setResultKey(statsCacheKey);
        return;
      }
      try {
        setError(null);

        if (!db) {
          throw new Error('Firestoreデータベースが利用できません');
        }
        
        let startDate: string;
        let endDate: string;
        
        if (customStartDate && customEndDate) {
          startDate = customStartDate;
          endDate = customEndDate;
        } else {
          startDate = dayjs(`${year}-${month.toString().padStart(2, '0')}-${startDay.toString().padStart(2, '0')}`).format('YYYY-MM-DD');
          endDate = dayjs(startDate).add(1, 'month').subtract(1, 'day').format('YYYY-MM-DD');
        }
        
        // NOTE: 一般的なグループ機能は廃止、LINEグループのみを使用
        const firestore = db;
        const buildQuery = (field: 'lineId' | 'groupId', value: string) =>
          query(
            collection(firestore, 'expenses'),
            where(field, '==', value),
            where('date', '>=', startDate),
            where('date', '<=', endDate)
          );
        const toExpense = (snap: { id: string; data: () => unknown }) =>
          ({ id: snap.id, ...(snap.data() as FirestoreExpenseData) } as Expense);

        // 所属グループの支出（groupMembers を正として引く。支出の走査はしない）
        const loadGroupExpenses = async (): Promise<Expense[]> => {
          try {
            const userGroupIds = await fetchMyActiveGroupIds(userId);
            const snapshots = await Promise.all(userGroupIds.map((groupId) => getDocs(buildQuery('groupId', groupId))));
            return snapshots.flatMap((snapshot) => snapshot.docs.map(toExpense));
          } catch (groupError) {
            console.error("月次統計 - LINEグループ支出取得エラー:", groupError);
            return [];
          }
        };

        // 自分の支出と所属グループの支出は並べて取る
        const [personalSnapshot, lineGroupExpenses] = await Promise.all([
          getDocs(buildQuery('lineId', userId)),
          loadGroupExpenses(),
        ]);
        const personalExpenses = personalSnapshot.docs.map(toExpense);
        
        // Combine all expenses and remove duplicates
        const allExpensesMap = new Map<string, Expense>();
        
        [...personalExpenses, ...lineGroupExpenses].forEach(expense => {
          allExpensesMap.set(expense.id, expense);
        });
        
        const allExpenses = Array.from(allExpensesMap.values());
        
        // Sort in memory by date desc
        const expenses = allExpenses.sort((a, b) => b.date.localeCompare(a.date));
        
        // 合計に含める支出のみを統計計算に含める
        const includedExpenses = expenses.filter(expense => expense.includeInTotal);
        
        const totalAmount = includedExpenses.reduce((sum, expense) => sum + expense.amount, 0);
        
        const categoryTotals = includedExpenses.reduce((acc, expense) => {
          acc[expense.category] = (acc[expense.category] || 0) + expense.amount;
          return acc;
        }, {} as Record<string, number>);
        
        const dailyTotals = includedExpenses.reduce((acc, expense) => {
          acc[expense.date] = (acc[expense.date] || 0) + expense.amount;
          return acc;
        }, {} as Record<string, number>);
        
        const nextStats: ExpenseStats = {
          totalAmount,
          expenseCount: includedExpenses.length,
          categoryTotals,
          dailyTotals
        };
        setCached(statsCacheKey, nextStats);
        if (!active) return;
        setStats(nextStats);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching monthly stats:', err);
        if (!active) return;
        setError(errorMessage);
      } finally {
        if (active) {
          setLoading(false);
          setResultKey(statsCacheKey);
        }
      }
    };

    fetchStats();
    return () => {
      active = false;
    };
  }, [userId, year, month, startDay, customStartDate, customEndDate, statsCacheKey, refetchNonce]);

  const refetch = useCallback(() => {
    setRefetchNonce(n => n + 1);
  }, []);

  const current = resultKey === statsCacheKey;
  return {
    stats: current ? stats : (getCached<ExpenseStats>(statsCacheKey) ?? null),
    loading: current ? loading : !hasCached(statsCacheKey),
    error: current ? error : null,
    refetch,
  };
}

// グループメンバーを取得するフック
export function useUserGroups(userId: string | null) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || userId === 'guest') {
      setLoading(false);
      return;
    }

    const fetchGroups = async () => {
      // Firebase初期化を待機
      const isConnected = await waitForFirebase();
      if (!isConnected) {
        const status = getFirebaseStatus();
        setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        
        if (!db) {
          throw new Error('Firestoreデータベースが利用できません');
        }
        
        // Get user's group memberships
        const membershipQuery = query(
          collection(db, 'groupMembers'),
          where('lineId', '==', userId),
          where('isActive', '==', true)
        );
        
        const membershipSnapshot = await getDocs(membershipQuery);
        
        if (membershipSnapshot.empty) {
          setGroups([]);
          setError(null);
          return;
        }
        
        // Get group details for each membership
        const groupPromises = membershipSnapshot.docs.map(async (memberDoc) => {
          const memberData = memberDoc.data();
          const groupDoc = await getDoc(doc(db!, 'groups', memberData.groupId));
          
          if (groupDoc.exists()) {
            return {
              id: groupDoc.id,
              ...groupDoc.data()
            } as Group;
          }
          return null;
        });
        
        const groupResults = await Promise.all(groupPromises);
        const validGroups = groupResults.filter(group => group !== null) as Group[];
        
        setGroups(validGroups);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching user groups:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchGroups();
  }, [userId]);

  return { groups, loading, error };
}

export function useGroupMembers(groupId: string | null) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId) {
      setLoading(false);
      setMembers([]);
      return;
    }

    const fetchGroupMembers = async () => {
      // Firebase初期化を待機
      const isConnected = await waitForFirebase();
      if (!isConnected) {
        const status = getFirebaseStatus();
        setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
        setLoading(false);
        return;
      }
      try {
        setLoading(true);

        const membersQuery = query(
          collection(db!, 'groupMembers'),
          where('groupId', '==', groupId),
          where('isActive', '==', true)
        );

        const snapshot = await getDocs(membersQuery);
        
        if (snapshot.empty) {
          setMembers([]);
          setError(null);
          return;
        }

        const memberList: GroupMember[] = snapshot.docs.map(doc => {
          const data = doc.data();
          return {
            id: doc.id,
            groupId: data.groupId,
            lineId: data.lineId,
            displayName: data.displayName || `Unknown_${data.lineId?.slice(-6) || 'NoID'}`,
            joinedAt: data.joinedAt,
            isActive: data.isActive
          } as GroupMember;
        });

        setMembers(memberList);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching group members:', err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchGroupMembers();
  }, [groupId]);

  return { members, loading, error };
}

// 予算設定インターフェース
export interface BudgetConfig {
  monthlyBudget: number;
  categoryBudgets: Record<string, number>;
  alertThreshold: number;
}

// デフォルトの予算設定
/** 予算を未設定のときの月の予算 */
export const DEFAULT_MONTHLY_BUDGET = 200000;

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  monthlyBudget: DEFAULT_MONTHLY_BUDGET,
  categoryBudgets: {},
  alertThreshold: 20,
};

// Firestoreから予算設定を取得するフック
export function useBudgetConfig(userId: string | null) {
  const budgetCacheKey = `budget:${userId}`;
  const [config, setConfig] = useState<BudgetConfig | null>(() => getCached<BudgetConfig>(budgetCacheKey) ?? null);
  const [loading, setLoading] = useState(() => !hasCached(budgetCacheKey));
  const [error, setError] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    if (!userId || userId === 'guest') {
      setConfig(DEFAULT_BUDGET_CONFIG);
      setLoading(false);
      return;
    }

    // 再訪時はキャッシュを即表示し、裏で再取得する。
    const cached = getCached<BudgetConfig>(budgetCacheKey);
    if (cached) {
      setConfig(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    const fetchBudgetConfig = async () => {
      const isConnected = await waitForFirebase();
      if (!isConnected) {
        const status = getFirebaseStatus();
        setError(`Firebase接続エラー: ${status.error?.message || '初期化に失敗しました'}`);
        setLoading(false);
        return;
      }

      try {
        setError(null);

        if (!db) {
          throw new Error('Firestoreデータベースが利用できません');
        }

        const docRef = doc(db, 'budgetSettings', userId);
        const docSnap = await getDoc(docRef);

        const nextConfig: BudgetConfig = docSnap.exists()
          ? {
              monthlyBudget: typeof docSnap.data().monthlyBudget === 'number' && docSnap.data().monthlyBudget > 0
                ? docSnap.data().monthlyBudget
                : DEFAULT_BUDGET_CONFIG.monthlyBudget,
              categoryBudgets: docSnap.data().categoryBudgets && typeof docSnap.data().categoryBudgets === 'object'
                ? docSnap.data().categoryBudgets
                : {},
              alertThreshold: typeof docSnap.data().alertThreshold === 'number'
                ? docSnap.data().alertThreshold
                : DEFAULT_BUDGET_CONFIG.alertThreshold,
            }
          : DEFAULT_BUDGET_CONFIG;

        setCached(budgetCacheKey, nextConfig);
        setConfig(nextConfig);
        setError(null);
      } catch (err) {
        const errorMessage = handleFirestoreError(err);
        console.error('Error fetching budget config:', err);
        setError(errorMessage);
        if (!hasCached(budgetCacheKey)) {
          setConfig(DEFAULT_BUDGET_CONFIG);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchBudgetConfig();
  }, [userId, refreshTrigger, budgetCacheKey]);

  // 手動で再取得するための関数
  const refetch = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  return { config, loading, error, refetch };
}

// ---------------------------------------------------------------------------
// キャッシュの同期（書き込み後に、別の画面が持つ古い値を出さないため）
// ---------------------------------------------------------------------------

/** 読み込み済みの支出一覧（expenses:* のキャッシュ）の該当 ID をまとめて書き換える */
export function patchCachedExpenses(ids: readonly string[], patch: Partial<Expense>): void {
  if (ids.length === 0) return;
  expensesWriteGen += 1;
  const targets = new Set(ids);
  updateCachedByPrefix<Expense[]>('expenses:', (list) => {
    if (!Array.isArray(list) || !list.some((e) => targets.has(e.id))) return list;
    return list.map((e) => (targets.has(e.id) ? { ...e, ...patch } : e));
  });
}

/**
 * 支出を変更したあとに呼ぶ。集計（stats:*）のキャッシュを捨て、次に開いたホームが
 * 古い予算残りを出さずに読み込み直すようにする。
 */
export function invalidateStatsCache(): void {
  clearCached('stats:');
}

// ---------------------------------------------------------------------------
// 世帯（所属グループ・メンバー）
// ---------------------------------------------------------------------------

export interface HouseholdMember {
  lineId: string;
  displayName: string;
}

export interface HouseholdInfo {
  /** 有効に所属しているグループ（書き込み可否の判定に使う） */
  activeGroupIds: string[];
  /** 主世帯（最初に参加したグループ）。所属が無ければ null */
  household: {
    groupId: string;
    name: string;
    lineGroupId: string | null;
    /** 有効メンバー（参加順） */
    members: HouseholdMember[];
    /** 期間の折半精算で集金するメンバー（groups.splitSettings）。未指定・メンバー外なら null */
    splitCollectFrom: string | null;
  } | null;
}

interface MembershipRow {
  groupId: string;
  lineId: string;
  displayName: string;
  joinedAtMs: number;
}

function toMembershipRow(data: Record<string, unknown>): MembershipRow | null {
  const groupId = typeof data.groupId === 'string' ? data.groupId : '';
  const lineId = typeof data.lineId === 'string' ? data.lineId : '';
  if (!groupId || !lineId) return null;
  const joinedAtMs = data.joinedAt == null ? Number.POSITIVE_INFINITY : timestampToMillis(data.joinedAt);
  return {
    groupId,
    lineId,
    displayName: typeof data.displayName === 'string' ? data.displayName : '',
    joinedAtMs,
  };
}

/** 参加順（joinedAt 昇順、同じなら lineId 順）。どの端末でも同じ並びにする */
function byJoinedAt(a: MembershipRow, b: MembershipRow): number {
  if (a.joinedAtMs !== b.joinedAtMs) return a.joinedAtMs < b.joinedAtMs ? -1 : 1;
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}

async function loadHousehold(lineId: string): Promise<HouseholdInfo> {
  if (!db) throw new Error('Firestoreデータベースが利用できません');
  // 自分の有効なメンバーシップ（fetchMyActiveGroupIds と同じクエリ形）
  const mine = await getDocs(
    query(collection(db, 'groupMembers'), where('lineId', '==', lineId), where('isActive', '==', true))
  );
  const myRows = mine.docs
    .map((d) => toMembershipRow(d.data() as Record<string, unknown>))
    .filter((r): r is MembershipRow => r !== null)
    .sort(byJoinedAt);
  const activeGroupIds = Array.from(new Set(myRows.map((r) => r.groupId)));
  // 支出の取得（fetchMyActiveGroupIds）と同じクエリなので、結果を使い回させる
  groupIdsCache.set(lineId, { at: Date.now(), promise: Promise.resolve(activeGroupIds) });
  if (activeGroupIds.length === 0) return { activeGroupIds, household: null };

  const groupId = myRows[0].groupId;
  const [groupSnap, membersSnap] = await Promise.all([
    // グループ名などは表示の補助なので、読めなくても世帯の判定は続ける
    getDoc(doc(db, 'groups', groupId)).catch((err: unknown) => {
      console.error('Failed to read household group:', err);
      return null;
    }),
    getDocs(query(collection(db, 'groupMembers'), where('groupId', '==', groupId), where('isActive', '==', true))),
  ]);
  const groupData = groupSnap?.exists() ? (groupSnap.data() as Record<string, unknown>) : {};

  // 自動 ID の古い文書と決定的 ID の文書が重なることがあるので lineId で 1 人にまとめる
  const members = new Map<string, MembershipRow>();
  membersSnap.docs
    .map((d) => toMembershipRow(d.data() as Record<string, unknown>))
    .filter((r): r is MembershipRow => r !== null)
    .sort(byJoinedAt)
    .forEach((row) => {
      const existing = members.get(row.lineId);
      if (!existing) members.set(row.lineId, row);
      else if (!existing.displayName && row.displayName) members.set(row.lineId, { ...existing, displayName: row.displayName });
    });

  const splitSettings = groupData.splitSettings as { collectFromLineId?: unknown } | undefined;
  const collectFrom = splitSettings?.collectFromLineId;

  return {
    activeGroupIds,
    household: {
      groupId,
      name: typeof groupData.name === 'string' ? groupData.name : '',
      lineGroupId: typeof groupData.lineGroupId === 'string' && groupData.lineGroupId ? groupData.lineGroupId : null,
      members: Array.from(members.values()).map((m) => ({ lineId: m.lineId, displayName: m.displayName })),
      // 指定後に脱退した人は、指定なしとして扱う
      splitCollectFrom: typeof collectFrom === 'string' && members.has(collectFrom) ? collectFrom : null,
    },
  };
}

interface FetchStatus<E> {
  key: string;
  nonce: number;
  error: E | null;
}

/**
 * 所属グループと主世帯のメンバー。読み取りは既存と同じクエリ形なので、
 * master / PR #172 のどちらのルールでも通る。
 * activeGroupIds は所属がまだ分からない（読み込み中・失敗）とき null。
 */
export function useHousehold(lineId: string | null) {
  const key = lineId && lineId !== 'guest' ? `household:${lineId}` : '';
  const [nonce, setNonce] = useState(0);
  // 取得結果の値は swrCache に置き、ここでは完了と失敗だけを持つ
  const [status, setStatus] = useState<FetchStatus<string> | null>(null);

  useEffect(() => {
    if (!key || !lineId) return;
    let cancelled = false;
    (async () => {
      try {
        const connected = await waitForFirebase();
        if (!connected) throw new Error('Firebase接続エラー');
        const value = await loadHousehold(lineId);
        if (cancelled) return;
        setCached(key, value);
        setStatus({ key, nonce, error: null });
      } catch (err) {
        if (cancelled) return;
        setStatus({ key, nonce, error: handleFirestoreError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, lineId, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  if (!key) {
    return { household: null, activeGroupIds: [] as string[], loading: false, error: null, refetch };
  }
  const info = getCached<HouseholdInfo>(key) ?? null;
  const current = status && status.key === key ? status : null;
  const done = !!current && current.nonce === nonce;
  return {
    household: info?.household ?? null,
    activeGroupIds: info ? info.activeGroupIds : null,
    loading: !done && !info,
    // 再試行中は前回の失敗を出さない（読み込み中として扱う）
    error: done ? (current?.error ?? null) : null,
    refetch,
  };
}

// ---------------------------------------------------------------------------
// 全額にする前の立替（bot の /household/legacy-advances）
// ---------------------------------------------------------------------------

/**
 * 全額で精算するようにする前の立替（advanceFull の無い advance_pending）。キャッシュを先に出して裏で取り直す
 * （コールドスタートの待ちを隠す）。API が未設定のときは取得しない（available=false。精算タブはお知らせを出さない）。
 */
export function useLegacyAdvances(groupId: string | null) {
  const available = isHouseholdApiConfigured();
  const key = groupId && available ? `advances:${groupId}` : '';
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<FetchStatus<HouseholdErrorCode> | null>(null);
  // setData で差し替えたときに描き直すためのカウンタ（値は swrCache）
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!key || !groupId) return;
    let cancelled = false;
    fetchLegacyAdvances(groupId).then(
      (value) => {
        if (cancelled) return;
        setCached(key, value);
        setStatus({ key, nonce, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setStatus({ key, nonce, error: householdErrorCode(err) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, groupId, nonce]);

  /** 最新の内容で差し替える（精算済みにしたとき・409 stale など） */
  const setData = useCallback(
    (value: AdvancesResponse) => {
      if (!key) return;
      setCached(key, value);
      setVersion((v) => v + 1);
    },
    [key]
  );
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  if (!key) {
    return { data: null, loading: false, error: null, available, setData, refetch };
  }
  const data = getCached<AdvancesResponse>(key) ?? null;
  const current = status && status.key === key ? status : null;
  const done = !!current && current.nonce === nonce;
  return {
    data,
    loading: !done && !data,
    // 再試行中は前回の失敗を出さない（読み込み中として扱う）
    error: done ? (current?.error ?? null) : null,
    available,
    setData,
    refetch,
  };
}
