'use client';

// デモの精算サマリー。毎月の起算日（デモの世帯は 1 日）に LINE グループへ届く、締まった期間の精算（折半）を、スマホの枠のトークで見せる。
// bot と同じく 2 通（メンション付きのテキスト → Flex）。Flex は bot/src/line/settlementSummaryMessage.ts の骨格・色・文言を写したもの
// （文言・色は lib/demo/demoSummary.ts から取る）。数字は本番と同じ computePeriodSplit・periodPool に架空データを通して出す。
import { BellRing, Info, Repeat, Users } from 'lucide-react';
import Link from 'next/link';
import { GlassCard } from '../home/GlassCard';
import { CardIcon } from './LineExpenseCard';
import { BotMessage, DateDivider, LinePhone, Mention, TextBubble } from './LineTalk';
import { computePeriodSplit, periodPool } from '../../lib/periodSplit';
import { DEMO_DEFAULT_MONTH_INDEX, DEMO_EXPENSES, DEMO_HOUSEHOLD_ID, DEMO_MEMBER_A, DEMO_MEMBERS, DEMO_MONTHS } from '../../lib/demo/demoData';
import { DEMO_LINE_GROUP, categoryIconKey, talkDateLabel } from '../../lib/demo/demoLine';
import {
  SUMMARY_COLORS as C,
  SUMMARY_SEND_TIME,
  SUMMARY_TEXT,
  buildDemoSettlementSummary,
  type DemoSettlementSummary,
} from '../../lib/demo/demoSummary';
import { sceneOf } from '../../lib/demo/demoScenes';

const SETTLEMENT_SCENE = sceneOf('settlement');
const EXPENSES_SCENE = sceneOf('expenses');

// 締まった期間（基準月の前の月）を、基準月の起算日（1 日）に送る。集金するメンバーは Aさん（デモの精算の既定と同じ）
const PERIOD = DEMO_MONTHS[DEMO_DEFAULT_MONTH_INDEX - 1];
const SENT_ON = DEMO_MONTHS[DEMO_DEFAULT_MONTH_INDEX].range.startDate;
const SUMMARY = buildDemoSettlementSummary({
  range: PERIOD.range,
  members: DEMO_MEMBERS,
  split: computePeriodSplit({
    expenses: DEMO_EXPENSES,
    groupId: DEMO_HOUSEHOLD_ID,
    members: DEMO_MEMBERS,
    targetLineId: DEMO_MEMBER_A,
    range: PERIOD.range,
  }),
  pool: periodPool(DEMO_EXPENSES, DEMO_HOUSEHOLD_ID, PERIOD.range),
});

// Flex の大きさ（px）: 文字 xxs 11 / xs 13 / sm 14 / md 16 / 3xl 35、余白 xs 2 / sm 4 / md 8 / lg 12 / xl 16、幅は mega の 300
function SummaryBubble({ summary }: { summary: DemoSettlementSummary }) {
  const { flex } = summary;
  return (
    <div className="w-[300px] max-w-full overflow-hidden rounded-[18px] bg-white text-left shadow-sm">
      <div className="p-3" style={{ backgroundColor: C.headerBg }}>
        <p className="flex items-center gap-1">
          <CardIcon iconKey={SUMMARY_TEXT.headerIconKey} size={19} />
          <span className="text-[16px] font-bold" style={{ color: C.accent }}>
            {SUMMARY_TEXT.header}
          </span>
        </p>
        <p className="mt-0.5 text-[14px] font-bold tabular-nums" style={{ color: C.accentDeep }}>
          {summary.label}
        </p>
      </div>

      <div className="p-3">
        <div className="text-center">
          <p className="whitespace-pre-wrap text-[14px]" style={{ color: C.sub }}>
            {flex.people}
          </p>
          <p className="mt-1 text-[35px] font-bold leading-tight tabular-nums" style={{ color: C.text }}>
            {flex.amount}
          </p>
          <p className="mt-0.5 text-[13px]" style={{ color: C.muted }}>
            {flex.caption}
          </p>
        </div>

        <div className="mt-4 rounded-xl p-2" style={{ backgroundColor: C.panel }}>
          {flex.rows.map((row) => (
            <div key={row.label} className="mt-1 flex gap-2 first:mt-0">
              <span className="min-w-0 flex-1 text-[13px]" style={{ color: C.sub }}>
                {row.label}
              </span>
              <span className="shrink-0 text-[13px] font-bold tabular-nums" style={{ color: C.text }}>
                {row.value}
              </span>
            </div>
          ))}
          <hr className="my-2 border-0 border-t" style={{ borderColor: C.track }} />
          <div className="flex gap-2">
            <span className="min-w-0 flex-1 text-[13px]" style={{ color: C.muted }}>
              {flex.othersRow.label}
            </span>
            <span className="shrink-0 text-[13px] tabular-nums" style={{ color: C.muted }}>
              {flex.othersRow.value}
            </span>
          </div>
        </div>

        {flex.categories.length > 0 && (
          <>
            <hr className="mt-4 border-0 border-t border-[#dddddd]" />
            <p className="mt-3 text-[13px] font-bold" style={{ color: C.muted }}>
              {SUMMARY_TEXT.categories}
            </p>
            {flex.categories.map((c) => (
              <div key={c.category} className="mt-2 flex items-center gap-2">
                <CardIcon iconKey={categoryIconKey(c.category)} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center">
                    <span className="min-w-0 flex-1 text-[14px]" style={{ color: C.text }}>
                      {c.category}
                    </span>
                    <span className="ml-1 text-[11px] tabular-nums" style={{ color: C.muted }}>
                      {c.percentage}%
                    </span>
                    <span className="ml-2 text-[14px] font-bold tabular-nums" style={{ color: C.text }}>
                      {c.amountText}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: C.track }}>
                    <div
                      className="h-full rounded-full"
                      style={{ backgroundColor: C.accent, width: `${Math.max(2, Math.min(100, Math.round(c.percentage)))}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
            {flex.others && (
              <p className="mt-2 text-right text-[11px] tabular-nums" style={{ color: C.muted }}>
                {flex.others}
              </p>
            )}
          </>
        )}

        {flex.pending && (
          <p className="mt-3 rounded-[10px] p-2 text-[13px]" style={{ backgroundColor: C.warnBg, color: C.warnText }}>
            {flex.pending}
          </p>
        )}
      </div>

      <div className="flex gap-1 p-2">
        <Link
          href={SETTLEMENT_SCENE.href}
          className="flex h-10 flex-1 items-center justify-center rounded-md text-[14px] font-medium text-white transition-opacity hover:opacity-85"
          style={{ backgroundColor: C.accent }}
        >
          {SUMMARY_TEXT.openSettlement}
        </Link>
        <Link
          href={EXPENSES_SCENE.href}
          className="flex h-10 flex-1 items-center justify-center rounded-md bg-[#F1F5F9] text-[14px] font-medium text-[#111111] transition-opacity hover:opacity-85"
        >
          {SUMMARY_TEXT.openExpenses}
        </Link>
      </div>
    </div>
  );
}

const POINTS = [
  { Icon: BellRing, title: '起算日に 1 回だけ届く', body: `期間の起算日（この世帯は毎月 1 日）の ${SUMMARY_SEND_TIME} に、締まった期間の分を送る。同じ期間は 2 回送らない` },
  { Icon: Repeat, title: 'Web の精算と同じ計算', body: '合計を折半し、立替（全額）を足し引きする。カテゴリ別は上位 5 つ、残りは「ほか」にまとめる' },
  { Icon: Users, title: 'ふたりをメンションする', body: '送金する人と受け取る人に通知が届く（デモでは名前を @ で出しています）' },
] as const;

export default function LineSettlementSummary() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start">
      <LinePhone title={DEMO_LINE_GROUP.name} memberCount={DEMO_LINE_GROUP.memberCount} clock={SUMMARY_SEND_TIME}>
        <DateDivider label={talkDateLabel(SENT_ON)} />
        <BotMessage time={SUMMARY_SEND_TIME}>
          <TextBubble>
            {SUMMARY.text.map((part, i) => ('mention' in part ? <Mention key={i} name={part.mention} /> : <span key={i}>{part.text}</span>))}
          </TextBubble>
        </BotMessage>
        <BotMessage time={SUMMARY_SEND_TIME}>
          <SummaryBubble summary={SUMMARY} />
        </BotMessage>
      </LinePhone>

      <GlassCard className="p-5">
        <h2 className="text-base font-semibold text-fg">毎月、精算が LINE に届く</h2>
        <p className="mt-1 text-sm text-muted">
          {PERIOD.title}（{SUMMARY.label}）の精算が、{talkDateLabel(SENT_ON)} に LINE グループへ届いたところです。
        </p>
        <ul className="mt-4 space-y-3">
          {POINTS.map(({ Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{title}</span>
                <span className="block text-xs text-muted">{body}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-line/70 bg-fg/[0.03] p-3 text-xs text-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          精算の画面で {PERIOD.title} に切り替えると、同じ金額になります。カードの「{SUMMARY_TEXT.openSettlement}」「{SUMMARY_TEXT.openExpenses}」は、デモの画面へ移ります。
        </p>
      </GlassCard>
    </div>
  );
}
