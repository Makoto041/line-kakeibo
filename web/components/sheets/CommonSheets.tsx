'use client';

// 3 タブで共通のシート（期間・設定・世帯・ゲスト）。ページは「今開いているシート」を 1 つの state で持ち、
// シートどうしは入れ子にせず差し替える（期間 → 期間の設定 → 戻る）。
import { useState } from 'react';
import type { HouseholdInfo } from '@/lib/hooks';
import type { SettingsTab } from '@/components/settings/SettingsPanel';
import { PeriodSheet } from './PeriodSheet';
import { SettingsSheet } from './SettingsSheet';
import { HouseholdSheet } from './HouseholdSheet';
import { GuestSheet } from './GuestSheet';

export type CommonSheet =
  | { kind: 'period' }
  | { kind: 'settings'; tab: SettingsTab; from?: 'period' }
  | { kind: 'household' }
  | { kind: 'guest' };

export function useCommonSheet() {
  const [sheet, setSheet] = useState<CommonSheet | null>(null);
  return { sheet, setSheet };
}

interface CommonSheetsProps {
  sheet: CommonSheet | null;
  setSheet: (sheet: CommonSheet | null) => void;
  /** 世帯シートの中身（ページが持つ useHousehold の結果） */
  household?: {
    household: HouseholdInfo['household'];
    loading: boolean;
    error: string | null;
    refetch: () => void;
  };
  /** 設定を保存したあと（予算の読み直しなど） */
  onSettingsSaved?: () => void;
}

export function CommonSheets({ sheet, setSheet, household, onSettingsSaved }: CommonSheetsProps) {
  const close = () => setSheet(null);
  const settings = sheet?.kind === 'settings' ? sheet : null;

  return (
    <>
      <PeriodSheet
        open={sheet?.kind === 'period'}
        onClose={close}
        onOpenSettings={() => setSheet({ kind: 'settings', tab: 'period', from: 'period' })}
      />
      <SettingsSheet
        open={!!settings}
        onClose={close}
        initialTab={settings?.tab ?? 'budget'}
        onBack={settings?.from === 'period' ? () => setSheet({ kind: 'period' }) : undefined}
        onSaved={onSettingsSaved}
      />
      {household && (
        <HouseholdSheet
          open={sheet?.kind === 'household'}
          onClose={close}
          household={household.household}
          loading={household.loading}
          error={household.error}
          onRetry={household.refetch}
        />
      )}
      <GuestSheet open={sheet?.kind === 'guest'} onClose={close} />
    </>
  );
}
