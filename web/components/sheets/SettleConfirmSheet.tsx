'use client';

// 精算を記録する前の確認シート（取り消せない操作なので 1 段挟む）。
// [払う人] → [受け取る人] / 金額 / N件 / 精算を記録 / キャンセル。
// 押している間に内容が変わっていたら（サーバーの 409 stale）、ページが最新の内容に差し替え、もう一度押してもらう。
import { CircleCheck, MoveRight } from 'lucide-react';
import type { SettlementPerson, SettlementViewModel } from '@/lib/settlementView';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { Amount } from '@/components/ui/Amount';
import { Avatar } from '@/components/ui/Avatar';
import { PrimaryButton } from '@/components/ui/PrimaryButton';

interface SettleConfirmSheetProps {
  open: boolean;
  onClose: () => void;
  vm: SettlementViewModel;
  settling: boolean;
  onConfirm: () => void;
}

export function SettleConfirmSheet({ open, onClose, vm, settling, onConfirm }: SettleConfirmSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} closeDisabled={settling} title={T.futari.settle}>
      <div className="pb-2">
        <div className="flex items-start justify-center gap-[18px] pt-2">
          <Person person={vm.left} />
          <MoveRight
            size={28}
            strokeWidth={1.75}
            aria-hidden="true"
            className={cx('mt-[26px] shrink-0 text-ink', vm.idle && 'opacity-40')}
          />
          <Person person={vm.right} dim={vm.idle} />
        </div>
        <div className="mt-4 text-center">
          <Amount value={vm.amount} base={44} className="text-ink" />
        </div>
        <p className="mt-1 text-center text-kb-sub text-ink-3">{T.futari.count(vm.count)}</p>

        <div className="mt-6 space-y-3">
          <PrimaryButton icon={CircleCheck} loading={settling} disabled={!vm.canSettle} onClick={onConfirm}>
            {T.futari.settle}
          </PrimaryButton>
          <PrimaryButton variant="soft" height={56} icon={null} disabled={settling} onClick={onClose}>
            {T.futari.cancel}
          </PrimaryButton>
        </div>
      </div>
    </Sheet>
  );
}

function Person({ person, dim = false }: { person: SettlementPerson | null; dim?: boolean }) {
  return (
    <div className="flex w-24 flex-col items-center gap-2">
      <Avatar initial={person?.initial ?? ''} tone={person?.tone ?? 'neutral'} dim={dim || !person} />
      {person?.name && <span className="max-w-full truncate text-kb-caption text-ink-2">{person.name}</span>}
    </div>
  );
}
