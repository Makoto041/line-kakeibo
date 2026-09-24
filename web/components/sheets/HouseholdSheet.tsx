'use client';

// 世帯シート（ホームの「ふたり」ピルから開く）。世帯名とメンバー（頭文字の丸＋表示名）。読み取りのみ。
import { RotateCw } from 'lucide-react';
import type { HouseholdInfo } from '@/lib/hooks';
import { initialsFor } from '@/lib/settlementView';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { SheetSection } from '@/components/ui/Rows';
import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton';

interface HouseholdSheetProps {
  open: boolean;
  onClose: () => void;
  household: HouseholdInfo['household'];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function HouseholdSheet({ open, onClose, household, loading, error, onRetry }: HouseholdSheetProps) {
  const members = household?.members ?? [];
  const initials = initialsFor(members.map((m) => m.displayName));

  return (
    <Sheet open={open} onClose={onClose} title={household?.name || T.sheet.household}>
      {loading && !household ? (
        <SkeletonGroup className="space-y-3 py-2">
          <Skeleton className="h-14 rounded-2xl" />
          <Skeleton className="h-14 rounded-2xl" />
        </SkeletonGroup>
      ) : error && !household ? (
        <div className="flex justify-center py-6">
          <IconButton label={T.aria.retry} icon={RotateCw} onClick={onRetry} />
        </div>
      ) : (
        <SheetSection title={T.sheet.members}>
          <ul>
            {members.map((m, i) => (
              <li
                key={m.lineId}
                className="flex min-h-[64px] items-center gap-4 border-b border-divider px-1 last:border-b-0"
              >
                <Avatar size={40} initial={initials[i]} tone={i % 2 === 0 ? 'a' : 'b'} />
                <span className="min-w-0 flex-1 truncate text-kb-row text-ink">{m.displayName || initials[i]}</span>
              </li>
            ))}
          </ul>
        </SheetSection>
      )}
    </Sheet>
  );
}
