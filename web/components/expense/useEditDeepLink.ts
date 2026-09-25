'use client';

// LINE の「修正」リンク（/expenses?edit=<id>&lineId=<uid>）で編集シートを自動で開く。
// 刷新前と同じ順序（支出を読む → その日付の期間へ移る → 一覧を取る → 編集を開く）を、
// 認証が確定してから行う（初めて開いたとき、匿名セッションの復元中に読んで権限エラーになるのを防ぐ）。
// - lineId が得られるまで待つ。ゲストで確定したら何もしない（開いた扱いにもしない）
// - 期間の設定を読み終えてから支出を読み、その日付を共通の期間に入れる
// - 期間が決まるまで一覧の取得を止める（shouldFetch。二重取得を防ぐ）
// - 開くのは 1 回だけ（閉じたあとは開き直さない）。URL の lineId は読まない
// - 読むのに失敗した（通信の一時的な失敗など）ときは、一覧を読み終えた時点で一覧から探して開く
import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { doc, getDoc } from 'firebase/firestore';
import { db, ensureFirebaseInitialized } from '@/lib/firebase';
import type { Expense, FirestoreExpenseData } from '@/lib/hooks';
import { normalizeCategoryName } from '@/lib/categoryNormalization';
import { isValidDocId } from '@/lib/householdContract';

interface EditDeepLinkOptions {
  lineId: string | null;
  /** 認証の確定（useLineAuth().settled） */
  settled: boolean;
  /** 期間の設定を読み終えた（usePeriod().settingsLoaded） */
  settingsLoaded: boolean;
  setCurrentDate: (date: dayjs.Dayjs) => void;
  /** 対象の支出を読めたときに 1 回だけ呼ぶ（編集シートを開く） */
  onOpen: (expense: Expense) => void;
}

export function useEditDeepLink(editId: string | null, options: EditDeepLinkOptions) {
  const { lineId, settled, settingsLoaded, setCurrentDate } = options;
  const onOpenRef = useRef(options.onOpen);
  useEffect(() => {
    onOpenRef.current = options.onOpen;
  });

  // 読み終えた ID（読み終えたら同じ ID では二度と開かない）
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  // 読むのに失敗した ID（一覧から探す）
  const [fallbackId, setFallbackId] = useState<string | null>(null);

  useEffect(() => {
    if (!editId || resolvedId === editId || !settled || !settingsLoaded || !lineId) return;
    // 読み終える前に条件が変わったら、この回の結果は捨てて次の回で読み直す
    let cancelled = false;

    (async () => {
      let target: Expense | null = null;
      let failed = false;
      try {
        ensureFirebaseInitialized();
        // ID として使えない値は読まない（対象なしとして扱う）
        if (db && isValidDocId(editId)) {
          const snap = await getDoc(doc(db, 'expenses', editId));
          if (snap.exists()) {
            const data = snap.data() as FirestoreExpenseData;
            target = { ...data, id: snap.id, category: normalizeCategoryName(data.category) } as Expense;
          }
        }
      } catch (err) {
        console.error('Failed to fetch edit expense:', err);
        failed = true;
      }
      if (cancelled) return;
      // 期間の移動・取得の再開・シートを開く、を同じ描画にまとめる
      if (target?.date) setCurrentDate(dayjs(target.date));
      setResolvedId(editId);
      if (failed) setFallbackId(editId);
      if (target) onOpenRef.current(target);
    })();

    return () => {
      cancelled = true;
    };
  }, [editId, resolvedId, settled, settingsLoaded, lineId, setCurrentDate]);

  const guestSettled = settled && !lineId;
  const resolved = !!editId && resolvedId === editId;
  return {
    /** 一覧を取得してよいか（?edit= のときは対象の期間が決まるまで待つ） */
    shouldFetch: !editId || resolved || guestSettled,
    /** 対象を読んでいる途中 */
    resolving: !!editId && !resolved && !guestSettled,
    /** 直接読めなかった対象の ID（一覧を読み終えたら一覧から探して開く） */
    fallbackId: editId && fallbackId === editId ? editId : null,
  };
}
