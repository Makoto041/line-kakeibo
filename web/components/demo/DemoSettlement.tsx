'use client';

// デモの精算。本番の精算（PeriodSplitCard）の表示部分 PeriodSplitView に、架空データを渡す。
// 送金する人の切り替えはこの画面の状態だけを変える（保存しない）。期間は月ごとに同じ range のオブジェクトを渡す
// （View は range の参照で計算を使い回す）。右（モバイルでは下）に、精算の考え方を短く図で出す。
import { useMemo, useState } from 'react';
import { ArrowRightLeft, Ban, Clock, CreditCard, Users, type LucideIcon } from 'lucide-react';
import PeriodSplitView from '../PeriodSplitView';
import { GlassCard } from '../home/GlassCard';
import { computePeriodSplit } from '../../lib/periodSplit';
import { yen } from '../../lib/money';
import {
  DEMO_DEFAULT_MONTH_INDEX,
  DEMO_EXPENSES,
  DEMO_HOUSEHOLD_ID,
  DEMO_MEMBER_A,
  DEMO_MEMBERS,
  DEMO_MONTHS,
} from '../../lib/demo/demoData';

const RULES: ReadonlyArray<{ Icon: LucideIcon; title: string; body: string }> = [
  { Icon: Users, title: '世帯はふたり', body: '合計に入る支出を ÷2 して、ひとりあたりの負担にする' },
  { Icon: CreditCard, title: '支払った人で分ける', body: 'Aさん・Bさん・カード・共通口座。カードと共通口座は、受け取る人の側に数える' },
  { Icon: ArrowRightLeft, title: '立替（全額）', body: '相手の分を立て替えた支出は折半せず、全額を返す' },
  { Icon: Ban, title: '除外', body: '個人の支出（合計から除外）は精算に入れない' },
  { Icon: Clock, title: '要確認', body: 'LINE で入れた支出は、確認するまで合計に入らない' },
];

function SplitBar({ target, range }: { target: string; range: (typeof DEMO_MONTHS)[number]['range'] }) {
  const split = useMemo(
    () => computePeriodSplit({ expenses: DEMO_EXPENSES, groupId: DEMO_HOUSEHOLD_ID, members: DEMO_MEMBERS, targetLineId: target, range }),
    [target, range]
  );
  if (!split.target || !split.counterpart || split.total <= 0) return null;
  const mine = Math.min(100, Math.max(0, (split.targetPaid / split.total) * 100));
  return (
    <div className="mt-4 rounded-xl border border-line/70 bg-fg/[0.02] p-3">
      <p className="text-xs font-medium text-fg">合計 {yen(split.total, 'ja-JP')} を、ふたりの支払いで並べると</p>
      <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-sky-500/25">
        <div className="h-full rounded-full bg-accent" style={{ width: `${mine}%` }} />
        <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-fg/70" aria-hidden />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] leading-snug tabular-nums">
        <div>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent align-middle" />
          <span className="text-muted">{split.target.displayName}の支払い</span>
          <b className="block text-fg">{yen(split.targetPaid, 'ja-JP')}</b>
        </div>
        <div className="text-center">
          <span className="text-muted">半分</span>
          <b className="block text-fg">{yen(Math.round(split.half), 'ja-JP')}</b>
        </div>
        <div className="text-right">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500/50 align-middle" />
          <span className="text-muted">{split.counterpart.displayName}・カード・共通口座</span>
          <b className="block text-fg">{yen(split.total - split.targetPaid, 'ja-JP')}</b>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        半分との差を送金して、ふたりの負担をそろえる（立替（全額）はこのあと足し引きする）
      </p>
    </div>
  );
}

export default function DemoSettlement() {
  const [monthIndex, setMonthIndex] = useState(DEMO_DEFAULT_MONTH_INDEX);
  const [target, setTarget] = useState<string>(DEMO_MEMBER_A);
  const month = DEMO_MONTHS[monthIndex];

  return (
    <div className="grid gap-4 lg:grid-cols-5 lg:items-start">
      <div className="lg:col-span-3">
        <PeriodSplitView
          expenses={DEMO_EXPENSES}
          groupId={DEMO_HOUSEHOLD_ID}
          members={DEMO_MEMBERS}
          target={target}
          range={month.range}
          periodTitle={month.title}
          onPrevPeriod={monthIndex > 0 ? () => setMonthIndex((i) => i - 1) : undefined}
          onNextPeriod={monthIndex < DEMO_MONTHS.length - 1 ? () => setMonthIndex((i) => i + 1) : undefined}
          canSave
          onChoose={setTarget}
        />
      </div>

      <GlassCard className="p-5 lg:col-span-2">
        <h2 className="text-sm font-semibold text-fg">精算の考え方</h2>
        <ul className="mt-3 space-y-2.5">
          {RULES.map(({ Icon, title, body }) => (
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
        <SplitBar target={target} range={month.range} />
      </GlassCard>
    </div>
  );
}
