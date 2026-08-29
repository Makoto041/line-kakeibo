/**
 * LINE Flex Message生成
 *
 * カード利用通知用のリッチなメッセージを生成
 */

import { messagingApi } from '@line/bot-sdk';
import { ExpenseStatusType } from '../firestore';
import { getPaymentMethodLabel, PaymentMethod } from '../textParser';

type FlexMessage = messagingApi.FlexMessage;
type FlexBubble = messagingApi.FlexBubble;
type FlexComponent = messagingApi.FlexComponent;

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

// ============================================
// アイコン（lucide風の静的PNGをWebから配信）
// ============================================

/** アイコンPNGの配信ベースURL（web/public/icons/*.png）。HTTPSのみLINEで表示可。 */
const ICON_BASE = 'https://line-kakeibo.vercel.app/icons';

/** アイコンキー → 配信URL */
export function iconUrl(key: string): string {
  return `${ICON_BASE}/${key}.png`;
}

/**
 * カテゴリ名 → アイコンキー
 * 正規化名・旧表記（〜費）の揺れを吸収する。未知カテゴリは cat-other。
 */
const CATEGORY_ICON_KEY: Record<string, string> = {
  食費: 'cat-food',
  交通費: 'cat-transport',
  日用品: 'cat-daily',
  日用品費: 'cat-daily',
  娯楽: 'cat-fun',
  娯楽費: 'cat-fun',
  趣味: 'cat-fun',
  衣服: 'cat-clothes',
  衣服費: 'cat-clothes',
  被服費: 'cat-clothes',
  '医療・健康': 'cat-health',
  医療: 'cat-health',
  医療費: 'cat-health',
  健康: 'cat-health',
  教育: 'cat-education',
  教育費: 'cat-education',
  光熱費: 'cat-utility',
  水道光熱費: 'cat-utility',
  住居費: 'cat-housing',
  家賃: 'cat-housing',
  保険: 'cat-insurance',
  保険料: 'cat-insurance',
  税金: 'cat-tax',
  美容: 'cat-beauty',
  美容費: 'cat-beauty',
  通信費: 'cat-comm',
  サブスク: 'cat-subscription',
  サブスクリプション: 'cat-subscription',
  プレゼント: 'cat-gift',
  ギフト: 'cat-gift',
  旅行: 'cat-travel',
  ペット: 'cat-pet',
  貯金: 'cat-savings',
  貯蓄: 'cat-savings',
  投資: 'cat-savings',
  交際費: 'cat-fun',
  その他: 'cat-other',
};

/** カテゴリ名からアイコンURLを取得（未知カテゴリはその他アイコン） */
export function categoryIconUrl(categoryName: string): string {
  const key = CATEGORY_ICON_KEY[categoryName?.trim()] ?? 'cat-other';
  return iconUrl(key);
}

/**
 * アイコン付きのボタン（LINEの button はアイコンを内包できないため box で代替）。
 * variant: 'primary'（emerald強調）/ 'secondary'（ニュートラル）/ 'muted'（無効風）
 */
function iconActionButton(opts: {
  iconKey?: string;
  iconImageUrl?: string;
  label: string;
  action: Record<string, unknown>;
  variant?: 'primary' | 'secondary' | 'muted';
  flex?: number;
}): FlexComponent {
  const variant = opts.variant ?? 'secondary';
  const palette =
    variant === 'primary'
      ? { bg: '#D1FAE5', text: '#065F46' }
      : variant === 'muted'
      ? { bg: '#E2E8F0', text: '#64748B' }
      : { bg: '#F1F5F9', text: '#334155' };
  const url = opts.iconImageUrl ?? iconUrl(opts.iconKey || 'check');
  const button = {
    type: 'box',
    layout: 'horizontal',
    action: opts.action,
    backgroundColor: palette.bg,
    cornerRadius: '8px',
    paddingAll: 'md',
    spacing: 'sm',
    justifyContent: 'center',
    alignItems: 'center',
    ...(opts.flex !== undefined ? { flex: opts.flex } : {}),
    contents: [
      { type: 'image', url, size: '18px', flex: 0 },
      {
        type: 'text',
        text: opts.label,
        size: 'sm',
        weight: 'bold',
        color: palette.text,
        flex: 0,
        margin: 'sm',
        gravity: 'center',
        align: 'center',
      },
    ],
  };
  return button as unknown as FlexComponent;
}

// ============================================
// 現在の設定（リッチテキスト表示）と [変更] ボタン
// ============================================

/** Webアプリのベースドメイン */
export const WEB_APP_BASE = 'https://line-kakeibo.vercel.app';

/**
 * 「家計簿一覧を見る」の遷移先（支出一覧ページ）。
 *
 * LIFF ログイン導入前は、web が URL の lineId クエリで本人を判定していたため
 * 「押した人ごとに異なるURL」を組み立てる必要があり、押下者が不明な push では
 * postback で往復してURLを返していた。現在は web が検証済みの Firebase
 * カスタムクレームで本人を判定するため、一覧の入口は全員共通の固定URLでよい。
 */
export const EXPENSE_LIST_URL = `${WEB_APP_BASE}/expenses`;

/** 登録・編集カードの入力元 */
export type ExpenseCardSource = 'gmail' | 'text';

/** 「現在の設定」に出す表示値と、[変更] で設定する値 */
export interface DerivedExpenseSettings {
  /** 支出区分の現在値 */
  splitLabel: string;
  /** 支出区分の行頭に置くアイコン（共同費は複数人、個人費・未設定は単体） */
  splitIconKey: 'users' | 'user';
  /** 支出区分の [変更] で設定する値 */
  nextSplit: 'shared' | 'personal';
  /** 立替の現在値 */
  advanceLabel: string;
  /** 立替の [変更] で設定する値 */
  nextAdvance: 'on' | 'off';
  /** 精算済みで変更を受け付けない状態か */
  settled: boolean;
}

/**
 * status から「支出区分」と「立替」の現在値を導出する
 *
 * 支出区分と立替は単一の status フィールドに排他的に格納されているため、
 * 表示上の2行はここで導出する。status が pending のときだけ、実際の集計挙動
 * （includeInTotal）に合わせて表示を分ける。Gmail自動取得は includeInTotal: true
 * （集計に入る）、LINE手入力は false（入らない）で作られ、意味が異なるため。
 */
export function deriveExpenseSettings(
  status?: ExpenseStatusType,
  includeInTotal?: boolean
): DerivedExpenseSettings {
  switch (status) {
    case 'shared':
      return { splitLabel: '共同費', splitIconKey: 'users', nextSplit: 'personal', advanceLabel: 'なし', nextAdvance: 'on', settled: false };
    case 'personal':
      return { splitLabel: '個人費', splitIconKey: 'user', nextSplit: 'shared', advanceLabel: 'なし', nextAdvance: 'on', settled: false };
    case 'advance_pending':
      return { splitLabel: '共同費', splitIconKey: 'users', nextSplit: 'personal', advanceLabel: 'あり（精算待ち）', nextAdvance: 'off', settled: false };
    case 'advance_settled':
      return { splitLabel: '共同費', splitIconKey: 'users', nextSplit: 'personal', advanceLabel: '精算済み', nextAdvance: 'off', settled: true };
    default:
      // pending / 未設定
      return includeInTotal === false
        ? { splitLabel: '未設定', splitIconKey: 'user', nextSplit: 'shared', advanceLabel: 'なし', nextAdvance: 'on', settled: false }
        : { splitLabel: '共同費（未確認）', splitIconKey: 'users', nextSplit: 'personal', advanceLabel: 'なし', nextAdvance: 'on', settled: false };
  }
}

/** 日付を M/D 表記に揃える（Firestore は YYYY-MM-DD 保存） */
export function formatCardDate(date?: string): string {
  if (!date) return '';
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
  return matched ? `${Number(matched[2])}/${Number(matched[3])}` : date;
}

/**
 * 現在値の行末に置く、変更操作だと分かるボタン
 *
 * 余白と文字を最小指定にすると高さが文字とほぼ同じになり、指で狙いにくい。
 * 隣の行を誤って触らない程度の押し代を持たせる。
 */
function changeButton(action: Record<string, unknown>): FlexComponent {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    action,
    backgroundColor: '#EFF6FF',
    cornerRadius: '8px',
    paddingAll: 'lg',
    paddingStart: 'xl',
    paddingEnd: 'xl',
    contents: [
      {
        type: 'text',
        text: '変更',
        size: 'sm',
        weight: 'bold',
        color: '#2563EB',
        align: 'center',
      },
    ],
  } as unknown as FlexComponent;
}

/**
 * 行頭のアイコン、「ラベル：値」の現在値、右端の [変更] ボタンを1行に並べる
 *
 * アイコンは値を一目で判別するための手がかり。ボタン化されていた頃と同じ絵柄を使い、
 * 表示だけになっても見た目の手がかりが減らないようにする。
 * action を渡さない場合は現在値だけを表示する（変更できない状態）
 */
function settingRow(opts: {
  iconUrl: string;
  label: string;
  value: string;
  action?: Record<string, unknown>;
}): FlexComponent {
  return {
    type: 'box',
    layout: 'horizontal',
    alignItems: 'center',
    margin: 'md',
    contents: [
      { type: 'image', url: opts.iconUrl, size: '20px', flex: 0 },
      {
        type: 'text',
        flex: 1,
        size: 'sm',
        wrap: true,
        gravity: 'center',
        margin: 'md',
        contents: [
          { type: 'span', text: `${opts.label}：`, color: '#64748B' },
          { type: 'span', text: opts.value, color: '#0F172A', weight: 'bold' },
        ],
      },
      ...(opts.action ? [changeButton(opts.action)] : []),
    ],
  } as unknown as FlexComponent;
}

/**
 * 「現在の設定」セクション（支出区分・立替・カテゴリ）
 *
 * 現在値はリッチテキストで示し、ボタンは変更操作だけを担う。登録・編集カードで
 * 共通に使うことで、同じUIを使う画面全体で表現を揃える。
 */
function buildCurrentSettingsSection(opts: {
  expenseId: string;
  source: ExpenseCardSource;
  category: string;
  status?: ExpenseStatusType;
  includeInTotal?: boolean;
}): FlexComponent {
  const { expenseId, source, category, status, includeInTotal } = opts;
  const derived = deriveExpenseSettings(status, includeInTotal);

  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    contents: [
      { type: 'separator' },
      {
        type: 'text',
        text: '現在の設定',
        size: 'xs',
        color: '#64748B',
        margin: 'lg',
      },
      settingRow({
        iconUrl: iconUrl(derived.splitIconKey),
        label: '支出区分',
        value: derived.splitLabel,
        action: derived.settled
          ? undefined
          : {
              type: 'postback',
              label: '支出区分を変更',
              data: JSON.stringify({
                action: 'set_split',
                expenseId,
                to: derived.nextSplit,
                source,
              }),
            },
      }),
      settingRow({
        iconUrl: iconUrl('wallet'),
        label: '立替',
        value: derived.advanceLabel,
        action: derived.settled
          ? undefined
          : {
              type: 'postback',
              label: '立替を変更',
              data: JSON.stringify({
                action: 'set_advance',
                expenseId,
                to: derived.nextAdvance,
                source,
              }),
            },
      }),
      settingRow({
        iconUrl: categoryIconUrl(category),
        label: 'カテゴリ',
        value: category,
        action: {
          type: 'postback',
          label: 'カテゴリを変更',
          data: JSON.stringify({
            action: 'show_category_select',
            expenseId,
            source,
          }),
        },
      }),
    ],
  } as unknown as FlexComponent;
}

/**
 * 登録・編集カードの共通ビルダー
 *
 * カード利用通知（Gmail）とテキスト入力登録で共通の骨格を使い、
 * ヘッダー文言と金額下の補足行だけをフローごとに差し替える。
 */
function buildExpenseCard(opts: {
  expenseId: string;
  headerIconKey: string;
  headerText: string;
  title: string;
  amount: number;
  date: string;
  category: string;
  source: ExpenseCardSource;
  status?: ExpenseStatusType;
  includeInTotal?: boolean;
  /** 金額行の下に差し込むフロー固有の行（残り予算・支払い方法など） */
  detailRows?: FlexComponent[];
  /** 「修正」の遷移先。未指定なら押下者のIDで解決する postback にする。 */
  editUrl?: string;
}): FlexMessage {
  const {
    expenseId,
    headerIconKey,
    headerText,
    title,
    amount,
    date,
    category,
    source,
    status,
    includeInTotal,
    detailRows = [],
    editUrl,
  } = opts;

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'icon',
          url: iconUrl(headerIconKey),
          size: 'md',
        },
        {
          type: 'text',
          text: headerText,
          weight: 'bold',
          size: 'md',
          color: '#10B981',
          margin: 'sm',
        },
      ],
      paddingAll: 'lg',
      backgroundColor: '#ECFDF5',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        // 店舗名・説明
        {
          type: 'text',
          text: title,
          weight: 'bold',
          size: 'lg',
          wrap: true,
        },
        // 金額と日付
        {
          type: 'box',
          layout: 'baseline',
          margin: 'sm',
          contents: [
            {
              type: 'text',
              text: `¥${amount.toLocaleString()}`,
              weight: 'bold',
              size: 'xl',
              color: '#0F172A',
              flex: 1,
            },
            {
              type: 'text',
              text: formatCardDate(date),
              size: 'sm',
              color: '#64748B',
              align: 'end',
              flex: 0,
            },
          ],
        },
        ...detailRows,
        // 現在の設定（値の表示と [変更] 操作を分離）
        buildCurrentSettingsSection({ expenseId, source, category, status, includeInTotal }),
      ],
      paddingAll: 'lg',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        // 1段目: この内容で確定 / 修正
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            iconActionButton({
              iconKey: 'check',
              label: 'OK',
              variant: 'primary',
              flex: 1,
              action: {
                type: 'postback',
                label: 'OK',
                data: JSON.stringify({ action: 'confirm', expenseId, source }),
                displayText: 'この内容で確定',
              },
            }),
            iconActionButton({
              iconKey: 'pencil',
              label: '修正',
              flex: 1,
              action: editUrl
                ? {
                    type: 'uri',
                    label: '修正',
                    uri: editUrl,
                  }
                : {
                    // Gmail通知はグループ宛のpushで押す人が分からない。編集URLは
                    // lineId で本人を判定するため、押下時のIDで組み立てて返す。
                    type: 'postback',
                    label: '修正',
                    data: JSON.stringify({ action: 'edit', expenseId, source }),
                    displayText: '修正が必要です',
                  },
            }),
          ],
          spacing: 'sm',
        },
        // 2段目: レシート添付
        iconActionButton({
          iconKey: 'paperclip',
          label: 'レシート添付',
          action: {
            type: 'uri',
            label: 'レシート添付',
            uri: `${WEB_APP_BASE}/attach?expenseId=${expenseId}`,
          },
        }),
        // 3段目: 家計簿一覧への導線
        // 本人判定が URL から Firebase の検証済みクレームへ移ったため、押下者が
        // 誰であっても同じURLでよい。postback で往復せず1タップで直接開く。
        iconActionButton({
          iconKey: 'external-link',
          label: '家計簿一覧を見る',
          action: {
            type: 'uri',
            label: '家計簿一覧を見る',
            uri: EXPENSE_LIST_URL,
          },
        }),
      ],
      paddingAll: 'md',
      spacing: 'sm',
    },
  };

  return {
    type: 'flex',
    altText: `${title} ¥${amount.toLocaleString()}`,
    contents: bubble,
  };
}

/**
 * カード利用通知の情報
 */
export interface CardUsageInfo {
  expenseId: string;
  merchant: string;
  amount: number;
  category: string;
  categoryEmoji: string;
  date: string;
  remainingBudget?: number;
  /** 現在の支出ステータス（未指定は pending 相当） */
  status?: ExpenseStatusType;
  /** 集計に含めるか。pending のときの現在値表示に使う */
  includeInTotal?: boolean;
}

/**
 * カード利用通知のFlex Messageを生成
 */
export function buildCardUsageFlexMessage(info: CardUsageInfo): FlexMessage {
  const { expenseId, merchant, amount, category, date, remainingBudget, status, includeInTotal } = info;

  // 残り予算の表示
  const detailRows = [];
  if (remainingBudget !== undefined) {
    detailRows.push({
      type: 'text' as const,
      text: `残り予算: \u00a5${remainingBudget.toLocaleString()}`,
      size: 'sm' as const,
      // 残り2万円を切ったら赤で警告
      color: remainingBudget < 20000 ? '#F43F5E' : '#10B981',
      margin: 'md' as const,
    });
  }

  return buildExpenseCard({
    expenseId,
    headerIconKey: 'credit-card',
    headerText: 'カード利用を記録',
    title: merchant,
    amount,
    date,
    category,
    source: 'gmail',
    // Gmail自動取得は includeInTotal: true で作られる（未指定でも集計に入る扱い）
    status,
    includeInTotal: includeInTotal ?? true,
    detailRows: detailRows as unknown as FlexComponent[],
  });
}

/**
 * カード利用通知をLINEグループに送信
 */
export async function sendCardUsageNotification(
  lineGroupId: string,
  info: CardUsageInfo
): Promise<void> {
  const client = getLineClient();
  const message = buildCardUsageFlexMessage(info);

  await client.pushMessage({ to: lineGroupId, messages: [message] });
  console.log(`Card usage notification sent to ${lineGroupId}`);
}

/**
 * テキスト入力用の情報
 */
export interface TextExpenseInfo {
  expenseId: string;
  description: string;
  amount: number;
  category: string;
  categoryEmoji: string;
  date: string;
  paymentMethod?: string;
  payerName?: string;
  /** 現在の支出ステータス（未指定は pending 相当） */
  status?: ExpenseStatusType;
  /** 集計に含めるか。pending のときの現在値表示に使う */
  includeInTotal?: boolean;
  /** 「修正」の遷移先（送信相手の lineId を含むWeb編集URL） */
  editUrl?: string;
}

/**
 * テキスト入力登録完了のFlex Messageを生成
 */
export function buildTextExpenseFlexMessage(info: TextExpenseInfo): FlexMessage {
  const {
    expenseId,
    description,
    amount,
    category,
    date,
    paymentMethod,
    payerName,
    status,
    includeInTotal,
    editUrl,
  } = info;

  // 支払い方法・支払い者（設定されている場合のみ）
  const detailRows = [paymentMethod, payerName]
    .filter((text): text is string => Boolean(text))
    .map((text) => ({
      type: 'text' as const,
      text,
      size: 'sm' as const,
      color: '#475569',
      margin: 'sm' as const,
    }));

  return buildExpenseCard({
    expenseId,
    headerIconKey: 'receipt',
    headerText: '支出を登録しました',
    title: description,
    amount,
    date,
    category,
    source: 'text',
    status,
    // LINE手入力は includeInTotal: false で作られる（OK を押すまで集計に入らない）
    includeInTotal: includeInTotal ?? false,
    detailRows: detailRows as unknown as FlexComponent[],
    editUrl,
  });
}

/**
 * Webアプリ（ダッシュボード）のURLを組み立てる
 *
 * かつては web が URL の lineId クエリで本人を判定していたため lineId / lineGroupId を
 * 付与していたが、LIFF ログイン導入後の web はダッシュボード・一覧のどちらでも
 * これらのクエリを読まない（lineGroupId は利用者自身のグループ所属から解決し、
 * lineId を読むのは /link のアカウント連携フローのみ）。グループトークに流れる
 * リンクに LINE userId を載せ続ける理由も無いため、クエリなしの固定URLにする。
 */
export function buildExpenseListUrl(): string {
  return WEB_APP_BASE;
}

/**
 * Web編集画面のURLを組み立てる
 *
 * 一覧と同じく lineId で本人を判定するため、開く本人のIDを必ず含める。
 */
export function buildExpenseEditUrl(expenseId: string, lineId: string): string {
  return `${WEB_APP_BASE}/expenses?edit=${encodeURIComponent(
    expenseId
  )}&lineId=${encodeURIComponent(lineId)}`;
}

/** カードの組み立て直しに使う、Firestoreの支出ドキュメントの部分形 */
export interface ExpenseRecordLike {
  description?: string;
  amount?: number;
  category?: string;
  date?: string;
  status?: ExpenseStatusType;
  includeInTotal?: boolean;
  inputSource?: string;
  paymentMethod?: string;
  payerDisplayName?: string;
  userDisplayName?: string;
}

/**
 * Firestoreの支出ドキュメントから登録・編集カードを組み立て直す
 *
 * LINEは送信済みメッセージを編集できないため、設定を変更したら最新値のカードを返信して
 * 「現在の設定」が実際の値とずれないようにする。元の通知と同じビルダーを通すので、
 * 登録直後のカードと変更後のカードで表現が食い違わない。
 */
export function buildExpenseCardFromRecord(
  expenseId: string,
  record: ExpenseRecordLike,
  opts: {
    editUrl?: string;
    headerText?: string;
    headerIconKey?: string;
  } = {}
): FlexMessage {
  const source: ExpenseCardSource = record.inputSource === 'gmail_auto' ? 'gmail' : 'text';

  // 支払い方法・支払い者はテキスト入力フローのカードだけが持つ情報。
  // Firestoreには 'cash' | 'paypay' | 'card' | 'unknown' の生値が入っているため、
  // 登録直後のカードと同じく表示名へ変換する（'unknown' は空文字になり行ごと消える）。
  const paymentLabel = record.paymentMethod
    ? getPaymentMethodLabel(record.paymentMethod as PaymentMethod)
    : '';

  const detailRows =
    source === 'text'
      ? [paymentLabel, record.payerDisplayName ?? record.userDisplayName]
          .filter((text): text is string => Boolean(text))
          .map((text) => ({
            type: 'text' as const,
            text,
            size: 'sm' as const,
            color: '#475569',
            margin: 'sm' as const,
          }))
      : [];

  return buildExpenseCard({
    expenseId,
    headerIconKey: opts.headerIconKey ?? (source === 'gmail' ? 'credit-card' : 'receipt'),
    headerText: opts.headerText ?? (source === 'gmail' ? 'カード利用を記録' : '支出を登録しました'),
    title: record.description || '不明',
    amount: record.amount ?? 0,
    date: record.date ?? '',
    category: record.category || 'その他',
    source,
    status: record.status,
    includeInTotal: record.includeInTotal,
    detailRows: detailRows as unknown as FlexComponent[],
    editUrl: opts.editUrl,
  });
}

/**
 * テキスト入力登録完了通知を送信
 *
 * replyTokenが渡された場合はreplyMessage（無料・月200通制限の対象外）で送信し、
 * 失敗時（トークン期限切れ・使用済み等）のみpushMessageにフォールバックする
 */
export async function sendTextExpenseNotification(
  targetId: string,
  info: TextExpenseInfo,
  replyToken?: string
): Promise<void> {
  const client = getLineClient();
  const message = buildTextExpenseFlexMessage(info);

  if (replyToken) {
    try {
      await client.replyMessage({ replyToken: replyToken, messages: [message] });
      console.log(`Text expense notification sent via replyMessage (free) to ${targetId}`);
      return;
    } catch (replyError) {
      console.warn(
        "replyMessage failed (token expired or already used), falling back to pushMessage:",
        replyError
      );
    }
  }

  await client.pushMessage({ to: targetId, messages: [message] });
  console.log(`Text expense notification sent via pushMessage to ${targetId}`);
}

/**
 * 家計簿サマリー用の情報
 */
export interface ExpenseSummaryInfo {
  isGroupContext: boolean;
  webAppUrl: string;
  // 当月集計
  monthlyTotal: number;
  monthlyIncludedTotal: number;
  monthlyCount: number;
  monthlyIncludedCount: number;
  monthLabel: string; // "3月"
  monthlyBudget?: number; // 月次予算（未設定時はデフォルト）
  // 直近の支出
  recentExpenses: Array<{
    description: string;
    amount: number;
    category: string;
    categoryEmoji: string;
    date: string;
    includeInTotal: boolean;
  }>;
  // カテゴリ別集計（上位5件）
  categoryTotals: Array<{
    category: string;
    emoji: string;
    amount: number;
    percentage: number;
  }>;
}

/**
 * 家計簿サマリーのFlex Messageを生成
 */
export function buildExpenseSummaryFlexMessage(info: ExpenseSummaryInfo): FlexMessage {
  const {
    isGroupContext,
    webAppUrl,
    monthlyTotal,
    monthlyIncludedTotal,
    monthlyCount,
    monthlyIncludedCount,
    monthLabel,
    recentExpenses,
    categoryTotals,
    monthlyBudget,
  } = info;

  const contextText = isGroupContext ? 'グループ' : 'あなた';
  const pendingCount = monthlyCount - monthlyIncludedCount;

  // プログレスバーの計算（設定された月次予算に対する割合。未設定時は20万円）
  const budget = monthlyBudget && monthlyBudget > 0 ? monthlyBudget : 200000;
  const progressPercent = Math.min(100, Math.round((monthlyIncludedTotal / budget) * 100));
  const progressColor = progressPercent > 80 ? '#F43F5E' : progressPercent > 60 ? '#F59E0B' : '#10B981';

  // カテゴリ別の棒グラフ風表示
  const categoryBars = categoryTotals.slice(0, 4).map(cat => ({
    type: 'box' as const,
    layout: 'horizontal' as const,
    contents: [
      {
        type: 'image' as const,
        url: categoryIconUrl(cat.category),
        size: '16px' as const,
        flex: 0,
        align: 'center' as const,
      },
      {
        type: 'box' as const,
        layout: 'vertical' as const,
        contents: [
          {
            type: 'box' as const,
            layout: 'vertical' as const,
            contents: [],
            backgroundColor: '#10B981',
            height: '8px',
            width: `${Math.max(5, cat.percentage)}%`,
            cornerRadius: '4px',
          },
        ],
        flex: 1,
        margin: 'md' as const,
        justifyContent: 'center' as const,
      },
      {
        type: 'text' as const,
        text: `¥${cat.amount.toLocaleString()}`,
        size: 'xs' as const,
        color: '#64748B',
        align: 'end' as const,
        flex: 0,
      },
    ],
    margin: 'sm' as const,
  }));

  // 直近の支出リスト
  const recentList = recentExpenses.slice(0, 3).map(exp => ({
    type: 'box' as const,
    layout: 'horizontal' as const,
    contents: [
      {
        type: 'text' as const,
        text: `${exp.description}`,
        size: 'sm' as const,
        flex: 1,
        wrap: false,
        color: exp.includeInTotal ? '#0F172A' : '#94A3B8',
      },
      {
        type: 'text' as const,
        text: exp.includeInTotal ? `¥${exp.amount.toLocaleString()}` : `(¥${exp.amount.toLocaleString()})`,
        size: 'sm' as const,
        align: 'end' as const,
        color: exp.includeInTotal ? '#0F172A' : '#94A3B8',
        flex: 0,
      },
    ],
    margin: 'sm' as const,
  }));

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              flex: 1,
              contents: [
                {
                  type: 'icon',
                  url: iconUrl('wallet'),
                  size: 'md',
                },
                {
                  type: 'text',
                  text: `${contextText}の家計簿`,
                  weight: 'bold',
                  size: 'lg',
                  color: '#10B981',
                  margin: 'sm',
                },
              ],
            },
            {
              type: 'text',
              text: monthLabel,
              size: 'sm',
              color: '#64748B',
              align: 'end',
            },
          ],
        },
      ],
      paddingAll: 'lg',
      backgroundColor: '#ECFDF5',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        // 月次合計
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '今月の支出',
              size: 'xs',
              color: '#64748B',
            },
            {
              type: 'text',
              text: `¥${monthlyIncludedTotal.toLocaleString()}`,
              weight: 'bold',
              size: 'xxl',
              color: '#0F172A',
            },
            // プログレスバー
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'box',
                  layout: 'vertical',
                  contents: [],
                  backgroundColor: progressColor,
                  height: '6px',
                  width: `${progressPercent}%`,
                  cornerRadius: '3px',
                },
              ],
              backgroundColor: '#E2E8F0',
              height: '6px',
              margin: 'sm',
              cornerRadius: '3px',
            },
            {
              type: 'text',
              text: `予算 ¥${budget.toLocaleString()} の ${progressPercent}%`,
              size: 'xs',
              color: '#64748B',
              margin: 'sm',
            },
            // 未確認件数
            ...(pendingCount > 0
              ? [
                  {
                    type: 'text' as const,
                    text: `※ 未確認 ${pendingCount}件 (¥${(monthlyTotal - monthlyIncludedTotal).toLocaleString()}) は含まず`,
                    size: 'xs' as const,
                    color: '#F59E0B' as const,
                    margin: 'sm' as const,
                  },
                ]
              : []),
          ],
        },
        // セパレーター
        {
          type: 'separator',
          margin: 'lg',
        },
        // カテゴリ別
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: 'カテゴリ別',
              size: 'xs',
              color: '#64748B',
              margin: 'lg',
            },
            ...categoryBars,
          ],
        },
        // セパレーター
        {
          type: 'separator',
          margin: 'lg',
        },
        // 直近の支出
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '直近の支出',
              size: 'xs',
              color: '#64748B',
              margin: 'lg',
            },
            ...recentList,
          ],
        },
      ],
      paddingAll: 'lg',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        iconActionButton({
          iconKey: 'external-link',
          label: '詳細をWebで見る',
          variant: 'primary',
          action: {
            type: 'uri',
            label: '詳細をWebで見る',
            uri: webAppUrl,
          },
        }),
      ],
      paddingAll: 'md',
    },
  };

  return {
    type: 'flex',
    altText: `${monthLabel}の支出: ¥${monthlyIncludedTotal.toLocaleString()}`,
    contents: bubble,
  };
}

/**
 * 家計簿サマリー（データなし）のFlex Messageを生成
 */
export function buildEmptyExpenseSummaryFlexMessage(
  isGroupContext: boolean,
  webAppUrl: string
): FlexMessage {
  const contextText = isGroupContext ? 'グループ' : 'あなた';

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'icon',
          url: iconUrl('wallet'),
          size: 'md',
        },
        {
          type: 'text',
          text: `${contextText}の家計簿`,
          weight: 'bold',
          size: 'md',
          color: '#10B981',
          margin: 'sm',
        },
      ],
      paddingAll: 'lg',
      backgroundColor: '#ECFDF5',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: 'まだ支出がありません',
          size: 'lg',
          color: '#64748B',
          align: 'center',
        },
        {
          type: 'text',
          text: '使い方',
          size: 'sm',
          color: '#0F172A',
          margin: 'xl',
          weight: 'bold',
        },
        {
          type: 'text',
          text: '• レシート画像を送信',
          size: 'sm',
          color: '#475569',
          margin: 'sm',
        },
        {
          type: 'text',
          text: '• 「500 ランチ」のようにテキスト入力',
          size: 'sm',
          color: '#475569',
          margin: 'sm',
        },
        ...(isGroupContext
          ? [
              {
                type: 'text' as const,
                text: 'グループメンバーの支出が自動で集計されます',
                size: 'xs' as const,
                color: '#64748B',
                margin: 'lg' as const,
                wrap: true,
              },
            ]
          : []),
      ],
      paddingAll: 'lg',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        iconActionButton({
          iconKey: 'external-link',
          label: 'Webアプリを開く',
          variant: 'primary',
          action: {
            type: 'uri',
            label: 'Webアプリを開く',
            uri: webAppUrl,
          },
        }),
      ],
      paddingAll: 'md',
    },
  };

  return {
    type: 'flex',
    altText: `${contextText}の家計簿`,
    contents: bubble,
  };
}

/**
 * カテゴリ選択用の情報
 */
export interface CategorySelectInfo {
  expenseId: string;
  currentCategory: string;
  source: 'gmail' | 'text';
  merchant: string;
  amount: number;
}

// カテゴリ一覧
const CATEGORIES = [
  '食費', '日用品', '交通費', '医療費', '娯楽費',
  '衣服費', '教育費', '通信費', '光熱費', 'その他'
];

/**
 * カテゴリ選択CarouselのFlex Messageを生成
 */
export function buildCategorySelectCarousel(info: CategorySelectInfo): FlexMessage {
  const { expenseId, currentCategory, source, merchant, amount } = info;

  // 各カテゴリのbubbleを生成
  const bubbles: FlexBubble[] = CATEGORIES.map((categoryName) => {
    const isCurrentCategory = categoryName === currentCategory;

    return {
      type: 'bubble',
      size: 'nano',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'image',
            url: categoryIconUrl(categoryName),
            size: '36px',
            align: 'center',
          },
          {
            type: 'text',
            text: categoryName,
            weight: 'bold',
            size: 'sm',
            align: 'center',
            margin: 'sm',
          },
          {
            type: 'text',
            text: `¥${amount.toLocaleString()}`,
            size: 'xs',
            color: '#64748B',
            align: 'center',
            margin: 'xs',
          },
        ],
        backgroundColor: isCurrentCategory ? '#ECFDF5' : undefined,
        paddingAll: 'md',
        justifyContent: 'center',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          iconActionButton({
            iconKey: 'check',
            label: isCurrentCategory ? '選択中' : 'これにする',
            variant: isCurrentCategory ? 'primary' : 'secondary',
            action: {
              type: 'postback',
              label: isCurrentCategory ? '選択中' : 'これにする',
              data: JSON.stringify({
                action: 'set_category',
                expenseId,
                category: categoryName,
                source,
              }),
            },
          }),
        ],
        paddingAll: 'sm',
      },
    };
  });

  return {
    type: 'flex',
    altText: `カテゴリを選択: ${merchant}`,
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}
