'use client';

// ゲスト案内シート（ゲストのときヘッダーに出る「ゲスト」ピルから開く）。
// 長い案内（プレビューの説明・使い方・コマンド）はメイン画面に出さず、ここにだけ置く。
import { T } from '@/lib/uiText';
import { Sheet } from '@/components/ui/Sheet';
import PreviewModeBanner from '@/components/PreviewModeBanner';
import GuestGuide from '@/components/GuestGuide';

export function GuestSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={T.sheet.guest}>
      <div className="pt-1">
        <PreviewModeBanner />
        <GuestGuide className="mt-6" />
      </div>
    </Sheet>
  );
}
