import type { Metadata } from 'next';
import DemoClientOnly from '@/components/demo/DemoClientOnly';
import LineSettlementSummary from '@/components/demo/LineSettlementSummary';

export const metadata: Metadata = {
  title: '精算サマリー',
};

export default function DemoSettlementSummaryPage() {
  return (
    <DemoClientOnly>
      <LineSettlementSummary />
    </DemoClientOnly>
  );
}
