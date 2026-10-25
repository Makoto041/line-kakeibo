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
import { FieldValue, getFirestore, type DocumentData, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { PostbackActionData } from '../gmail/types';
import { toSelectableCategoryName } from '../categoryNormalization';
import { isValidDocId } from '../docId';
import {
  applyExpenseChange,
  decideClearAdvance,
  decideConfirm,
  decideSetAdvance,
  decideSetCategory,
  decideSetPayer,
  SETTLED_REJECTION,
  type ExpenseDecider,
} from '../expenseActions';
import { subCategoriesOf } from '../categoryTaxonomy';
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
  /**
   * 入力元（カテゴリ選択のカルーセルのボタンに埋め込む）
   *
   * JSON から読んだ値なので 'gmail' / 'text' とは限らない。categorySelectSource で許可リストに揃えてから使う。
   */
  source?: unknown;
  /**
   * 設定するカテゴリ（大項目。中項目は受け取らず、サーバーで決める）
   *
   * JSON から読んだ値なので文字列とは限らない。toSelectableCategoryName で確かめてから使う。
   */
  category?: unknown;
  /**
   * set_split / set_advance で設定する値
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
    console.warn('Expense not found', { expense: maskId(expenseId) });
    return null;
  }

  const data = snapshot.data();
  if (!data) {
    console.warn('Expense data is empty', { expense: maskId(expenseId) });
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

    // 有効なPostbackかチェック。支出 ID は Firestore の文書 ID として安全な文字列だけを受け付ける
    // （/household API と同じ isValidDocId。不正なら、支出が無いときと同じく何もしない。Firestore も LINE も呼ばない）
    if (!actionData || typeof actionData !== 'object' || !actionData.action || !isValidDocId(actionData.expenseId)) {
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
        // 値は利用者の入力なのでログに出さない（型だけ）
        console.warn('Unknown postback action', { type: typeof actionData.action, expense: maskId(actionData.expenseId) });
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
 * 精算対象に残り続けてしまうため。期間の精算の金額が変わるので、押せるのは世帯のメンバーだけ（applyAsMember）。
 */
async function handleSetSplit(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData,
  to: 'shared' | 'personal'
): Promise<void> {
  const { expenseId } = actionData;
  const includeInTotal = to === 'shared';

  const record = await applyAsMember(event, expenseId, () => (data) => {
    if (data.status === 'advance_settled') return { reject: SETTLED_REJECTION };

    return {
      update: {
        status: to,
        includeInTotal,
        confirmed: true,
        advanceBy: FieldValue.delete(),
        advanceFull: FieldValue.delete(),
        updatedAt: new Date(),
      },
      cardPatch: { status: to, includeInTotal, advanceBy: undefined, advanceFull: undefined },
    };
  });
  if (!record) return;

  console.log('Expense split updated', { expense: maskId(expenseId), to });
  await replyUpdatedCard(event, expenseId, record, '設定を更新しました');
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

/** 押した人の userId が無いときの返信 */
const PRESSER_UNKNOWN_TEXT = '押した人を特定できなかったため、変更できませんでした';

/** 押した人が支出を変えてよい人でないときの返信 */
const MEMBERS_ONLY_TEXT = '変更できるのは、世帯のメンバーだけです';

/**
 * 押した人が、この支出を変えてよい人か
 *
 * 支出の世帯（groupId）の有効メンバーだけ（世帯の無い個人の支出は登録した本人だけ。lineGroupId だけを持つ
 * 旧形式は誰も変えられない）。tx があればメンバー文書をトランザクション内で読む。
 *
 * @returns 変えてよければメンバー文書の表示名（個人の支出・仮名「作成者」は空文字）、だめなら null
 */
async function presserAsMember(
  db: Firestore,
  data: DocumentData,
  userId: string,
  tx?: Pick<Transaction, 'get'>
): Promise<{ displayName: string } | null> {
  if (typeof data.groupId === 'string' && data.groupId) {
    return readActiveMember(db, data.groupId, userId, tx);
  }
  return !data.lineGroupId && data.lineId === userId ? { displayName: '' } : null;
}

/**
 * 押した人として、世帯のメンバーだけに許す変更を行う
 * （支出区分・［自分が払った］［自分が立替］［取り消す］・OK・カテゴリの変更）
 *
 * 期間の精算の金額や集計が変わるため、押せるのは支出の世帯の有効メンバーだけ（presserAsMember）。
 * 表示名はメンバー文書の名前、無ければ LINE のプロフィール名。
 *
 * @returns 返信を済ませたら null、変更できたら更新後のレコード
 */
async function applyAsMember(
  event: PostbackEvent,
  expenseId: string,
  decide: (presser: { lineId: string; displayName: string }) => ExpenseDecider
): Promise<Record<string, unknown> | null> {
  const userId = event.source!.userId;
  if (!userId) {
    console.error('Cannot identify the presser: userId is missing', { expense: maskId(expenseId), sourceType: event.source!.type });
    await replyText(event, PRESSER_UNKNOWN_TEXT);
    return null;
  }

  const fromProfile = await profileName(event, userId);
  let memberName = '';
  const db = getFirestore();
  const result = await applyExpenseChange(
    expenseId,
    (data) => decide({ lineId: userId, displayName: memberName || fromProfile || fallbackDisplayName(userId) })(data),
    {
      authorize: async (data, tx) => {
        const member = await presserAsMember(db, data, userId, tx);
        memberName = member?.displayName ?? '';
        return member !== null;
      },
    }
  );

  if (!result) return null;
  if ('forbidden' in result) {
    await replyText(event, MEMBERS_ONLY_TEXT);
    return null;
  }
  if ('reject' in result) {
    await replyText(event, result.reject);
    return null;
  }
  return result.record;
}

/** 支払った人を、押した人にする（［自分が払った］） */
async function handleSetPayer(event: PostbackEvent, actionData: ExtendedPostbackActionData): Promise<void> {
  const { expenseId } = actionData;
  const record = await applyAsMember(event, expenseId, (presser) => decideSetPayer(presser));
  if (!record) return;
  console.log('Expense payer set by the presser', { expense: maskId(expenseId) });
  await replyUpdatedCard(
    event,
    expenseId,
    record,
    record.status === 'advance_pending' ? '支払った人（立替した人）を変更しました' : '支払った人を変更しました'
  );
}

/**
 * 立替にする / 取り消す（［自分が立替］［取り消す］。旧UIの advance も［自分が立替］として扱う）
 *
 * 立替は押した人が払って相手の分を立て替えた支出で、支出の日付の期間の精算で全額を返してもらう。
 */
async function handleSetAdvance(event: PostbackEvent, actionData: ExtendedPostbackActionData, on: boolean): Promise<void> {
  const { expenseId } = actionData;
  const record = await applyAsMember(event, expenseId, (presser) => (on ? decideSetAdvance(presser) : decideClearAdvance()));
  if (!record) return;
  console.log('Expense advance updated', { expense: maskId(expenseId), on });
  await replyUpdatedCard(event, expenseId, record, on ? '立替にしました（期間の精算で相手から全額を返してもらいます）' : '設定を更新しました');
}

/**
 * 内容を確定する
 *
 * 未確認（pending）のときだけ共同費へ昇格させる。個人費や立替を設定済みの支出に対して
 * OK を押しても、その設定を共同費へ巻き戻さない。未確認の支出は共同費になり精算の金額が変わるため、
 * 押せるのは世帯のメンバーだけ（applyAsMember。Web の確認と同じ）。
 */
async function handleConfirm(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId } = actionData;

  // 判定は Web の確認（/household API）と共通（expenseActions.ts）
  const record = await applyAsMember(event, expenseId, () => decideConfirm());
  if (!record) return;

  console.log('Expense confirmed', { expense: maskId(expenseId), status: record.status });
  await replyUpdatedCard(event, expenseId, record, '登録を確定しました');
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
 * カルーセルのボタンに埋め込む入力元（許可リスト。'gmail' / 'text' 以外は既定の 'gmail'）
 *
 * postback の値をそのまま埋め込むと、長い値でボタンの data が LINE の上限を超え、カルーセルを送れなくなる。
 */
function categorySelectSource(source: unknown): CategorySelectInfo['source'] {
  return source === 'gmail' || source === 'text' ? source : 'gmail';
}

/**
 * カテゴリ選択Carouselを表示
 *
 * 選んだあとの set_category でも確かめるが、支出を変えられない人（世帯のメンバーでない人）には
 * カルーセル（支出 ID 入りのボタン）も返さない。拒否の文言は applyAsMember と同じ。
 */
async function handleShowCategorySelect(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId, source } = actionData;

  const userId = event.source!.userId;
  if (!userId) {
    console.error('Cannot identify the presser: userId is missing', { expense: maskId(expenseId), sourceType: event.source!.type });
    await replyText(event, PRESSER_UNKNOWN_TEXT);
    return;
  }

  // Firestoreから支出データを取得（postbackデータの300バイト制限対策）
  const loaded = await loadExpense(expenseId);
  if (!loaded) return;

  const { data } = loaded;

  if (!(await presserAsMember(getFirestore(), data, userId))) {
    await replyText(event, MEMBERS_ONLY_TEXT);
    return;
  }

  const carouselInfo: CategorySelectInfo = {
    expenseId,
    currentCategory: data.category || 'その他',
    source: categorySelectSource(source),
    merchant: data.description || '不明',
    amount: data.amount || 0,
  };

  await replyToPostback(event, [buildCategorySelectCarousel(carouselInfo)]);
  console.log('Category select carousel sent', { expense: maskId(expenseId) });
}

/**
 * カテゴリを設定（大項目が変わるときは中項目も決め直す。decideSetCategory）
 *
 * 受け付けるのは選択肢の一覧（正準名と、カルーセルの「医療費」などの正準名に揃えられる名前）だけ
 * （toSelectableCategoryName）。押せるのは世帯のメンバーだけ（applyAsMember。未確認の支出は共同費になるため）。
 */
async function handleSetCategory(
  event: PostbackEvent,
  actionData: ExtendedPostbackActionData
): Promise<void> {
  const { expenseId } = actionData;

  const category = toSelectableCategoryName(actionData.category);
  if (category === null) {
    // 値は利用者の入力なのでログに出さない（型と長さだけ）
    const raw = actionData.category;
    console.warn('Rejected set_category: the category is not in the list', {
      expense: maskId(expenseId),
      type: typeof raw,
      length: typeof raw === 'string' ? raw.length : null,
    });
    await replyText(event, 'このカテゴリには変更できません');
    return;
  }

  // 同時に支出区分などが変更されていても、返信カードが最新の状態を映すようにする
  //
  // カテゴリを選び直す操作は「この支出でよい」という確認でもあるため、set_split /
  // set_advance と同じく確認済みにする。カテゴリだけ更新して未確認のままにすると、
  // LINE手入力（includeInTotal: false で保存される）はカード上でカテゴリが直った
  // ように見えるのに合計にはずっと入らない。
  // カルーセルの旧名（医療費・娯楽費など）は正準名に揃えて保存する（toSelectableCategoryName・decideSetCategory）。
  // 大項目が変わるときは、中項目を辞書と時刻のルールでサーバーが決め直す（決まらなければ消す）。
  // postback に中項目（subCategory）が入っていても使わない（渡すのは category だけ）。
  const record = await applyAsMember(event, expenseId, () => decideSetCategory(category));
  if (!record) return;

  // 中項目は固定の一覧の語だけを出す（大項目が同じで触らなかったとき、Web で書かれた一覧に無い値が残っていることがある）
  const sub = record.subCategory;
  const subForLog =
    typeof sub !== 'string' ? null : subCategoriesOf(String(record.category)).includes(sub) ? sub : '(not in list)';
  console.log('Expense category updated', {
    expense: maskId(expenseId),
    category: record.category,
    subCategory: subForLog,
  });

  await replyUpdatedCard(event, expenseId, record, '設定を更新しました');
}
