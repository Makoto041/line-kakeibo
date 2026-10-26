// デモ（/demo）の「精算サマリー」（毎月の起算日に LINE グループへ届く期間の精算）の文言・色・集計。発表後に lib/demo ごと消す。
// bot の buildSettlementSummary（bot/src/settlementSummary.ts）と buildSettlementSummaryMessages / buildSettlementSummaryFlex
// （bot/src/line/settlementSummaryMessage.ts）を手で写したもの。文言・色は __tests__/demoCard.test.mjs で bot のソースと突き合わせる。
// 送金額などの数字は、画面（components/demo/LineSettlementSummary.tsx）が本番と同じ computePeriodSplit・periodPool の結果を渡して出す
// （手で書いた数字は置かない）。カテゴリ別・要確認の集計は bot と同じ数え方をここに書く（web の lib/periodSplit.ts に無いため）。
// node --test から直接読めるよう、型だけを import する。
import type { Expense } from '../hooks';
import type { PeriodSplit } from '../periodSplit';

/** 毎月の起算日に送る（bot: index.ts の postRecurringExpenses。毎日 9:10 JST に判定する） */
export const SUMMARY_SEND_TIME = '9:10';
/** Flex に並べるカテゴリの数（bot: SUMMARY_TOP_CATEGORIES） */
export const SUMMARY_TOP_CATEGORIES = 5;

/** 色（bot: settlementSummaryMessage.ts の COLOR） */
export const SUMMARY_COLORS = {
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
} as const;

/** 下の 2 つのボタン（左が強調）。押すとデモの精算・支出一覧へ */
export const SUMMARY_TEXT = {
  header: '期間の精算（折半）',
  headerIconKey: 'wallet',
  categories: 'カテゴリ別',
  half: '1人あたり（÷ 2）',
  noTransfer: '今回は送金なし',
  openSettlement: '精算を開く',
  openExpenses: '支出を見る',
} as const;

function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
}

/** 式の表示用（bot: formatYenExact。整数ならそのまま、端数があれば小数 1 桁） */
export function formatYenExact(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `¥${rounded.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`;
}

/** 9/1〜9/30（年をまたぐときは年も付ける。bot: periodLabel） */
export function periodLabel(range: { startDate: string; endDate: string }): string {
  const [sy, sm, sd] = range.startDate.split('-').map(Number);
  const [ey, em, ed] = range.endDate.split('-').map(Number);
  return sy === ey ? `${sm}/${sd}〜${em}/${ed}` : `${sy}/${sm}/${sd}〜${ey}/${em}/${ed}`;
}

type SummaryExpense = Pick<Expense, 'amount' | 'category' | 'includeInTotal' | 'status' | 'advanceFull' | 'inputSource' | 'confirmed'>;

/** 折半の対象（bot: isSplitCounted。合計に含み、立替精算済み・立替（全額）でないもの） */
function isSplitCounted(e: SummaryExpense): boolean {
  const fullAdvance = e.status === 'advance_pending' && e.advanceFull === true;
  return e.includeInTotal === true && e.status !== 'advance_settled' && !fullAdvance;
}

/** 要確認（bot: isPendingManual。自動で入った支出は確認不要） */
function isPendingManual(e: SummaryExpense): boolean {
  if (e.inputSource === 'gmail_auto' || e.inputSource === 'recurring') return false;
  return (e.status == null || e.status === 'pending') && e.confirmed !== true;
}

export interface SummaryCategory {
  category: string;
  amount: number;
  /** 合計に占める割合（0〜100。小数 1 桁） */
  percentage: number;
  /** 金額の表示（¥12,345） */
  amountText: string;
}

/** 1 通目（テキスト）の部分。mention は LINE のメンション（@名前）で出す */
export type SummaryTextPart = { text: string } | { mention: string };

export interface DemoSettlementSummary {
  /** 期間の見出し（9/1〜9/30） */
  label: string;
  /** 1 通目（テキスト）。送金する人と受け取る人（送金なしならふたり）をメンションする */
  text: SummaryTextPart[];
  flex: {
    /** 「Aさん  →  Bさん」 */
    people: string;
    amount: string;
    caption: string;
    rows: { label: string; value: string }[];
    /** 区切り線の下の、相手・カード・共通口座の支払い */
    othersRow: { label: string; value: string };
    categories: SummaryCategory[];
    /** 「ほか 2カテゴリ ¥…」（上位に入らなかったカテゴリが無ければ null） */
    others: string | null;
    /** 要確認の注意（無ければ null） */
    pending: string | null;
  };
}

/**
 * 締まった期間の精算サマリー（bot: buildSettlementSummary → buildSettlementSummaryMessages。途中経過ではない、起算日の自動の通知）。
 * split は computePeriodSplit の結果、pool は periodPool の結果（どちらも同じ期間・世帯）。members は世帯のふたり（送金なしのメンションの順）。
 * 本番は LINE の userId をメンションにする。デモの ID は userId の形ではないので、名前を「@名前」で出す。
 */
export function buildDemoSettlementSummary(input: {
  range: { startDate: string; endDate: string };
  members: readonly { lineId: string; displayName: string }[];
  split: PeriodSplit;
  pool: readonly SummaryExpense[];
}): DemoSettlementSummary {
  const { split, pool, members } = input;
  const label = periodLabel(input.range);
  const transfer = split.transfer;
  const nameOf = (lineId: string | undefined) => members.find((m) => m.lineId === lineId)?.displayName || 'メンバー';
  const fromName = nameOf(transfer?.fromLineId);
  const toName = nameOf(transfer?.toLineId);
  const targetName = split.target?.displayName || 'メンバー';
  const counterpartName = split.counterpart?.displayName || 'メンバー';

  // カテゴリ別（折半の対象だけ。割合は合計に対して小数 1 桁）
  const byCategory = new Map<string, number>();
  for (const e of pool.filter(isSplitCounted)) {
    const category = typeof e.category === 'string' && e.category ? e.category : 'その他';
    byCategory.set(category, (byCategory.get(category) ?? 0) + Number(e.amount));
  }
  const sorted = Array.from(byCategory, ([category, amount]) => ({
    category,
    amount,
    percentage: split.total > 0 ? Math.round((amount / split.total) * 1000) / 10 : 0,
    amountText: yen(amount),
  })).sort((a, b) => b.amount - a.amount);
  const rest = sorted.slice(SUMMARY_TOP_CATEGORIES);
  const pending = pool.filter(isPendingManual);
  const pendingAmount = pending.reduce((sum, e) => sum + Number(e.amount), 0);

  const countLabel = [
    `${split.count}件`,
    split.excludedCount > 0 ? `除外${split.excludedCount}件` : '',
    split.settledCount > 0 ? `立替精算済み${split.settledCount}件` : '',
    split.advanceCount > 0 ? `立替${split.advanceCount}件は全額で別` : '',
  ]
    .filter(Boolean)
    .join('・');

  const rows = [
    { label: `合計（${countLabel}）`, value: yen(split.total) },
    { label: SUMMARY_TEXT.half, value: formatYenExact(split.half) },
    { label: `− ${targetName}の支払い`, value: yen(split.targetPaid) },
    ...(split.counterpartAdvanced > 0 ? [{ label: `+ ${counterpartName}の立替（全額）`, value: yen(split.counterpartAdvanced) }] : []),
    ...(split.targetAdvanced > 0 ? [{ label: `− ${targetName}の立替（全額）`, value: yen(split.targetAdvanced) }] : []),
  ];

  return {
    label,
    text: transfer
      ? [
          { text: `${label} の精算（折半）です。\n` },
          { mention: fromName },
          { text: ' から ' },
          { mention: toName },
          { text: ` へ ${yen(transfer.amount)} の送金をお願いします。` },
        ]
      : [
          { mention: members[0]?.displayName || 'メンバー' },
          { text: ' ' },
          { mention: members[1]?.displayName || 'メンバー' },
          { text: `\n${label} の精算（折半）は、今回は送金なしです。` },
        ],
    flex: {
      people: transfer ? `${fromName}  →  ${toName}` : `${targetName}・${counterpartName}`,
      amount: yen(transfer?.amount ?? 0),
      caption: transfer ? `${fromName}が${toName}に送金` : SUMMARY_TEXT.noTransfer,
      rows,
      othersRow: { label: `${counterpartName}・カード・共通口座の支払い`, value: yen(split.total - split.targetPaid) },
      categories: sorted.slice(0, SUMMARY_TOP_CATEGORIES),
      others: rest.length > 0 ? `ほか ${rest.length}カテゴリ ${yen(rest.reduce((sum, c) => sum + c.amount, 0))}` : null,
      pending:
        pending.length > 0 ? `要確認が ${pending.length}件（${yen(pendingAmount)}）あります。確認すると、この期間の合計に入ります` : null,
    },
  };
}
