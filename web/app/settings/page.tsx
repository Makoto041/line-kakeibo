'use client';

// 設定の単独ページ（ブックマーク用に残す）。中身はホームの設定シートと同じ SettingsPanel。
import { T } from '@/lib/uiText';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { SettingsPanel } from '@/components/settings/SettingsPanel';

export default function SettingsPage() {
  return (
    <>
      <ScreenHeader title={T.settings.title} />
      <div className="px-4 pt-6">
        <div className="kb-card rounded-kb-card px-4 pb-4 pt-4">
          <SettingsPanel variant="page" />
        </div>
      </div>
    </>
  );
}
