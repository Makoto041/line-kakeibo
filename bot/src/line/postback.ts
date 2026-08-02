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

type WebhookEvent = webhook.Event;
type PostbackEvent = webhook.PostbackEvent;
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { PostbackActionData } from '../gmail/types';
import { ExpenseStatusType } from '../firestore';
import {
  buildCategorySelectCarousel,
  buildExpenseCardFromRecord,
  buildExpenseListUrl,
  CategorySelectInfo,
  WEB_APP_BASE,
} from './flexMessage';

/**
 * 拡張されたPostbackアクションデータ
 */
interface ExtendedPostbackActionData extends PostbackActionData {
  source?: 'gmail' | 'text';  // 入力元
  category?: string;          // 設定するカテゴリ
  /**
   * set_split / set_advance で設定する値
   *
   * カードを描画した時点の現在値の「反対」を埋め込んである。トグル（反転）ではなく
   * 絶対値を渡すことで、古いカードから押しても表示どおりの結果になる。
   */
  to?: 'shared' | 'personal' | 'on' | 'off';
}

// LINEクライアントの初期化
let lineClient: messagingApi.MessagingApiClient | null = null;

function getLineClient(): messagingApi.MessagingApiClient {
  if (!lineClient) {
    const channelAccessToken = process.env.LINE_CHANNEL_TOKEN;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    if (!channelAccessToken || !channelSecret) {
      throw new Error('LINE credentials not configured');
    }

    lineClient = new messagingApi.MessagingApiClient({
      channelAccessToken,
    });
  }
  return lineClient;
}

/** 返信先（グループならグループ、そうでなければ本人） */
function getReplyTarget(event: PostbackEvent): string | undefined {
  return event.source!.type === 'group'
    ? (event.source as any).groupId
    : event.source!.userId;
}

/** グループから押された場合のグループID */
function getGroupId(event: PostbackEvent): string | undefined {
  return event.source!.type === 'group' ? (event.source as any).groupId : undefined;
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
  const client = getLineClient();

  if (event.replyToken) {
    try {
      await client.replyMessage({ replyToken: event.replyToken, messages });
      return;
    } catch (replyError) {
      console.warn(
        'replyMessage failed (token expired or already used), falling back to pushMessage:',
        replyError
      );
    }
  }

  const target = getReplyTarget(event);
  if (!target) {
    console.warn('Cannot determine push target for postback reply');
    return;
  }
  await client.pushMessage({ to: target, messages });
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
 * 押した本人のIDで一覧リンクを作る。Gmail通知はグループ宛のpushで送信時点では
 * 押す人が分からないため、ここで初めて個人化できる。
 */
async function replyUpdatedCard(
  event: PostbackEvent,
  expenseId: string,
  record: Record<string, any>,
  headerText: string
): Promise<void> {
  const userId = event.source!.userId;
  const listUrl = userId ? buildExpenseListUrl(userId, getGroupId(event)) : undefined;

  const card = buildExpenseCardFromRecord(expenseId, record, {
    listUrl,
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
      console.log('Non-JSON postback data, skipping:', data);
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
      case 'set_advance':
        await handleSetAdvance(event, actionData, actionData.to !== 'off');
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
      case 'advance':
        await handleSetAdvance(event, actionData, true);
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
 * 精算済みの支出は変更を受け付けない
 *
 * 古いカードには [変更] ボタンが残っているため、表示を消すだけでは足りずサーバー側で弾く。
 */
async function rejectIfSettled(
  event: PostbackEvent,
  status: ExpenseStatusType | undefined
): Promise<boolean> {
  if (status !== 'advance_settled') return false;
  await replyText(event, '精算済みのため変更できません');
  return true;
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
  const loaded = await loadExpense(expenseId);
  if (!loaded) return;

  const { ref, data } = loaded;
  if (await rejectIfSettled(event, data.status)) return;

  const includeInTotal = to === 'shared';

  await ref.update({
    status: to,
    includeInTotal,
    confirmed: true,
    advanceBy: FieldValue.delete(),
    updatedAt: new Date(),
  });

  console.log(`Expense ${expenseId} split set to ${to}`);

  await replyUpdatedCard(
    event,
    expenseId,
    { ...data, status: to, includeInTotal, advanceBy: undefined },
    '設定を更新しました'
  );
}

/**
 * 立替（あり / なし）を設定
 *
 * 立替ありにする場合は支出区分を共同費相当に揃える（個人費かつ立替ありは成立しない）。
 */
async function handleSetAdvance(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData,
  on: boolean
): Promise<void> {
  const { expenseId } = actionData;
  const loaded = await loadExpense(expenseId);
  if (!loaded) return;

  const { ref, data } = loaded;
  if (await rejectIfSettled(event, data.status)) return;

  if (on) {
    // ボタンを押したユーザーを立替者として記録する
    const userId = event.source!.userId;
    if (!userId) {
      console.error('Cannot process advance: userId is missing', {
        expenseId,
        sourceType: event.source!.type,
      });
      await replyText(event, '立替者を特定できなかったため、変更できませんでした');
      return;
    }

    await ref.update({
      status: 'advance_pending',
      advanceBy: userId,
      includeInTotal: true,
      confirmed: true,
      updatedAt: new Date(),
    });

    console.log(`Expense ${expenseId} advance set to on`);

    await replyUpdatedCard(
      event,
      expenseId,
      { ...data, status: 'advance_pending', includeInTotal: true, advanceBy: userId },
      '設定を更新しました'
    );
    return;
  }

  await ref.update({
    status: 'shared',
    advanceBy: FieldValue.delete(),
    includeInTotal: true,
    confirmed: true,
    updatedAt: new Date(),
  });

  console.log(`Expense ${expenseId} advance set to off`);

  await replyUpdatedCard(
    event,
    expenseId,
    { ...data, status: 'shared', includeInTotal: true, advanceBy: undefined },
    '設定を更新しました'
  );
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
  const loaded = await loadExpense(expenseId);
  if (!loaded) return;

  const { ref, data } = loaded;
  const status = data.status as ExpenseStatusType | undefined;
  const isPending = !status || status === 'pending';

  const update: Record<string, any> = isPending
    ? { confirmed: true, status: 'shared', includeInTotal: true, updatedAt: new Date() }
    : { confirmed: true, updatedAt: new Date() };

  await ref.update(update);

  console.log(`Expense ${expenseId} confirmed (status: ${update.status ?? status})`);

  await replyUpdatedCard(event, expenseId, { ...data, ...update }, '登録を確定しました');
}

/**
 * 修正用のリンクを返す
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

  await loaded.ref.update({
    needsEdit: true,
    updatedAt: new Date(),
  });

  const editUrl = `${WEB_APP_BASE}/expenses?edit=${encodeURIComponent(
    expenseId
  )}&lineId=${encodeURIComponent(userId)}`;

  await replyText(event, `以下のリンクから修正できます\n${editUrl}`);
}

/**
 * 家計簿一覧のリンクを返す
 *
 * Web側は lineId クエリで対象ユーザーを判定するため、押した本人のIDで組み立てる。
 */
async function handleShowList(event: PostbackEvent): Promise<void> {
  const userId = event.source!.userId;
  if (!userId) {
    await replyText(event, 'ユーザーを特定できなかったため、家計簿一覧を開けませんでした');
    return;
  }

  const url = buildExpenseListUrl(userId, getGroupId(event));
  await replyText(event, `家計簿一覧はこちら\n${url}`);
}

/**
 * Postbackイベントかどうかチェック
 */
export function isPostbackEvent(event: WebhookEvent): event is PostbackEvent {
  return event.type === 'postback';
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

  const loaded = await loadExpense(expenseId);
  if (!loaded) return;

  const { ref, data } = loaded;

  await ref.update({
    category,
    updatedAt: new Date(),
  });

  console.log(`Expense ${expenseId} category updated to ${category}`);

  await replyUpdatedCard(event, expenseId, { ...data, category }, '設定を更新しました');
}
