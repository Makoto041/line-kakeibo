import type React from 'react';

export function GlassCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`glass rounded-2xl shadow-glass ${className}`}>{children}</div>;
}
