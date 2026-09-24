import { House, Users } from "lucide-react";
import { DocLines, DocLinesFilled, HouseFilled, UsersFilled, type AnyIcon } from "@/components/ui/icons";
import { T } from "@/lib/uiText";

export interface NavItem {
  path: string;
  label: string;
  /** 未選択（線画） */
  Icon: AnyIcon;
  /** 選択中（塗り） */
  ActiveIcon: AnyIcon;
}

// 下部ナビは 3 つだけ（4 つ目のタブや＋ボタンは置かない）。設定はホームの歯車から開く。
export const NAV_ITEMS: NavItem[] = [
  { path: "/", label: T.nav.home, Icon: House, ActiveIcon: HouseFilled },
  { path: "/expenses", label: T.nav.expenses, Icon: DocLines, ActiveIcon: DocLinesFilled },
  { path: "/futari", label: T.nav.futari, Icon: Users, ActiveIcon: UsersFilled },
];

export function isActivePath(pathname: string, itemPath: string): boolean {
  if (itemPath === "/") return pathname === "/";
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}
