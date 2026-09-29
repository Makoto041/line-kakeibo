import type { LucideIcon } from 'lucide-react';
import { GlassCard } from './GlassCard';

export function SummaryCard({
  label,
  value,
  Icon,
  tone,
}: {
  label: string;
  value: string;
  Icon: LucideIcon;
  tone: string;
}) {
  return (
    <GlassCard className="p-4">
      <span className={`inline-grid h-9 w-9 place-items-center rounded-xl ${tone}`}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={2.1} />
      </span>
      <p className="mt-3 text-[11px] font-medium text-muted">{label}</p>
      <p className="mt-0.5 text-xl font-bold tracking-tight text-fg tabular-nums">{value}</p>
    </GlassCard>
  );
}
