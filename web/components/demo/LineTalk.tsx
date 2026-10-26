// デモの LINE のトーク画面の部品（スマホの枠・ヘッダー・吹き出し・日付・入力中の表示）。
// LINE の会話（LineChat）・精算サマリー（LineSettlementSummary）はスマホの枠に入れ、カード利用の取込（GmailFlow）は吹き出しだけを使う。
// LINE の画面の色を写すだけで、LINE のロゴ・アイコンは使わない。確認カード（Flex Message）はテーマに関係なく白で描く（LINE と同じ）。
import type { ReactNode, Ref } from 'react';
import { ChevronLeft, Menu, Search, Wallet } from 'lucide-react';
import { DEMO_BOT_NAME } from '../../lib/demo/demoLine';

/** トークの背景（LINE の既定の色に近い青灰色。ダークテーマは暗い色） */
export const TALK_BG = 'bg-[#8fa6c7] dark:bg-[#1d2330]';

export function LinePhone({
  title,
  memberCount,
  clock,
  children,
  footer,
  bodyRef,
  live,
}: {
  title: string;
  memberCount: number;
  /** 上の帯の時刻 */
  clock: string;
  children: ReactNode;
  footer?: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  /** 新しい発言を読み上げる（会話が増える場面） */
  live?: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-[380px] rounded-[2.6rem] bg-neutral-900 p-2 shadow-glass-lg ring-1 ring-black/10 dark:bg-black dark:ring-white/10">
      <div className={`flex h-[min(700px,calc(100dvh-12rem))] min-h-[520px] flex-col overflow-hidden rounded-[2.2rem] ${TALK_BG}`}>
        <div className="relative flex h-7 shrink-0 items-center justify-between bg-white px-7 text-[11px] font-semibold text-[#111] dark:bg-[#20252f] dark:text-white">
          <span className="tabular-nums">{clock}</span>
          <span aria-hidden className="absolute left-1/2 top-1.5 h-4 w-20 -translate-x-1/2 rounded-full bg-neutral-900 dark:bg-black" />
          <span aria-hidden className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-[2px] bg-current opacity-80" />
            <span className="h-2 w-5 rounded-[3px] border border-current p-px">
              <span className="block h-full w-3/4 rounded-[1px] bg-current" />
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-black/5 bg-white px-2.5 py-2 text-[#111] dark:border-white/5 dark:bg-[#20252f] dark:text-white">
          <ChevronLeft aria-hidden className="h-5 w-5 shrink-0" />
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {title}
            <span className="ml-1 font-normal opacity-70">({memberCount})</span>
          </p>
          <Search aria-hidden className="h-[18px] w-[18px] shrink-0 opacity-80" />
          <Menu aria-hidden className="h-[18px] w-[18px] shrink-0 opacity-80" />
        </div>
        <div
          ref={bodyRef}
          aria-live={live ? 'polite' : undefined}
          className="relative min-h-0 flex-1 space-y-3 overflow-y-auto px-2.5 py-3"
        >
          {children}
        </div>
        {footer}
      </div>
    </div>
  );
}

export function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex justify-center">
      <span className="rounded-full bg-black/20 px-3 py-0.5 text-[11px] text-white dark:bg-white/10">{label}</span>
    </div>
  );
}

function BotAvatar() {
  return (
    <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
      <Wallet className="h-[18px] w-[18px]" strokeWidth={2.2} />
    </span>
  );
}

function Time({ time, read }: { time?: string; read?: boolean }) {
  if (!time) return null;
  return (
    <span className="shrink-0 pb-0.5 text-right text-[10px] leading-tight text-white/85">
      {read && (
        <>
          既読
          <br />
        </>
      )}
      {time}
    </span>
  );
}

/** 家計簿の LINE 公式アカウントの発言（アイコン・名前・中身・時刻） */
export function BotMessage({ children, time }: { children: ReactNode; time?: string }) {
  return (
    <div className="flex items-start gap-2">
      <BotAvatar />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] text-white/90">{DEMO_BOT_NAME}</p>
        <div className="flex items-end gap-1">
          <div className="min-w-0">{children}</div>
          <Time time={time} />
        </div>
      </div>
    </div>
  );
}

/** 自分の発言（右の緑の吹き出し） */
export function UserMessage({ text, time }: { text: string; time?: string }) {
  return (
    <div className="flex items-end justify-end gap-1 pl-12">
      <Time time={time} read />
      <p className="whitespace-pre-line break-words rounded-2xl rounded-tr-md bg-[#9fe08a] px-3 py-2 text-[14px] leading-snug text-[#111]">{text}</p>
    </div>
  );
}

/** 相手（公式アカウント）のテキストの吹き出し */
export function TextBubble({ children }: { children: ReactNode }) {
  return (
    <p className="whitespace-pre-line break-words rounded-2xl rounded-tl-md bg-white px-3 py-2 text-[14px] leading-relaxed text-[#111] dark:bg-[#2c313c] dark:text-white">
      {children}
    </p>
  );
}

/** メンション（@名前） */
export function Mention({ name }: { name: string }) {
  return <span className="font-semibold text-[#2f6fd1] dark:text-[#7fb0ff]">@{name}</span>;
}

/** 入力中（返事を作っている間の「…」） */
export function TypingBubble() {
  return (
    <span role="status" aria-label="入力中" className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-white px-3 py-3 dark:bg-[#2c313c]">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 rounded-full bg-slate-400 motion-safe:animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
