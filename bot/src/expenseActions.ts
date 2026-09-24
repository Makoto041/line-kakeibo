/**
 * 支出の状態を変える操作の共通処理
 *
 * LINE の postback（`line/postback.ts`）と Web 向けの `/household` API（`householdApi.ts`）の
 * 両方から同じ関数を呼び、判定と書き込みの内容を 1 か所にまとめる。
 * LINE の返信や HTTP の応答はここでは扱わない。
 */

import { getFirestore, type DocumentData, type Transaction } from 'firebase-admin/firestore';
import type { ExpenseStatusType } from './firestore';

/**
 * 最新のドキュメントを見て、更新内容か拒否理由を決める
 *
 * `update` は Firestore へ書き込む内容、`cardPatch` は返信カードを組み立てるための
 * 素の値（`FieldValue.delete()` のような番兵をカード側へ持ち込まないため分けている）。
 */
export type ExpenseDecision =
  | { update: Record<string, any>; cardPatch: Record<string, any> }
  | { reject: string };

/** 判定関数（トランザクション内で読んだ最新のドキュメントを受け取る） */
export type ExpenseDecider = (data: DocumentData) => ExpenseDecision;

/**
 * 書き込みを許可するかの判定（トランザクション内で呼ぶ）
 *
 * 追加の読み取りが必要なら `tx.get` を使う（Firestore のトランザクションは読み取りを書き込みより
 * 前に済ませる必要があるため、`applyExpenseChange` は判定より前にこれを呼ぶ）。
 */
export type ExpenseAuthorizer = (data: DocumentData, tx: Transaction) => Promise<boolean>;

/**
 * 精算済みの支出は支出区分・立替を変更できない
 *
 * 古いカードには [変更] ボタンが残っているため、表示を消すだけでは足りずサーバー側で弾く。
 * 判定は必ずトランザクション内で行う（判定後に精算されるのを防ぐため）。
 */
export const SETTLED_REJECTION = '精算済みのため変更できません';

/**
 * 未確認の支出か（status が無い、または pending）
 *
 * LINE 手入力は status 無し、Gmail 取込は pending で保存される。
 */
export function isPendingStatus(status: unknown): boolean {
  const s = status as ExpenseStatusType | undefined | null;
  return !s || s === 'pending';
}

/**
 * 内容を確定する（LINE の OK ボタンと同じ判定）
 *
 * 未確認（status 無し / pending）のときだけ共同費へ昇格させる。個人費や立替を設定済みの
 * 支出に対して OK を押しても、その設定を共同費へ巻き戻さない（精算済みも拒否せず確認済みにするだけ）。
 */
export function decideConfirm(): ExpenseDecider {
  return (data) =>
    isPendingStatus(data.status)
      ? {
          update: { confirmed: true, status: 'shared', includeInTotal: true, updatedAt: new Date() },
          cardPatch: { status: 'shared', includeInTotal: true },
        }
      : {
          update: { confirmed: true, updatedAt: new Date() },
          cardPatch: {},
        };
}

/** `applyExpenseChange` の結果（支出が見つからなければ null） */
export type ExpenseChangeResult = { record: Record<string, any> } | { reject: string } | null;

/**
 * 支出の 読み取り → 判定 → 更新 を1つのトランザクションで行う
 *
 * グループトークでは複数人が同時にボタンを押せる。読み取りと書き込みが別トランザクションだと、
 * 他の人の変更を古い値のまま上書きしてしまう（例: 誰かが個人費にした直後に別の人の OK が
 * 共同費へ巻き戻す、精算済み判定をすり抜けて変更が通る）。
 *
 * `authorize` を渡すと、支出を読んだ直後・判定の前に呼び、false なら何も書かずに
 * `{ forbidden: true }` を返す（LINE の postback は渡さないので挙動は従来どおり）。
 *
 * @returns 更新後のレコード / 拒否理由 / 権限なし / 支出が見つからなければ null
 */
export function applyExpenseChange(
  expenseId: string,
  decide: ExpenseDecider
): Promise<ExpenseChangeResult>;
export function applyExpenseChange(
  expenseId: string,
  decide: ExpenseDecider,
  opts: { authorize: ExpenseAuthorizer }
): Promise<ExpenseChangeResult | { forbidden: true }>;
export async function applyExpenseChange(
  expenseId: string,
  decide: ExpenseDecider,
  opts: { authorize?: ExpenseAuthorizer } = {}
): Promise<ExpenseChangeResult | { forbidden: true }> {
  const db = getFirestore();
  const ref = db.collection('expenses').doc(expenseId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      console.warn('Expense not found:', expenseId);
      return null;
    }

    const data = snapshot.data();
    if (!data) {
      console.warn('Expense data is empty:', expenseId);
      return null;
    }

    if (opts.authorize && !(await opts.authorize(data, transaction))) {
      return { forbidden: true as const };
    }

    const decision = decide(data);
    if ('reject' in decision) return decision;

    transaction.update(ref, decision.update);

    return { record: { ...data, ...decision.cardPatch } };
  });
}
