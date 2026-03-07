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
