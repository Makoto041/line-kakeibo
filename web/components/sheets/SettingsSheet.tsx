'use client';

// 設定シート（ホームの歯車、期間シートの「期間の設定」から開く）。中身は /settings と同じ SettingsPanel。
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import { SettingsPanel, type SettingsTab } from '@/components/settings/SettingsPanel';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
  /** 期間シートから来たときの戻る */
  onBack?: () => void;
  /** 保存に成功したあと（ホームの予算を読み直すなど）。シートは閉じる */
  onSaved?: () => void;
}

export function SettingsSheet({ open, onClose, initialTab = 'budget', onBack, onSaved }: SettingsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} onBack={onBack} title={T.settings.title}>
      <SettingsPanel
        initialTab={initialTab}
        onSaved={() => {
          onSaved?.();
          onClose();
        }}
      />
    </Sheet>
  );
}
