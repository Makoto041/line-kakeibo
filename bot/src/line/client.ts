/**
 * LINE Messaging API クライアントと返信ヘルパー
 *
 * クライアントはここで 1 つだけ作る（webhook・postback・Gmail 通知で共用）。
 * デプロイ時の関数解析では Secret が注入されないため、モジュール読み込み時には作らず
 * 最初に使うときに作る。
 */

import { messagingApi } from '@line/bot-sdk';

let lineClient: messagingApi.MessagingApiClient | null = null;

export function getLineClient(): messagingApi.MessagingApiClient {
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

/** replyToken で返信する（無料。push は月200通の上限がある） */
export async function replyMessages(
  replyToken: string,
  messages: messagingApi.Message[]
): Promise<void> {
  await getLineClient().replyMessage({ replyToken, messages });
}

/** テキスト 1 通を replyToken で返信する */
export async function replyText(replyToken: string, text: string): Promise<void> {
  await replyMessages(replyToken, [{ type: 'text', text }]);
}

/** テキスト 1 通を push で送る（replyToken が無い・使えないとき用） */
export async function pushText(to: string, text: string): Promise<void> {
  await getLineClient().pushMessage({ to, messages: [{ type: 'text', text }] });
}

/**
 * replyMessage（無料）で返し、トークン期限切れ・使用済み等で失敗したときだけ
 * pushMessage にフォールバックする。
 *
 * @returns 実際に使った送信方法（push 先が無く送れなかったときは 'none'）
 */
export async function replyWithPushFallback(
  replyToken: string | undefined,
  to: string | undefined,
  messages: messagingApi.Message[]
): Promise<'reply' | 'push' | 'none'> {
  const client = getLineClient();

  if (replyToken) {
    try {
      await client.replyMessage({ replyToken, messages });
      return 'reply';
    } catch (replyError) {
      console.warn(
        'replyMessage failed (token expired or already used), falling back to pushMessage:',
        replyError
      );
    }
  }

  if (!to) {
    console.warn('Cannot determine push target for reply fallback');
    return 'none';
  }
  await client.pushMessage({ to, messages });
  return 'push';
}
