import { HandCoins, LayoutDashboard, ListChecks, Presentation, type LucideIcon } from 'lucide-react';

// デモの場面（lib/demo/demoScenes.ts の key）のアイコン。無いものは既定のアイコン
const ICONS: Record<string, LucideIcon> = {
  home: LayoutDashboard,
  expenses: ListChecks,
  settlement: HandCoins,
};

export function sceneIcon(key: string): LucideIcon {
  return Object.prototype.hasOwnProperty.call(ICONS, key) ? ICONS[key] : Presentation;
}
