import {
  Utensils,
  Bus,
  ShoppingBag,
  Gamepad2,
  Shirt,
  HeartPulse,
  GraduationCap,
  Lightbulb,
  Home,
  ShieldCheck,
  Landmark,
  Sparkles,
  Smartphone,
  RefreshCw,
  Gift,
  Plane,
  PawPrint,
  PiggyBank,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { normalizeCategoryName } from "./categoryNormalization";

export interface CategoryVisual {
  icon: LucideIcon;
  /** text color class */
  fg: string;
  /** soft background chip class */
  bg: string;
  /** solid dot / chart color class */
  dot: string;
  /** hex for charts (recharts needs raw colors) */
  hex: string;
}

// Canonical category name -> icon + color tokens.
// Class strings are written in full so Tailwind's JIT keeps them.
const VISUALS: Record<string, CategoryVisual> = {
  食費: { icon: Utensils, fg: "text-orange-600", bg: "bg-orange-100 dark:bg-orange-500/15", dot: "bg-orange-500", hex: "#f97316" },
  交通費: { icon: Bus, fg: "text-sky-600", bg: "bg-sky-100 dark:bg-sky-500/15", dot: "bg-sky-500", hex: "#0ea5e9" },
  日用品: { icon: ShoppingBag, fg: "text-amber-600", bg: "bg-amber-100 dark:bg-amber-500/15", dot: "bg-amber-500", hex: "#f59e0b" },
  娯楽: { icon: Gamepad2, fg: "text-fuchsia-600", bg: "bg-fuchsia-100 dark:bg-fuchsia-500/15", dot: "bg-fuchsia-500", hex: "#d946ef" },
  衣服: { icon: Shirt, fg: "text-pink-600", bg: "bg-pink-100 dark:bg-pink-500/15", dot: "bg-pink-500", hex: "#ec4899" },
  "医療・健康": { icon: HeartPulse, fg: "text-rose-600", bg: "bg-rose-100 dark:bg-rose-500/15", dot: "bg-rose-500", hex: "#f43f5e" },
  教育: { icon: GraduationCap, fg: "text-indigo-600", bg: "bg-indigo-100 dark:bg-indigo-500/15", dot: "bg-indigo-500", hex: "#6366f1" },
  光熱費: { icon: Lightbulb, fg: "text-yellow-600", bg: "bg-yellow-100 dark:bg-yellow-500/15", dot: "bg-yellow-500", hex: "#eab308" },
  住居費: { icon: Home, fg: "text-teal-600", bg: "bg-teal-100 dark:bg-teal-500/15", dot: "bg-teal-500", hex: "#14b8a6" },
  保険: { icon: ShieldCheck, fg: "text-cyan-600", bg: "bg-cyan-100 dark:bg-cyan-500/15", dot: "bg-cyan-500", hex: "#06b6d4" },
  税金: { icon: Landmark, fg: "text-stone-600", bg: "bg-stone-100 dark:bg-stone-500/15", dot: "bg-stone-500", hex: "#78716c" },
  美容: { icon: Sparkles, fg: "text-purple-600", bg: "bg-purple-100 dark:bg-purple-500/15", dot: "bg-purple-500", hex: "#a855f7" },
  通信費: { icon: Smartphone, fg: "text-blue-600", bg: "bg-blue-100 dark:bg-blue-500/15", dot: "bg-blue-500", hex: "#3b82f6" },
  サブスク: { icon: RefreshCw, fg: "text-violet-600", bg: "bg-violet-100 dark:bg-violet-500/15", dot: "bg-violet-500", hex: "#8b5cf6" },
  プレゼント: { icon: Gift, fg: "text-red-600", bg: "bg-red-100 dark:bg-red-500/15", dot: "bg-red-500", hex: "#ef4444" },
  旅行: { icon: Plane, fg: "text-emerald-600", bg: "bg-emerald-100 dark:bg-emerald-500/15", dot: "bg-emerald-500", hex: "#10b981" },
  ペット: { icon: PawPrint, fg: "text-lime-600", bg: "bg-lime-100 dark:bg-lime-500/15", dot: "bg-lime-500", hex: "#84cc16" },
  貯金: { icon: PiggyBank, fg: "text-green-600", bg: "bg-green-100 dark:bg-green-500/15", dot: "bg-green-500", hex: "#22c55e" },
  その他: { icon: MoreHorizontal, fg: "text-slate-600", bg: "bg-slate-100 dark:bg-slate-500/15", dot: "bg-slate-400", hex: "#94a3b8" },
};

const FALLBACK = VISUALS["その他"];

/** Resolve any (possibly aliased/raw) category name to its visual identity. */
export function getCategoryVisual(category?: string | null): CategoryVisual {
  if (!category) return FALLBACK;
  const canonical = normalizeCategoryName(category);
  return VISUALS[canonical] ?? FALLBACK;
}

/** Stable ordered palette of hex colors for charts. */
export function categoryHex(category?: string | null): string {
  return getCategoryVisual(category).hex;
}
