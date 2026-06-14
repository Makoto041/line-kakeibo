import { Suspense } from 'react';
import LinkClientPage from './LinkClientPage';

export default function Page() {
  return (
    <Suspense fallback={
      <div className="flex min-h-dvh items-center justify-center">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    }>
      <LinkClientPage />
    </Suspense>
  );
}