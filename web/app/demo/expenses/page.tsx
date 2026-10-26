import type { Metadata } from 'next';
import { Suspense } from 'react';
import DemoClientOnly from '@/components/demo/DemoClientOnly';
import DemoExpenses from '@/components/demo/DemoExpenses';

export const metadata: Metadata = {
  title: '支出一覧',
};

// DemoExpenses は ?filter= を useSearchParams で読むので Suspense で包む
export default function DemoExpensesPage() {
  return (
    <Suspense fallback={null}>
      <DemoClientOnly>
        <DemoExpenses />
      </DemoClientOnly>
    </Suspense>
  );
}
