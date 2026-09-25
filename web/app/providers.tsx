'use client';

import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { PeriodProvider } from '@/components/period/PeriodProvider';
import { ToastProvider } from '@/components/ui/Toast';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <PeriodProvider>{children}</PeriodProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
