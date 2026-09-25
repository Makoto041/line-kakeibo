'use client';

// 内訳シート（ふたりの「内訳 ›」から開く）。未精算の立替を立替者ごとに、合計と明細（日付・内容・金額）で並べる。
import dayjs from 'dayjs';
import type { SettlementResponse } from '@/lib/householdContract';
import { groupSettlementItems, initialsFor } from '@/lib/settlementView';
import { absoluteDateLabel } from '@/lib/expenseState';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { Amount } from '@/components/ui/Amount';
import { Avatar } from '@/components/ui/Avatar';
import { ExpenseIcon } from '@/components/expense/ExpenseIcon';

interface BreakdownSheetProps {
  open: boolean;
  onClose: () => void;
  data: SettlementResponse | null;
  /** 応答の名前が空のときに補う名前（世帯のメンバー） */
  fallbackNames?: Readonly<Record<string, string>>;
}

export function BreakdownSheet({ open, onClose, data, fallbackNames }: BreakdownSheetProps) {
  const groups = data ? groupSettlementItems(data, fallbackNames) : [];
  // 頭文字はカードと同じ規則で、関係者全員を並べて決める（重なれば 2 文字）
  const people = [
    ...(data?.members ?? []).map((m) => ({
      id: m.lineId,
      name: m.displayName.trim() || fallbackNames?.[m.lineId]?.trim() || '',
    })),
    ...groups.filter((g) => !data?.members.some((m) => m.lineId === g.lineId)).map((g) => ({ id: g.lineId, name: g.name })),
  ];
  const initialOf = new Map(initialsFor(people.map((p) => p.name)).map((initial, i) => [people[i].id, initial]));
  const memberIndex = new Map((data?.members ?? []).map((m, i) => [m.lineId, i]));
  const today = dayjs().format('YYYY-MM-DD');

  return (
    <Sheet open={open} onClose={onClose} title={T.futari.breakdown}>
      <div className="pb-2">
        {groups.map((group, gi) => {
          const index = memberIndex.get(group.lineId);
          const tone = index === 0 ? 'a' : index === 1 ? 'b' : 'neutral';
          return (
            <section key={group.lineId || `unknown-${gi}`} className="mt-5 first:mt-1">
              <div className="flex min-h-[56px] items-center gap-3 px-1">
                <Avatar initial={initialOf.get(group.lineId) ?? '?'} tone={tone} size={40} />
                <span className="min-w-0 flex-1 truncate text-kb-row text-ink">{group.name || initialOf.get(group.lineId)}</span>
                <Amount value={group.total} base={24} className="shrink-0 text-ink" />
              </div>
              <ul className="mt-1">
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex min-h-[56px] items-center gap-3 border-t border-divider px-1"
                  >
                    <ExpenseIcon description={item.description} category={item.category} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[16px] font-medium text-ink">
                        {item.description || item.category}
                      </span>
                      <span className="block text-kb-caption text-ink-4">{absoluteDateLabel(item.date, today)}</span>
                    </span>
                    <Amount value={item.amount} base={22} weight={600} className="shrink-0 text-ink" />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Sheet>
  );
}
