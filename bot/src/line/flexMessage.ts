/**
 * LINE Flex Message生成
 *
 * カード利用通知用のリッチなメッセージを生成
 */

import { Client, FlexMessage, FlexBubble, FlexComponent } from '@line/bot-sdk';

// LINEクライアントの初期化
let lineClient: Client | null = null;

function getLineClient(): Client {
  if (!lineClient) {
    const channelAccessToken = process.env.LINE_CHANNEL_TOKEN;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    if (!channelAccessToken || !channelSecret) {
      throw new Error('LINE credentials not configured');
    }

    lineClient = new Client({
      channelAccessToken,
      channelSecret,
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
}

/**
 * カード利用通知のFlex Messageを生成
 */
export function buildCardUsageFlexMessage(info: CardUsageInfo): FlexMessage {
  const { expenseId, merchant, amount, category, categoryEmoji, date, remainingBudget } = info;

  // 残り予算の表示
  let budgetText = '';
  let budgetColor = '#10B981'; // 緑（余裕あり）
  if (remainingBudget !== undefined) {
    budgetText = `残り予算: ¥${remainingBudget.toLocaleString()}`;
    if (remainingBudget < 20000) {
      budgetColor = '#F43F5E'; // 赤（残り少ない）
    }
  }

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'icon',
          url: iconUrl('credit-card'),
          size: 'md',
        },
        {
          type: 'text',
          text: 'カード利用を記録',
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
        // 店舗名
        {
          type: 'text',
          text: merchant,
          weight: 'bold',
          size: 'xl',
          wrap: true,
        },
        // 金額
        {
          type: 'text',
          text: `¥${amount.toLocaleString()}`,
          weight: 'bold',
          size: 'xxl',
          color: '#0F172A',
          margin: 'md',
        },
        // カテゴリと日付
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
                  url: categoryIconUrl(category),
                  size: 'sm',
                },
                {
                  type: 'text',
                  text: `${category}`,
                  size: 'sm',
                  color: '#64748B',
                  margin: 'sm',
                },
              ],
            },
            {
              type: 'text',
              text: date,
              size: 'sm',
              color: '#64748B',
              align: 'end',
            },
          ],
          margin: 'md',
        },
        // 残り予算（設定されている場合）
        ...(budgetText
          ? [
              {
                type: 'text' as const,
                text: budgetText,
                size: 'sm' as const,
                color: budgetColor,
                margin: 'lg' as const,
                align: 'center' as const,
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
        // 1段目: 共同費・個人費
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            iconActionButton({
              iconKey: 'users',
              label: '共同費',
              variant: 'primary',
              flex: 1,
              action: {
                type: 'postback',
                label: '共同費',
                data: JSON.stringify({ action: 'shared', expenseId }),
                displayText: '共同費として記録',
              },
            }),
            iconActionButton({
              iconKey: 'user',
              label: '個人費',
              flex: 1,
              action: {
                type: 'postback',
                label: '個人費',
                data: JSON.stringify({ action: 'personal', expenseId }),
                displayText: '個人費として除外',
              },
            }),
          ],
          spacing: 'sm',
        },
        // 2段目: 立替・カテゴリ変更
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            iconActionButton({
              iconKey: 'credit-card',
              label: '立替',
              flex: 1,
              action: {
                type: 'postback',
                label: '立替',
                data: JSON.stringify({ action: 'advance', expenseId }),
                displayText: '立替として記録',
              },
            }),
            iconActionButton({
              iconImageUrl: categoryIconUrl(category),
              label: `${category}`,
              flex: 1,
              action: {
                type: 'postback',
                label: `${category}`,
                data: JSON.stringify({
                  action: 'show_category_select',
                  expenseId,
                  source: 'gmail',
                }),
              },
            }),
          ],
          spacing: 'sm',
          margin: 'sm',
        },
        // 3段目: レシート添付
        iconActionButton({
          iconKey: 'paperclip',
          label: 'レシート添付',
          action: {
            type: 'uri',
            label: 'レシート添付',
            uri: `https://line-kakeibo.vercel.app/attach?expenseId=${expenseId}`,
          },
        }),
      ],
      paddingAll: 'md',
      spacing: 'sm',
    },
  };

  return {
    type: 'flex',
    altText: `${merchant} ¥${amount.toLocaleString()}`,
    contents: bubble,
  };
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

  await client.pushMessage(lineGroupId, message);
  console.log(`Card usage notification sent to ${lineGroupId}`);
}

/**
 * シンプルなテキストメッセージを送信
 */
export async function sendTextMessage(
  targetId: string,
  text: string
): Promise<void> {
  const client = getLineClient();

  await client.pushMessage(targetId, {
    type: 'text',
    text,
  });
}

/**
 * ステータス更新の確認メッセージを送信
 */
export async function sendStatusUpdateConfirmation(
  targetId: string,
  status: 'shared' | 'personal' | 'advance',
  merchant: string,
  amount: number
): Promise<void> {
  const messages: Record<string, string> = {
    shared: `共同費として記録しました\n${merchant} ¥${amount.toLocaleString()}`,
    personal: `個人費として除外しました\n${merchant} ¥${amount.toLocaleString()}`,
    advance: `立替として記録しました\n${merchant} ¥${amount.toLocaleString()}\n月末精算に含めます`,
  };

  await sendTextMessage(targetId, messages[status]);
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
}

/**
 * テキスト入力登録完了のFlex Messageを生成
 */
export function buildTextExpenseFlexMessage(info: TextExpenseInfo): FlexMessage {
  const { expenseId, description, amount, category, categoryEmoji, date, paymentMethod, payerName } = info;

  // 支払い方法の表示
  const paymentMethodText = paymentMethod ? `${paymentMethod}` : '';

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'icon',
          url: iconUrl('receipt'),
          size: 'md',
        },
        {
          type: 'text',
          text: '支出を登録しました',
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
        // 説明
        {
          type: 'text',
          text: description,
          weight: 'bold',
          size: 'lg',
          wrap: true,
        },
        // 金額
        {
          type: 'text',
          text: `¥${amount.toLocaleString()}`,
          weight: 'bold',
          size: 'xl',
          color: '#0F172A',
          margin: 'sm',
        },
        // カテゴリと日付
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
                  url: categoryIconUrl(category),
                  size: 'sm',
                },
                {
                  type: 'text',
                  text: `${category}`,
                  size: 'sm',
                  color: '#64748B',
                  margin: 'sm',
                },
              ],
            },
            {
              type: 'text',
              text: date,
              size: 'sm',
              color: '#64748B',
              align: 'end',
            },
          ],
          margin: 'md',
        },
        // 支払い方法（設定されている場合）
        ...(paymentMethodText
          ? [
              {
                type: 'text' as const,
                text: paymentMethodText,
                size: 'sm' as const,
                color: '#475569',
                margin: 'sm' as const,
              },
            ]
          : []),
        // 支払い者（設定されている場合）
        ...(payerName
          ? [
              {
                type: 'text' as const,
                text: `${payerName}`,
                size: 'sm' as const,
                color: '#475569',
                margin: 'sm' as const,
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
        // 1段目: OK・修正
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
                data: JSON.stringify({ action: 'confirm', expenseId, source: 'text' }),
                displayText: '登録を確認しました',
              },
            }),
            iconActionButton({
              iconKey: 'pencil',
              label: '修正',
              flex: 1,
              action: {
                type: 'postback',
                label: '修正',
                data: JSON.stringify({ action: 'edit', expenseId, source: 'text' }),
                displayText: '修正が必要です',
              },
            }),
          ],
          spacing: 'sm',
        },
        // 2段目: 立替・カテゴリ変更
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            iconActionButton({
              iconKey: 'credit-card',
              label: '立替',
              flex: 1,
              action: {
                type: 'postback',
                label: '立替',
                data: JSON.stringify({ action: 'advance', expenseId, source: 'text' }),
                displayText: '立替として記録',
              },
            }),
            iconActionButton({
              iconImageUrl: categoryIconUrl(category),
              label: `${category}`,
              flex: 1,
              action: {
                type: 'postback',
                label: `${category}`,
                data: JSON.stringify({
                  action: 'show_category_select',
                  expenseId,
                  source: 'text',
                }),
              },
            }),
          ],
          spacing: 'sm',
          margin: 'sm',
        },
        // 3段目: レシート添付
        iconActionButton({
          iconKey: 'paperclip',
          label: 'レシート添付',
          action: {
            type: 'uri',
            label: 'レシート添付',
            uri: `https://line-kakeibo.vercel.app/attach?expenseId=${expenseId}`,
          },
        }),
      ],
      paddingAll: 'md',
      spacing: 'sm',
    },
  };

  return {
    type: 'flex',
    altText: `${description} ¥${amount.toLocaleString()}`,
    contents: bubble,
  };
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
      await client.replyMessage(replyToken, message);
      console.log(`Text expense notification sent via replyMessage (free) to ${targetId}`);
      return;
    } catch (replyError) {
      console.warn(
        "replyMessage failed (token expired or already used), falling back to pushMessage:",
        replyError
      );
    }
  }

  await client.pushMessage(targetId, message);
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
