/**
 * LINE Flex Message生成
 *
 * カード利用通知用のリッチなメッセージを生成
 */

import { Client, FlexMessage, FlexBubble } from '@line/bot-sdk';

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
  let budgetColor = '#00C851'; // 緑（余裕あり）
  if (remainingBudget !== undefined) {
    budgetText = `残り予算: ¥${remainingBudget.toLocaleString()}`;
    if (remainingBudget < 20000) {
      budgetColor = '#ff4444'; // 赤（残り少ない）
    }
  }

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '💳 カード利用を記録',
          weight: 'bold',
          size: 'md',
          color: '#1DB446',
        },
      ],
      paddingAll: 'lg',
      backgroundColor: '#F0FFF0',
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
          color: '#DD4444',
          margin: 'md',
        },
        // カテゴリと日付
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: `${categoryEmoji} ${category}`,
              size: 'sm',
              color: '#888888',
              flex: 1,
            },
            {
              type: 'text',
              text: date,
              size: 'sm',
              color: '#888888',
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
      layout: 'horizontal',
      contents: [
        // 共同費ボタン
        {
          type: 'button',
          action: {
            type: 'postback',
            label: '✅ 共同費',
            data: JSON.stringify({
              action: 'shared',
              expenseId,
            }),
            displayText: '✅ 共同費として記録',
          },
          style: 'primary',
          color: '#00C851',
          height: 'sm',
          flex: 1,
        },
        // 個人費ボタン
        {
          type: 'button',
          action: {
            type: 'postback',
            label: '👤 個人費',
            data: JSON.stringify({
              action: 'personal',
              expenseId,
            }),
            displayText: '👤 個人費として除外',
          },
          style: 'secondary',
          height: 'sm',
          flex: 1,
          margin: 'sm',
        },
        // 立替ボタン
        {
          type: 'button',
          action: {
            type: 'postback',
            label: '↩️ 立替',
            data: JSON.stringify({
              action: 'advance',
              expenseId,
            }),
            displayText: '↩️ 立替として記録',
          },
          style: 'secondary',
          height: 'sm',
          flex: 1,
          margin: 'sm',
        },
      ],
      paddingAll: 'md',
      spacing: 'sm',
    },
  };

  return {
    type: 'flex',
    altText: `💳 ${merchant} ¥${amount.toLocaleString()}`,
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
    shared: `✅ 共同費として記録しました\n${merchant} ¥${amount.toLocaleString()}`,
    personal: `👤 個人費として除外しました\n${merchant} ¥${amount.toLocaleString()}`,
    advance: `↩️ 立替として記録しました\n${merchant} ¥${amount.toLocaleString()}\n月末精算に含めます`,
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
  const paymentMethodText = paymentMethod ? `💰 ${paymentMethod}` : '';

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '✅ 支出を登録しました',
          weight: 'bold',
          size: 'md',
          color: '#1DB446',
        },
      ],
      paddingAll: 'lg',
      backgroundColor: '#F0FFF0',
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
          color: '#DD4444',
          margin: 'sm',
        },
        // カテゴリと日付
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: `${categoryEmoji} ${category}`,
              size: 'sm',
              color: '#888888',
              flex: 1,
            },
            {
              type: 'text',
              text: date,
              size: 'sm',
              color: '#888888',
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
                color: '#666666',
                margin: 'sm' as const,
              },
            ]
          : []),
        // 支払い者（設定されている場合）
        ...(payerName
          ? [
              {
                type: 'text' as const,
                text: `👤 ${payerName}`,
                size: 'sm' as const,
                color: '#666666',
                margin: 'sm' as const,
              },
            ]
          : []),
      ],
      paddingAll: 'lg',
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        // OKボタン
        {
          type: 'button',
          action: {
            type: 'postback',
            label: '✅ OK',
            data: JSON.stringify({
              action: 'confirm',
              expenseId,
              source: 'text',
            }),
            displayText: '✅ 登録を確認しました',
          },
          style: 'primary',
          color: '#00C851',
          height: 'sm',
          flex: 1,
        },
        // 修正ボタン
        {
          type: 'button',
          action: {
            type: 'postback',
            label: '✏️ 修正',
            data: JSON.stringify({
              action: 'edit',
              expenseId,
              source: 'text',
            }),
            displayText: '✏️ 修正が必要です',
          },
          style: 'secondary',
          height: 'sm',
          flex: 1,
          margin: 'sm',
        },
        // 立替ボタン
        {
          type: 'button',
          action: {
            type: 'postback',
            label: '↩️ 立替',
            data: JSON.stringify({
              action: 'advance',
              expenseId,
              source: 'text',
            }),
            displayText: '↩️ 立替として記録',
          },
          style: 'secondary',
          height: 'sm',
          flex: 1,
          margin: 'sm',
        },
      ],
      paddingAll: 'md',
      spacing: 'sm',
    },
  };

  return {
    type: 'flex',
    altText: `✅ ${description} ¥${amount.toLocaleString()}`,
    contents: bubble,
  };
}

/**
 * テキスト入力登録完了通知を送信
 */
export async function sendTextExpenseNotification(
  targetId: string,
  info: TextExpenseInfo
): Promise<void> {
  const client = getLineClient();
  const message = buildTextExpenseFlexMessage(info);

  await client.pushMessage(targetId, message);
  console.log(`Text expense notification sent to ${targetId}`);
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
  } = info;

  const contextText = isGroupContext ? '👥 グループ' : '📱 個人';
  const pendingCount = monthlyCount - monthlyIncludedCount;

  // プログレスバーの計算（予算13.6万円に対する割合）
  const budget = 136000;
  const progressPercent = Math.min(100, Math.round((monthlyIncludedTotal / budget) * 100));
  const progressColor = progressPercent > 80 ? '#ff4444' : progressPercent > 60 ? '#ffbb33' : '#00C851';

  // カテゴリ別の棒グラフ風表示
  const categoryBars = categoryTotals.slice(0, 4).map(cat => ({
    type: 'box' as const,
    layout: 'horizontal' as const,
    contents: [
      {
        type: 'text' as const,
        text: `${cat.emoji}`,
        size: 'sm' as const,
        flex: 0,
      },
      {
        type: 'box' as const,
        layout: 'vertical' as const,
        contents: [
          {
            type: 'box' as const,
            layout: 'vertical' as const,
            contents: [],
            backgroundColor: '#1DB446',
            height: '8px',
            width: `${Math.max(5, cat.percentage)}%`,
            cornerRadius: '4px',
          },
        ],
        flex: 1,
        margin: 'sm' as const,
        justifyContent: 'center' as const,
      },
      {
        type: 'text' as const,
        text: `¥${cat.amount.toLocaleString()}`,
        size: 'xs' as const,
        color: '#888888',
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
        text: `${exp.categoryEmoji} ${exp.description}`,
        size: 'sm' as const,
        flex: 1,
        wrap: false,
        color: exp.includeInTotal ? '#333333' : '#aaaaaa',
      },
      {
        type: 'text' as const,
        text: exp.includeInTotal ? `¥${exp.amount.toLocaleString()}` : `(¥${exp.amount.toLocaleString()})`,
        size: 'sm' as const,
        align: 'end' as const,
        color: exp.includeInTotal ? '#DD4444' : '#aaaaaa',
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
              type: 'text',
              text: `📊 ${contextText}の家計簿`,
              weight: 'bold',
              size: 'lg',
              color: '#1DB446',
              flex: 1,
            },
            {
              type: 'text',
              text: monthLabel,
              size: 'sm',
              color: '#888888',
              align: 'end',
            },
          ],
        },
      ],
      paddingAll: 'lg',
      backgroundColor: '#F0FFF0',
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
              color: '#888888',
            },
            {
              type: 'text',
              text: `¥${monthlyIncludedTotal.toLocaleString()}`,
              weight: 'bold',
              size: 'xxl',
              color: '#333333',
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
              backgroundColor: '#EEEEEE',
              height: '6px',
              margin: 'sm',
              cornerRadius: '3px',
            },
            {
              type: 'text',
              text: `予算 ¥${budget.toLocaleString()} の ${progressPercent}%`,
              size: 'xs',
              color: '#888888',
              margin: 'sm',
            },
            // 未確認件数
            ...(pendingCount > 0
              ? [
                  {
                    type: 'text' as const,
                    text: `※ 未確認 ${pendingCount}件 (¥${(monthlyTotal - monthlyIncludedTotal).toLocaleString()}) は含まず`,
                    size: 'xs' as const,
                    color: '#ff9800' as const,
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
              color: '#888888',
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
              color: '#888888',
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
        {
          type: 'button',
          action: {
            type: 'uri',
            label: '📱 詳細をWebで見る',
            uri: webAppUrl,
          },
          style: 'primary',
          color: '#1DB446',
          height: 'sm',
        },
      ],
      paddingAll: 'md',
    },
  };

  return {
    type: 'flex',
    altText: `📊 ${monthLabel}の支出: ¥${monthlyIncludedTotal.toLocaleString()}`,
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
  const contextText = isGroupContext ? '👥 グループ' : '📱 個人';

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: `📊 ${contextText}の家計簿`,
          weight: 'bold',
          size: 'md',
          color: '#1DB446',
        },
      ],
      paddingAll: 'lg',
      backgroundColor: '#F0FFF0',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: 'まだ支出がありません',
          size: 'lg',
          color: '#888888',
          align: 'center',
        },
        {
          type: 'text',
          text: '💡 使い方',
          size: 'sm',
          color: '#333333',
          margin: 'xl',
          weight: 'bold',
        },
        {
          type: 'text',
          text: '• レシート画像を送信',
          size: 'sm',
          color: '#666666',
          margin: 'sm',
        },
        {
          type: 'text',
          text: '• 「500 ランチ」のようにテキスト入力',
          size: 'sm',
          color: '#666666',
          margin: 'sm',
        },
        ...(isGroupContext
          ? [
              {
                type: 'text' as const,
                text: '👥 グループメンバーの支出が自動で集計されます',
                size: 'xs' as const,
                color: '#888888',
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
        {
          type: 'button',
          action: {
            type: 'uri',
            label: '📱 Webアプリを開く',
            uri: webAppUrl,
          },
          style: 'primary',
          color: '#1DB446',
          height: 'sm',
        },
      ],
      paddingAll: 'md',
    },
  };

  return {
    type: 'flex',
    altText: `📊 ${contextText}の家計簿`,
    contents: bubble,
  };
}
