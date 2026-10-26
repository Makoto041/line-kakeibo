import type { Metadata } from 'next';
import DemoClientOnly from '@/components/demo/DemoClientOnly';
import LineChat from '@/components/demo/LineChat';

export const metadata: Metadata = {
  title: 'LINE',
};

export default function DemoLinePage() {
  return (
    <DemoClientOnly>
      <LineChat />
    </DemoClientOnly>
  );
}
