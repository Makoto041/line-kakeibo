/**
 * 期間の精算（折半）サマリーの LINE メッセージ（settlementSummary.ts が毎月の起算日に送る。Web の設定から手動でも送れる）
 *
 * 1 回の push に 2 通を入れる（LINE の通数は 1 回の送信で数えるので増えない）:
 * 1. 送金する人と受け取る人をメンションしたテキスト（Flex ではメンションできないため textV2）
 * 2. 内訳（立替の全額を含む）・カテゴリ別・要確認をまとめた Flex
 * 今の期間の途中経過（summary.interim）は、期間に「（途中経過）」を付け、送金の依頼ではなく見込みとして書く。
 * 見た目は登録・編集カード（flexMessage.ts）と揃える（緑のヘッダー、同じアイコン）。
 */

import type { messagingApi } from '@line/bot-sdk';
import type { SettlementSummary } from '../settlementSummary';
import { formatYenExact } from '../periodSplit';
import { categoryIconUrl, iconUrl, WEB_APP_BASE } from './flexMessage';

type FlexComponent = messagingApi.FlexComponent;

const COLOR = {
  accent: '#10B981',
  accentDeep: '#047857',
  headerBg: '#ECFDF5',
  text: '#0F172A',
  sub: '#475569',
  muted: '#64748B',
  panel: '#F8FAFC',
  track: '#E2E8F0',
  warnBg: '#FEF3C7',
  warnText: '#92400E',
};

const LINE_USER_ID = /^U[0-9a-f]{32}$/;

export const SETTLEMENT_URL = `${WEB_APP_BASE}/settlement`;

function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

/** 9/15〜10/14（年をまたぐときは年も付ける） */
export function periodLabel(range: { startDate: string; endDate: string }): string {
  const [sy, sm, sd] = range.startDate.split('-').map(Number);
  const [ey, em, ed] = range.endDate.split('-').map(Number);
  return sy === ey ? `${sm}/${sd}〜${em}/${ed}` : `${sy}/${sm}/${sd}〜${ey}/${em}/${ed}`;
}

/** 見出しの期間（途中経過なら「10/15〜10/17（途中経過）」） */
function summaryLabel(summary: SettlementSummary): string {
  const label = periodLabel(summary.range);
  return summary.interim ? `${label}（途中経過）` : label;
}

function nameOf(summary: SettlementSummary, lineId: string | undefined): string {
  return summary.members.find((m) => m.lineId === lineId)?.displayName || 'メンバー';
}

/** テキストのメンション（LINE の userId でなければ名前をそのまま書く） */
function mentionText(
  summary: SettlementSummary,
  template: string,
  people: Record<string, string>
): messagingApi.Message {
  const substitution: Record<string, messagingApi.SubstitutionObject> = {};
  let text = template;
  for (const [key, lineId] of Object.entries(people)) {
    if (LINE_USER_ID.test(lineId)) {
      substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: lineId } } as messagingApi.SubstitutionObject;
    } else {
      // 名前に $& などが含まれても置換の記法として解釈させない
      text = text.replace(`{${key}}`, () => nameOf(summary, lineId));
    }
  }
  return Object.keys(substitution).length > 0
    ? ({ type: 'textV2', text, substitution } as messagingApi.Message)
    : { type: 'text', text };
}

function row(label: string, value: string, opts: { muted?: boolean; bold?: boolean } = {}): FlexComponent {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xs', color: opts.muted ? COLOR.muted : COLOR.sub, flex: 1, wrap: true },
      {
        type: 'text',
        text: value,
        size: 'xs',
        color: opts.muted ? COLOR.muted : COLOR.text,
        weight: opts.bold === false ? 'regular' : 'bold',
        align: 'end',
        flex: 0,
      },
    ],
  } as FlexComponent;
}

function categoryRow(category: string, amount: number, percentage: number): FlexComponent {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    spacing: 'md',
    alignItems: 'center',
    contents: [
      { type: 'image', url: categoryIconUrl(category), size: '20px', flex: 0 },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: category, size: 'sm', color: COLOR.text, flex: 1 },
              { type: 'text', text: `${percentage}%`, size: 'xxs', color: COLOR.muted, flex: 0, gravity: 'center', margin: 'sm' },
              { type: 'text', text: yen(amount), size: 'sm', weight: 'bold', color: COLOR.text, align: 'end', flex: 0, margin: 'md' },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: COLOR.track,
            height: '6px',
            cornerRadius: '3px',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: COLOR.accent,
                height: '6px',
                cornerRadius: '3px',
                width: `${Math.max(2, Math.min(100, Math.round(percentage)))}%`,
                contents: [],
              },
            ],
          },
        ],
      },
    ],
  } as FlexComponent;
}

function notice(text: string, bg: string, color: string): FlexComponent {
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    paddingAll: 'md',
    cornerRadius: '10px',
    backgroundColor: bg,
    contents: [{ type: 'text', text, size: 'xs', color, wrap: true }],
  } as FlexComponent;
}

function linkButton(label: string, uri: string, primary: boolean): FlexComponent {
  return {
    type: 'button',
    style: primary ? 'primary' : 'secondary',
    color: primary ? COLOR.accent : '#F1F5F9',
    height: 'sm',
    flex: 1,
    action: { type: 'uri', label, uri },
  } as FlexComponent;
}

export function buildSettlementSummaryFlex(summary: SettlementSummary): messagingApi.FlexMessage {
  const { split } = summary;
  const label = summaryLabel(summary);
  const transfer = split.transfer;
  const fromName = nameOf(summary, transfer?.fromLineId);
  const toName = nameOf(summary, transfer?.toLineId);
  const targetName = split.target?.displayName || 'メンバー';
  const counterpartName = split.counterpart?.displayName || 'メンバー';

  const countLabel = [`${split.count}件`, split.excludedCount > 0 ? `除外${split.excludedCount}件` : '', split.settledCount > 0 ? `立替精算済み${split.settledCount}件` : '', split.advanceCount > 0 ? `立替${split.advanceCount}件は全額で別` : '']
    .filter(Boolean)
    .join('・');

  const body: FlexComponent[] = [
    // 送金額
    {
      type: 'box',
      layout: 'vertical',
      alignItems: 'center',
      contents: [
        {
          type: 'text',
          text: transfer ? `${fromName}  →  ${toName}` : `${targetName}・${counterpartName}`,
          size: 'sm',
          color: COLOR.sub,
          align: 'center',
          wrap: true,
        },
        { type: 'text', text: yen(transfer?.amount ?? 0), size: '3xl', weight: 'bold', color: COLOR.text, align: 'center', margin: 'sm' },
        {
          type: 'text',
          text: transfer
            ? summary.interim
              ? `今日までの分で、${fromName}が${toName}に送金する見込み`
              : `${fromName}が${toName}に送金`
            : summary.interim
            ? '今日までの分では送金なし'
            : '今回は送金なし',
          size: 'xs',
          color: COLOR.muted,
          align: 'center',
          margin: 'xs',
        },
      ],
    } as FlexComponent,
    // 内訳（Web の期間の精算と同じ並び）
    {
      type: 'box',
      layout: 'vertical',
      margin: 'xl',
      paddingAll: 'md',
      cornerRadius: '12px',
      backgroundColor: COLOR.panel,
      contents: [
        row(`合計（${countLabel}）`, yen(split.total)),
        row('1人あたり（÷ 2）', formatYenExact(split.half)),
        row(`− ${targetName}の支払い`, yen(split.targetPaid)),
        // 立替（全額）は折半せず、立て替えた人へ全額を返す
        ...(split.counterpartAdvanced > 0 ? [row(`+ ${counterpartName}の立替（全額）`, yen(split.counterpartAdvanced))] : []),
        ...(split.targetAdvanced > 0 ? [row(`− ${targetName}の立替（全額）`, yen(split.targetAdvanced))] : []),
        { type: 'separator', margin: 'md', color: COLOR.track } as FlexComponent,
        row(`${counterpartName}・カード・共通口座の支払い`, yen(summary.othersPaid), { muted: true, bold: false }),
      ],
    } as FlexComponent,
  ];

  if (summary.categories.length > 0) {
    body.push(
      { type: 'separator', margin: 'xl' } as FlexComponent,
      { type: 'text', text: 'カテゴリ別', size: 'xs', weight: 'bold', color: COLOR.muted, margin: 'lg' } as FlexComponent,
      ...summary.categories.map((c) => categoryRow(c.category, c.amount, c.percentage))
    );
    if (summary.otherCategories.count > 0) {
      body.push({
        type: 'text',
        text: `ほか ${summary.otherCategories.count}カテゴリ ${yen(summary.otherCategories.amount)}`,
        size: 'xxs',
        color: COLOR.muted,
        align: 'end',
        margin: 'md',
      } as FlexComponent);
    }
  }

  if (summary.pending.count > 0) {
    body.push(
      notice(
        `要確認が ${summary.pending.count}件（${yen(summary.pending.amount)}）あります。確認すると、この期間の合計に入ります`,
        COLOR.warnBg,
        COLOR.warnText
      )
    );
  }

  return {
    type: 'flex',
    altText: transfer
      ? `${label} の精算: ${fromName}→${toName} ${yen(transfer.amount)}`
      : `${label} の精算: 送金なし`,
    contents: {
      type: 'bubble',
      size: 'mega',
      // タイトルと期間を 1 行に並べると狭い画面で切れるので 2 行にする
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        backgroundColor: COLOR.headerBg,
        contents: [
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'icon', url: iconUrl('wallet'), size: 'md' },
              { type: 'text', text: '期間の精算（折半）', weight: 'bold', size: 'md', color: COLOR.accent, margin: 'sm' },
            ],
          },
          { type: 'text', text: label, size: 'sm', weight: 'bold', color: COLOR.accentDeep, margin: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [linkButton('精算を開く', SETTLEMENT_URL, true), linkButton('支出を見る', `${WEB_APP_BASE}/expenses`, false)],
      },
    } as messagingApi.FlexBubble,
  };
}

/** 送る 2 通（メンション付きテキスト → Flex） */
export function buildSettlementSummaryMessages(summary: SettlementSummary): messagingApi.Message[] {
  const label = periodLabel(summary.range);
  const transfer = summary.split.transfer;
  const [a, b] = summary.members;
  if (summary.interim) {
    // 途中経過は送金の依頼ではないので、メンションせずに見込みだけを伝える
    const text = transfer
      ? `${label} の精算（折半）の途中経過です。\n今日までの分では、${nameOf(summary, transfer.fromLineId)} から ${nameOf(summary, transfer.toLineId)} へ ${yen(transfer.amount)} の見込みです。`
      : `${label} の精算（折半）の途中経過です。\n今日までの分では送金なしの見込みです。`;
    return [{ type: 'text', text }, buildSettlementSummaryFlex(summary)];
  }
  const text = transfer
    ? mentionText(summary, `${label} の精算（折半）です。\n{u1} から {u2} へ ${yen(transfer.amount)} の送金をお願いします。`, {
        u1: transfer.fromLineId,
        u2: transfer.toLineId,
      })
    : mentionText(summary, `{u1} {u2}\n${label} の精算（折半）は、今回は送金なしです。`, {
        u1: a?.lineId ?? '',
        u2: b?.lineId ?? '',
      });
  return [text, buildSettlementSummaryFlex(summary)];
}
