import type { Metadata } from 'next';
import DemoClientOnly from '@/components/demo/DemoClientOnly';
import GmailFlow from '@/components/demo/GmailFlow';

export const metadata: Metadata = {
  title: 'Gmail 自動取込',
};

export default function DemoGmailPage() {
  return (
    <DemoClientOnly>
      <GmailFlow />
    </DemoClientOnly>
  );
}
