/**
 * 支出の状態を変える操作の共通処理
 *
 * LINE の postback（`line/postback.ts`）と Web 向けの `/household` API（`householdApi.ts`）の
 * 両方から同じ関数を呼び、判定と書き込みの内容を 1 か所にまとめる。
 * LINE の返信や HTTP の応答はここでは扱わない。
 */

import { FieldValue, getFirestore, type DocumentData, type Transaction } from 'firebase-admin/firestore';
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
 * LINE 手入力は status 無しで保存される。Gmail 取込は shared・確認済みで保存する（以前の取込は
 * pending のまま残っており、OK を押すとここで shared に揃う）。
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

/**
 * 支払った人を変える（LINE の［自分が払った］）
 *
 * 期間の折半は支払った人（payerId）で数えるので、ここを変えれば精算に反映される。あわせて確認済みにし、
 * 未確認なら共同費へ昇格させる（ほかのボタンと同じ）。立替（advance_pending）なら立て替えた人も同じ人にする
 * （立替は「払った人が相手の分を立て替えた」なので、払った人と立て替えた人は同じ）。除外（personal）は除外のまま。
 * 立替で精算済みの支出は変えられない（支払った人は精算の記録の一部。Firestore ルールも同じ）。
 */
export function decideSetPayer(payer: { lineId: string; displayName: string }): ExpenseDecider {
  return (data) => {
    if (data.status === 'advance_settled') return { reject: SETTLED_REJECTION };
    const statusPatch = isPendingStatus(data.status) ? { status: 'shared', includeInTotal: true } : {};
    const advancePatch = data.status === 'advance_pending' ? { advanceBy: payer.lineId } : {};
    return {
      update: {
        payerId: payer.lineId,
        payerDisplayName: payer.displayName,
        ...statusPatch,
        ...advancePatch,
        confirmed: true,
        updatedAt: new Date(),
      },
      cardPatch: {
        payerId: payer.lineId,
        payerDisplayName: payer.displayName,
        ...statusPatch,
        ...advancePatch,
      },
    };
  };
}

/**
 * 立替にする（LINE の［自分が立替］）
 *
 * 押した人が払って、相手の分を立て替えた支出にする。折半はせず、支出の日付の期間の精算で全額を返してもらう
 * （advanceFull。periodSplit.ts の isFullAdvance）。支払った人も押した人にし、共同費相当（集計に入る）・確認済みにする
 * （除外かつ立替は成立しない）。立替で精算済みの支出は変えられない。
 */
export function decideSetAdvance(advancer: { lineId: string; displayName: string }): ExpenseDecider {
  return (data) => {
    if (data.status === 'advance_settled') return { reject: SETTLED_REJECTION };
    const patch = {
      status: 'advance_pending',
      advanceBy: advancer.lineId,
      advanceFull: true,
      payerId: advancer.lineId,
      payerDisplayName: advancer.displayName,
      includeInTotal: true,
    };
    return {
      update: { ...patch, confirmed: true, updatedAt: new Date() },
      cardPatch: patch,
    };
  };
}

/**
 * 立替を取り消す（共同費に戻す。LINE の［取り消す］）
 *
 * 支払った人・金額は変えない（折半で支払った人の分として数えるようになる）。立替で精算済みの支出は変えられない。
 */
export function decideClearAdvance(): ExpenseDecider {
  return (data) => {
    if (data.status === 'advance_settled') return { reject: SETTLED_REJECTION };
    if (data.status !== 'advance_pending') return { reject: '立替ではないため、変更はありません' };
    return {
      update: {
        status: 'shared',
        includeInTotal: true,
        confirmed: true,
        advanceBy: FieldValue.delete(),
        advanceFull: FieldValue.delete(),
        updatedAt: new Date(),
      },
      cardPatch: { status: 'shared', includeInTotal: true, advanceBy: undefined, advanceFull: undefined },
    };
  };
}

/**
 * 全額にする前の立替（advanceFull の無い advance_pending）を精算済みにする（Web の精算タブの［精算済みにする］）
 *
 * 精算済み（advance_settled）はどの期間の折半にも入らない。全額で返す立替（advanceFull）は、期間の精算で
 * 返すので対象にしない。
 */
export function decideSettleLegacyAdvance(now: Date = new Date()): ExpenseDecider {
  return (data) => {
    if (data.status !== 'advance_pending' || data.advanceFull === true) return { reject: 'not_legacy_advance' };
    return {
      update: { status: 'advance_settled', advanceSettledAt: now, updatedAt: now },
      cardPatch: { status: 'advance_settled' },
    };
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

    // expenseId は Web API では利用者の入力なので、ログ行を偽造されないよう JSON 文字列にして出す
    if (!snapshot.exists) {
      console.warn(`Expense not found: ${JSON.stringify(expenseId)}`);
      return null;
    }

    const data = snapshot.data();
    if (!data) {
      console.warn(`Expense data is empty: ${JSON.stringify(expenseId)}`);
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
