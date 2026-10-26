import type { Metadata } from 'next';
import DemoClientOnly from '@/components/demo/DemoClientOnly';
import DemoSettlement from '@/components/demo/DemoSettlement';

export const metadata: Metadata = {
  title: '精算',
};

export default function DemoSettlementPage() {
  return (
    <DemoClientOnly>
      <DemoSettlement />
    </DemoClientOnly>
  );
}
