import { BellRing, HandCoins, LayoutDashboard, ListChecks, Mail, MessageCircle, Presentation, type LucideIcon } from 'lucide-react';

// デモの場面（lib/demo/demoScenes.ts の key）のアイコン。無いものは既定のアイコン
const ICONS: Record<string, LucideIcon> = {
  line: MessageCircle,
  gmail: Mail,
  home: LayoutDashboard,
  expenses: ListChecks,
  settlement: HandCoins,
  'settlement-summary': BellRing,
};

export function sceneIcon(key: string): LucideIcon {
  return Object.prototype.hasOwnProperty.call(ICONS, key) ? ICONS[key] : Presentation;
}
