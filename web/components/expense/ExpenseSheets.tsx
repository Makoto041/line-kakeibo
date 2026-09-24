'use client';

// 明細のシート（詳細・編集・レシート）と、その書き込みをまとめる。ホームと明細で同じものを使う。
// ページは「今開いているシート」を 1 つの state で持ち、シートどうしは差し替える（詳細 → 編集 → 戻る）。
// 書き込みの経路:
// - 予算に含める・編集の保存・削除: クライアントから直接（useExpenses の updateExpense / deleteExpense）
// - 確認: /household の API（Admin SDK）。成功したら応答の状態を一覧に反映する
// どれも成功したら集計のキャッシュを捨てて（別の画面が古い予算残りを出さないように）onChanged を呼ぶ。
// 失敗は短い語のトーストで知らせ、画面の状態は元のまま。
import { useCallback, useMemo, useState } from 'react';
import type { Expense, HouseholdInfo } from '@/lib/hooks';
import { invalidateStatsCache } from '@/lib/hooks';
import { canClientWrite } from '@/lib/expenseState';
import { collectHistoricalUsers, type EditForm } from '@/lib/expenseEdit';
import { normalizeCategoryName } from '@/lib/categoryNormalization';
import { confirmExpense, householdErrorToast, isHouseholdApiConfigured } from '@/lib/householdApi';
import type { ToastKey } from '@/lib/uiText';
import { useToast } from '@/components/ui/Toast';
import { ExpenseDetailSheet } from './ExpenseDetailSheet';
import { ExpenseEditSheet } from './ExpenseEditSheet';
import { ReceiptSheet } from './ReceiptSheet';

export type ExpenseSheet =
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string; from?: 'detail' }
  | { kind: 'receipt'; id: string };

export function useExpenseSheet() {
  const [sheet, setSheet] = useState<ExpenseSheet | null>(null);
  const openDetail = useCallback((id: string) => setSheet({ kind: 'detail', id }), []);
  const openEdit = useCallback((id: string) => setSheet({ kind: 'edit', id }), []);
  const close = useCallback(() => setSheet(null), []);
  return { sheet, setSheet, openDetail, openEdit, close };
}

/** Firestore の書き込み失敗を短い語にする（hooks の handleFirestoreError の文言から判断） */
export function toastKeyForWriteError(error: unknown): ToastKey {
  const message = error instanceof Error ? error.message : '';
  if (/権限|permission/i.test(message)) return 'forbidden';
  if (/接続|unavailable|network/i.test(message)) return 'network';
  return 'failed';
}

/**
 * 確認（LINE の OK と同じ処理を /household 経由で）。成功したら応答の状態を一覧に反映し、
 * 集計のキャッシュを捨てる。失敗は短い語のトーストで、一覧は変えない（楽観更新はしない）。
 */
export function useConfirmExpense({
  patchLocal,
  onChanged,
}: {
  patchLocal: (id: string, patch: Partial<Expense>) => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  return useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const result = await confirmExpense(id);
        patchLocal(id, {
          ...(result.status ? { status: result.status } : {}),
          includeInTotal: result.includeInTotal,
          confirmed: result.confirmed,
          advanceBy: result.advanceBy ?? undefined,
          ...(result.category ? { category: normalizeCategoryName(result.category) } : {}),
        });
        invalidateStatsCache();
        onChanged?.();
        return true;
      } catch (error) {
        console.error('Failed to confirm expense:', error);
        toast.show(householdErrorToast(error));
        return false;
      }
    },
    [patchLocal, onChanged, toast]
  );
}

interface ExpenseSheetsProps {
  sheet: ExpenseSheet | null;
  setSheet: (sheet: ExpenseSheet | null) => void;
  /** 読み込み済みの明細（対象の検索と、支払い者の候補に使う） */
  expenses: readonly Expense[];
  /** 一覧にまだ無いときに使う対象（LINE の「修正」リンクで先に読んだ支出など） */
  fallback?: Expense | null;
  me: string | null;
  /** ゲスト（サンプル）: 表示だけで書き込まない */
  isGuest: boolean;
  household: HouseholdInfo['household'];
  /** 有効に所属しているグループ（null は読み込み中＝許可扱い。最終判断はルール） */
  activeGroupIds: readonly string[] | null;
  updateExpense: (id: string, updates: Partial<Expense>) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;
  patchLocal: (id: string, patch: Partial<Expense>) => void;
  /** 一覧を取り直す（削除に失敗したとき。実際には消えていた場合も一覧が正しくなる） */
  refetch?: () => void;
  /** 書き込みに成功したあと（ホームの集計を取り直すなど） */
  onChanged?: () => void;
}

export function ExpenseSheets({
  sheet,
  setSheet,
  expenses,
  fallback = null,
  me,
  isGuest,
  household,
  activeGroupIds,
  updateExpense,
  deleteExpense,
  patchLocal,
  refetch,
  onChanged,
}: ExpenseSheetsProps) {
  const toast = useToast();
  const historicalUsers = useMemo(() => collectHistoricalUsers(expenses), [expenses]);
  const target = sheet
    ? (expenses.find((e) => e.id === sheet.id) ?? (fallback && fallback.id === sheet.id ? fallback : null))
    : null;
  const close = () => setSheet(null);
  const apiAvailable = isHouseholdApiConfigured();

  const afterWrite = () => {
    invalidateStatsCache();
    onChanged?.();
  };

  const toggleInclude = async (next: boolean): Promise<boolean> => {
    if (!target || isGuest) return false;
    try {
      await updateExpense(target.id, { includeInTotal: next });
      afterWrite();
      return true;
    } catch (error) {
      console.error('Failed to toggle includeInTotal:', error);
      toast.show(toastKeyForWriteError(error));
      return false;
    }
  };

  const confirmTarget = useConfirmExpense({ patchLocal, onChanged });
  const confirm = async (): Promise<boolean> => {
    if (!target || isGuest) return false;
    return confirmTarget(target.id);
  };

  const save = async (update: Partial<EditForm>): Promise<boolean> => {
    if (!target || isGuest) return false;
    try {
      await updateExpense(target.id, update);
      afterWrite();
      // 詳細から来たときは詳細へ戻る（保存した内容をそのまま確かめられる）
      setSheet(sheet?.kind === 'edit' && sheet.from === 'detail' ? { kind: 'detail', id: target.id } : null);
      return true;
    } catch (error) {
      console.error('Failed to save expense:', error);
      toast.show(toastKeyForWriteError(error));
      return false;
    }
  };

  const remove = async (): Promise<boolean> => {
    if (!target || isGuest) return false;
    try {
      await deleteExpense(target.id);
      setSheet(null);
      afterWrite();
      return true;
    } catch (error) {
      console.error('Failed to delete expense:', error);
      toast.show(toastKeyForWriteError(error));
      // 通信の再送で「消えた後の 2 回目」が拒否されることがある。一覧を取り直し、
      // 本当に消えていたらシートは自動で閉じる（対象が一覧から無くなるため）
      refetch?.();
      return false;
    }
  };

  // 対象が一覧から無くなったら（削除済みなど）シートは閉じる
  const detailTarget = sheet?.kind === 'detail' ? target : null;
  const editTarget = sheet?.kind === 'edit' ? target : null;
  const receiptTarget = sheet?.kind === 'receipt' ? target : null;

  return (
    <>
      <ExpenseDetailSheet
        open={!!detailTarget}
        onClose={close}
        expense={detailTarget}
        me={me}
        activeGroupIds={activeGroupIds}
        household={household}
        historicalUsers={historicalUsers}
        readOnly={isGuest}
        apiAvailable={apiAvailable}
        onToggleInclude={toggleInclude}
        onConfirm={confirm}
        onEdit={() => target && setSheet({ kind: 'edit', id: target.id, from: 'detail' })}
        onDelete={remove}
        onOpenReceipt={() => target && setSheet({ kind: 'receipt', id: target.id })}
      />
      <ExpenseEditSheet
        open={!!editTarget}
        onClose={close}
        onBack={
          sheet?.kind === 'edit' && sheet.from === 'detail' ? () => setSheet({ kind: 'detail', id: sheet.id }) : undefined
        }
        expense={editTarget}
        expenses={expenses}
        canWrite={!isGuest && !!editTarget && canClientWrite(editTarget, me, activeGroupIds)}
        onSave={save}
      />
      <ReceiptSheet
        open={!!receiptTarget}
        onClose={close}
        onBack={receiptTarget ? () => setSheet({ kind: 'detail', id: receiptTarget.id }) : undefined}
        expense={receiptTarget}
        readOnly={isGuest}
      />
    </>
  );
}
