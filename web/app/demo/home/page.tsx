import type { Metadata } from 'next';
import DemoClientOnly from '@/components/demo/DemoClientOnly';
import DemoHome from '@/components/demo/DemoHome';

export const metadata: Metadata = {
  title: 'ホーム',
};

export default function DemoHomePage() {
  return (
    <DemoClientOnly>
      <DemoHome />
    </DemoClientOnly>
  );
}
