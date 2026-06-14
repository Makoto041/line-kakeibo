import { Home, Receipt, Settings, type LucideIcon } from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  Icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "ホーム", Icon: Home },
  { path: "/expenses", label: "支出", Icon: Receipt },
  { path: "/settings", label: "設定", Icon: Settings },
];

export function isActivePath(pathname: string, itemPath: string): boolean {
  if (itemPath === "/") return pathname === "/";
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}
