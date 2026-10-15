'use client';

import * as Recharts from 'recharts';
import dayjs from 'dayjs';
import { yen } from '../lib/money';

/* eslint-disable @typescript-eslint/no-explicit-any */
// recharts + React 19 の JSX 型不整合(TS2786)を回避するためのキャスト。
const {
  ResponsiveContainer,
  Tooltip,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
} = Recharts as unknown as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ------------------------------ Daily trend ------------------------------ */
interface DailyLineChartProps {
  data: Record<string, number>;
  startDate: string;
  endDate: string;
  mode: 'monthly' | 'custom' | 'customStart';
}

export function DailyLineChart({ data, startDate, endDate, mode }: DailyLineChartProps) {
  const start = dayjs(startDate);
  const end = dayjs(endDate);

  const series: { label: string; value: number }[] = [];
  let cur = start;
  while (cur.isBefore(end) || cur.isSame(end, 'day')) {
    const key = cur.format('YYYY-MM-DD');
    const label = mode === 'monthly' ? `${cur.date()}` : `${cur.month() + 1}/${cur.date()}`;
    series.push({ label, value: data[key] || 0 });
    cur = cur.add(1, 'day');
  }

  const hasData = series.some((s) => s.value > 0);
  if (!hasData) {
    return <p className="py-10 text-center text-sm text-muted">この期間の支出はありません</p>;
  }

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <defs>
            <linearGradient id="dailyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity={0.35} />
              <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: 'rgb(var(--muted))' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'rgb(var(--muted))' }}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)}
          />
          <Tooltip
            formatter={(value: number) => [yen(value), '支出']}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid rgb(var(--border))',
              background: 'rgb(var(--card))',
              color: 'rgb(var(--fg))',
              fontSize: 12,
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="rgb(var(--accent))"
            strokeWidth={2}
            fill="url(#dailyFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
