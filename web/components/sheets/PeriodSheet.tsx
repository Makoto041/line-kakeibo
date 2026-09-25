'use client';

// 期間シート（ホームの月ラベル、明細・ふたりの月ピルから開く）。
// [‹][正確な期間][›]、起算日、今月へ戻る、期間の設定（設定シートの期間タブへ）。期間指定では前後に動かさない。
import dayjs from 'dayjs';
import { CalendarCog, CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { T } from '@/lib/uiText';
import { usePeriod } from '@/components/period/PeriodProvider';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { NavRow } from '@/components/ui/Rows';

interface PeriodSheetProps {
  open: boolean;
  onClose: () => void;
  /** 「期間の設定」（設定シートの期間タブを開く） */
  onOpenSettings: () => void;
}

export function PeriodSheet({ open, onClose, onOpenSettings }: PeriodSheetProps) {
  const { title, range, dateSettings, canShift, shift, goToday } = usePeriod();
  const today = dayjs().format('YYYY-MM-DD');
  const inCurrent = range.startDate <= today && today <= range.endDate;
  const startDay = dateSettings.customStartDay || 1;
  const showStartDay = dateSettings.mode !== 'custom' && startDay > 1;

  return (
    <Sheet open={open} onClose={onClose} title={T.sheet.period}>
      <div className="grid grid-cols-[48px_minmax(0,1fr)_48px] items-center gap-2 pt-1">
        <IconButton
          label={T.aria.prevMonth}
          icon={ChevronLeft}
          iconSize={24}
          strokeWidth={2.25}
          disabled={!canShift}
          onClick={() => shift(-1)}
        />
        <p className="text-center text-[16px] font-semibold text-ink" aria-live="polite">
          {title}
        </p>
        <IconButton
          label={T.aria.nextMonth}
          icon={ChevronRight}
          iconSize={24}
          strokeWidth={2.25}
          disabled={!canShift}
          onClick={() => shift(1)}
        />
      </div>
      {showStartDay && <p className="mt-1.5 text-center text-[13px] text-ink-4">{T.sheet.startDay(startDay)}</p>}

      <div className="mt-5">
        <PrimaryButton
          variant="soft"
          height={44}
          icon={CalendarDays}
          disabled={!canShift || inCurrent}
          onClick={goToday}
        >
          {T.sheet.thisPeriod}
        </PrimaryButton>
      </div>

      <div className="mt-3">
        <NavRow icon={CalendarCog} label={T.sheet.periodSettings} onClick={onOpenSettings} />
      </div>
    </Sheet>
  );
}
