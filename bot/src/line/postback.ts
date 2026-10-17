/**
 * LINE Postback処理
 *
 * 登録・編集カードのボタン押下を処理する。
 *
 * カードは「現在の設定」を本文に表示するため、状態を変えたら最新値のカードを返信して
 * 表示と実データがずれないようにする（LINEは送信済みメッセージを編集できない）。
 * 返信は replyToken を使う（無料。push は月200通の上限がある）。
 */

import { webhook, messagingApi } from '@line/bot-sdk';

type PostbackEvent = webhook.PostbackEvent;
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { PostbackActionData } from '../gmail/types';
import { ExpenseStatusType } from '../firestore';
import { applyExpenseChange, decideClearAdvance, decideConfirm, decideSetPayer, SETTLED_REJECTION } from '../expenseActions';
import { fallbackDisplayName, readActiveMember } from '../householdMembers';
import { errorMessage, maskId } from '../logSafe';
import {
  buildCategorySelectCarousel,
  buildExpenseCardFromRecord,
  buildExpenseEditUrl,
  EXPENSE_LIST_URL,
  CategorySelectInfo,
} from './flexMessage';
import { getLineClient, replyWithPushFallback } from './client';

/**
 * 拡張されたPostbackアクションデータ
 */
interface ExtendedPostbackActionData extends PostbackActionData {
  source?: 'gmail' | 'text';  // 入力元
  category?: string;          // 設定するカテゴリ
  /**
   * set_split / set_advance（以前のカード）で設定する値
   *
   * カードを描画した時点の現在値の「反対」を埋め込んである。トグル（反転）ではなく
   * 絶対値を渡すことで、古いカードから押しても表示どおりの結果になる。
   */
  to?: 'shared' | 'personal' | 'on' | 'off';
}

/** 返信先（グループならグループ、そうでなければ本人） */
function getReplyTarget(event: PostbackEvent): string | undefined {
  return event.source?.type === 'group'
    ? (event.source as any).groupId
    : event.source?.userId;
}

/**
 * postbackへの返信
 *
 * replyMessage（無料）で返し、トークン期限切れ・使用済み等で失敗したときだけ
 * pushMessage にフォールバックする。
 */
async function replyToPostback(
  event: PostbackEvent,
  messages: messagingApi.Message[]
): Promise<void> {
  await replyWithPushFallback(event.replyToken, getReplyTarget(event), messages);
}

/** テキスト1通の返信 */
async function replyText(event: PostbackEvent, text: string): Promise<void> {
  await replyToPostback(event, [{ type: 'text', text }]);
}

/** 支出ドキュメントの取得（存在しない場合は null） */
async function loadExpense(expenseId: string) {
  const db = getFirestore();
  const ref = db.collection('expenses').doc(expenseId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    console.warn('Expense not found:', expenseId);
    return null;
  }

  const data = snapshot.data();
  if (!data) {
    console.warn('Expense data is empty:', expenseId);
    return null;
  }

  return { ref, data };
}

/**
 * 更新後の値でカードを組み立て直して返信する
 *
 * 押した本人のIDで一覧・修正リンクを作る。Gmail通知はグループ宛のpushで送信時点では
 * 押す人が分からないため、ここで初めて個人化できる。IDが分かったので「修正」も
 * postback を介さずWeb編集画面へ直接飛ばせる。
 *
 * なおグループでは返信もグループ全員に届くため、リンクは押した本人のIDで固定される
 * （別のメンバーが押すと、その人ではなく押した本人のIDでWebが開く）。
 */
async function replyUpdatedCard(
  event: PostbackEvent,
  expenseId: string,
  record: Record<string, any>,
  headerText: string
): Promise<void> {
  const userId = event.source!.userId;
  const editUrl = userId ? buildExpenseEditUrl(expenseId, userId) : undefined;

  const card = buildExpenseCardFromRecord(expenseId, record, {
    editUrl,
    headerText,
    headerIconKey: 'check',
  });

  await replyToPostback(event, [card]);
}

/**
 * Postbackイベントを処理
 */
export async function handlePostback(event: PostbackEvent): Promise<void> {
  try {
    const data = event.postback.data;

    // JSONパースを試行
    let actionData: ExtendedPostbackActionData;
    try {
      actionData = JSON.parse(data);
    } catch {
      console.log(`Non-JSON postback data, skipping (length=${String(data ?? '').length})`);
      return;
    }

    // 有効なPostbackかチェック
    if (!actionData.action || !actionData.expenseId) {
      console.log('Not a valid postback, skipping');
      return;
    }

    switch (actionData.action) {
      case 'set_split':
        await handleSetSplit(event, actionData, actionData.to === 'personal' ? 'personal' : 'shared');
        break;
      case 'set_payer':
        await handleSetPayer(event, actionData);
        break;
      case 'confirm':
        await handleConfirm(event, actionData);
        break;
      case 'edit':
        await handleEdit(event, actionData);
        break;
      case 'show_category_select':
        await handleShowCategorySelect(event, actionData);
        break;
      case 'set_category':
        await handleSetCategory(event, actionData);
        break;
      case 'show_list':
        await handleShowList(event);
        break;

      // 旧UIのカードから押された場合。送信済みメッセージは編集できないので、
      // 過去に配信したカードのボタンを現行の処理へ読み替える。
      case 'shared':
        await handleSetSplit(event, actionData, 'shared');
        break;
      case 'personal':
        await handleSetSplit(event, actionData, 'personal');
        break;
      // 立替の精算は期間の折半にまとめた。以前のカードの［自分が立替］は「自分が払った」として扱い、
      // ［取り消す］は立替の印を外す
      case 'set_advance':
        if (actionData.to === 'off') await handleClearAdvance(event, actionData);
        else await handleSetPayer(event, actionData);
        break;
      case 'advance':
        await handleSetPayer(event, actionData);
        break;

      default:
        console.warn('Unknown action:', actionData.action);
    }
  } catch (error) {
    console.error('Failed to handle postback:', error);
    throw error;
  }
}

/**
 * 支出区分（共同費 / 個人費）を設定
 *
 * 個人費・共同費のどちらに変えても立替は解除する。立替者が残ったままだと
 * 精算対象に残り続けてしまうため。
 */
async function handleSetSplit(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData,
  to: 'shared' | 'personal'
): Promise<void> {
  const { expenseId } = actionData;
  const includeInTotal = to === 'shared';

  const result = await applyExpenseChange(expenseId, (data) => {
    if (data.status === 'advance_settled') return { reject: SETTLED_REJECTION };

    return {
      update: {
        status: to,
        includeInTotal,
        confirmed: true,
        advanceBy: FieldValue.delete(),
        updatedAt: new Date(),
      },
      cardPatch: { status: to, includeInTotal, advanceBy: undefined },
    };
  });

  if (!result) return;
  if ('reject' in result) {
    await replyText(event, result.reject);
    return;
  }

  console.log(`Expense ${expenseId} split set to ${to}`);
  await replyUpdatedCard(event, expenseId, result.record, '設定を更新しました');
}

/** 押した人の LINE の表示名（世帯のメンバー文書に名前が無いときに使う）。取れなければ空文字 */
async function profileName(event: PostbackEvent, userId: string): Promise<string> {
  try {
    const client = getLineClient();
    const profile =
      event.source?.type === 'group'
        ? await client.getGroupMemberProfile((event.source as any).groupId, userId)
        : await client.getProfile(userId);
    return profile.displayName || '';
  } catch (error) {
    console.warn('Failed to load LINE profile for payer', { user: maskId(userId), error: errorMessage(error) });
    return '';
  }
}

/**
 * 支払った人を、押した人にする（［自分が払った］）
 *
 * 押せるのは支出の世帯の有効メンバーだけ（世帯の無い個人の支出は登録した本人）。期間の折半の金額が
 * 変わるため、グループにいるだけの人には変えさせない。表示名はメンバー文書の名前、無ければ LINE の
 * プロフィール名。
 */
async function handleSetPayer(event: PostbackEvent, actionData: ExtendedPostbackActionData): Promise<void> {
  const { expenseId } = actionData;
  const userId = event.source!.userId;
  if (!userId) {
    console.error('Cannot set payer: userId is missing', { expenseId, sourceType: event.source!.type });
    await replyText(event, '押した人を特定できなかったため、変更できませんでした');
    return;
  }

  const fromProfile = await profileName(event, userId);
  let memberName = '';
  const db = getFirestore();
  const result = await applyExpenseChange(
    expenseId,
    (data) => decideSetPayer({ lineId: userId, displayName: memberName || fromProfile || fallbackDisplayName(userId) })(data),
    {
      authorize: async (data, tx) => {
        if (typeof data.groupId === 'string' && data.groupId) {
          const member = await readActiveMember(db, data.groupId, userId, tx);
          memberName = member?.displayName ?? '';
          return member !== null;
        }
        // 世帯の無い個人の支出は本人だけ（lineGroupId だけを持つ旧形式は変えない）
        return !data.lineGroupId && data.lineId === userId;
      },
    }
  );

  if (!result) return;
  if ('forbidden' in result) {
    await replyText(event, '支払った人を変えられるのは、世帯のメンバーだけです');
    return;
  }
  if ('reject' in result) {
    await replyText(event, result.reject);
    return;
  }

  console.log('Expense payer set by the presser', { expense: maskId(expenseId), user: maskId(userId) });
  await replyUpdatedCard(event, expenseId, result.record, '支払った人を変更しました');
}

/** 立替の印を外す（以前のカードの［取り消す］） */
async function handleClearAdvance(event: PostbackEvent, actionData: ExtendedPostbackActionData): Promise<void> {
  const { expenseId } = actionData;
  const result = await applyExpenseChange(expenseId, decideClearAdvance());

  if (!result) return;
  if ('reject' in result) {
    await replyText(event, result.reject);
    return;
  }

  console.log('Expense advance mark cleared', { expense: maskId(expenseId) });
  await replyUpdatedCard(event, expenseId, result.record, '設定を更新しました');
}

/**
 * 内容を確定する
 *
 * 未確認（pending）のときだけ共同費へ昇格させる。個人費や立替を設定済みの支出に対して
 * OK を押しても、その設定を共同費へ巻き戻さない。
 */
async function handleConfirm(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId } = actionData;

  // 判定は Web の確認（/household API）と共通（expenseActions.ts）
  const result = await applyExpenseChange(expenseId, decideConfirm());

  if (!result) return;
  if ('reject' in result) {
    await replyText(event, result.reject);
    return;
  }

  console.log(`Expense ${expenseId} confirmed (status: ${result.record.status})`);
  await replyUpdatedCard(event, expenseId, result.record, '登録を確定しました');
}

/**
 * 修正用のリンクを返す
 *
 * 押した本人のIDが分かっているカードでは「修正」は URI ボタンで直接Web編集画面へ飛ぶ。
 * ここへ来るのはGmail通知のように送信時点で押す人が決まっていない場合と、
 * 配信済みの古いカードから押された場合だけ。
 */
async function handleEdit(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId } = actionData;
  const loaded = await loadExpense(expenseId);
  if (!loaded) return;

  const userId = event.source!.userId;
  if (!userId) {
    await replyText(event, 'ユーザーを特定できなかったため、修正リンクを発行できませんでした');
    return;
  }

  await replyText(
    event,
    `以下のリンクから修正できます\n${buildExpenseEditUrl(expenseId, userId)}`
  );
}

/**
 * 家計簿一覧のリンクを返す
 *
 * 新しいカードの「家計簿一覧を見る」は uri アクションで直接遷移するため、この
 * postback は届かない。トーク履歴に残る過去のカードから押された場合にのみ来る
 * ので、後方互換のために残している。
 */
async function handleShowList(event: PostbackEvent): Promise<void> {
  await replyText(event, `家計簿一覧はこちら\n${EXPENSE_LIST_URL}`);
}

/**
 * カテゴリ選択Carouselを表示
 */
async function handleShowCategorySelect(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId, source } = actionData;

  // Firestoreから支出データを取得（postbackデータの300バイト制限対策）
  const loaded = await loadExpense(expenseId);
  if (!loaded) return;

  const { data } = loaded;

  const carouselInfo: CategorySelectInfo = {
    expenseId,
    currentCategory: data.category || 'その他',
    source: source || 'gmail',
    merchant: data.description || '不明',
    amount: data.amount || 0,
  };

  await replyToPostback(event, [buildCategorySelectCarousel(carouselInfo)]);
  console.log(`Category select carousel sent for expense ${expenseId}`);
}

/**
 * カテゴリを設定
 */
async function handleSetCategory(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId, category } = actionData;

  if (!category) {
    console.warn('Category is missing in set_category action');
    return;
  }

  // 同時に支出区分などが変更されていても、返信カードが最新の状態を映すようにする
  //
  // カテゴリを選び直す操作は「この支出でよい」という確認でもあるため、set_split /
  // set_advance と同じく確認済みにする。カテゴリだけ更新して未確認のままにすると、
  // LINE手入力（includeInTotal: false で保存される）はカード上でカテゴリが直った
  // ように見えるのに合計にはずっと入らない。
  const result = await applyExpenseChange(expenseId, (data) => {
    const status = data.status as ExpenseStatusType | undefined;
    const isPending = !status || status === 'pending';

    // 未確認のときだけ共同費へ昇格させる。個人費や立替を設定済みの支出は触らない。
    return isPending
      ? {
          update: {
            category,
            confirmed: true,
            status: 'shared',
            includeInTotal: true,
            updatedAt: new Date(),
          },
          cardPatch: { category, status: 'shared', includeInTotal: true },
        }
      : {
          update: { category, confirmed: true, updatedAt: new Date() },
          cardPatch: { category },
        };
  });

  if (!result) return;
  if ('reject' in result) {
    await replyText(event, result.reject);
    return;
  }

  console.log(`Expense ${expenseId} category updated to ${category}`);

  await replyUpdatedCard(event, expenseId, result.record, '設定を更新しました');
}
