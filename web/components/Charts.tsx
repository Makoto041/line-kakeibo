'use client';

import * as Recharts from 'recharts';
import dayjs from 'dayjs';
import { getCategoryVisual } from '../lib/categoryVisuals';

/* eslint-disable @typescript-eslint/no-explicit-any */
// recharts + React 19 の JSX 型不整合(TS2786)を回避するためのキャスト。
const {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
} = Recharts as unknown as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

const yen = (v: number) => `¥${Number(v).toLocaleString()}`;

/* ----------------------------- Category donut ---------------------------- */
interface CategoryPieChartProps {
  data: Record<string, number>;
}

export function CategoryPieChart({ data }: CategoryPieChartProps) {
  const rows = Object.entries(data)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value, color: getCategoryVisual(name).hex }))
    .sort((a, b) => b.value - a.value);

  const total = rows.reduce((s, r) => s + r.value, 0);

  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-muted">データがありません</p>;
  }

  return (
    <div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={56}
              outerRadius={84}
              paddingAngle={2}
              stroke="none"
            >
              {rows.map((r) => (
                <Cell key={r.name} fill={r.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number, name: string) => [yen(value), name]}
              contentStyle={{
                borderRadius: 12,
                border: '1px solid rgb(var(--border))',
                background: 'rgb(var(--card))',
                color: 'rgb(var(--fg))',
                fontSize: 12,
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-3 space-y-1.5">
        {rows.slice(0, 6).map((r) => {
          const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
          return (
            <li key={r.name} className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="truncate text-fg">{r.name}</span>
              <span className="ml-auto tabular-nums text-muted">{yen(r.value)}</span>
              <span className="w-9 text-right tabular-nums text-xs text-muted">{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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
