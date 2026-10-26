'use client';

// デモの LINE の会話。スマホの枠の中のトークで、用意した文例（lib/demo/demoLine.ts の DEMO_CHAT_EXAMPLES）を選んで送ると、
// 入力中の表示のあとに確認カード（LineExpenseCard）が返る。OK を押すと「この内容で確定」と発言し、確定のカードが返る（bot の postback と同じ）。
// 自由入力はさせない（bot の判定をデモで再現できないため）。会話はこの画面の状態だけで、どこにも保存しない。
import { useEffect, useId, useRef, useState } from 'react';
import { Info, Plus, RotateCcw, SendHorizontal } from 'lucide-react';
import { GlassCard } from '../home/GlassCard';
import LineExpenseCard from './LineExpenseCard';
import { BotMessage, DateDivider, LinePhone, TypingBubble, UserMessage } from './LineTalk';
import {
  CARD_TEXT,
  DEMO_CHAT_EXAMPLES,
  DEMO_LINE_GROUP,
  confirmedTextCard,
  talkDateLabel,
  textExpenseCard,
  type DemoChatExample,
  type DemoExpenseCard,
} from '../../lib/demo/demoLine';
import { DEMO_TODAY } from '../../lib/demo/demoData';

type ChatItem =
  | { id: number; kind: 'user'; text: string; time: string }
  | { id: number; kind: 'typing' }
  | { id: number; kind: 'card'; card: DemoExpenseCard; example: DemoChatExample; confirmable: boolean; time: string };

/** 会話の最初の時刻（12:30）。発言ごとに 1 分進める（本当の時刻は使わない） */
const START_MINUTES = 12 * 60 + 30;
const TYPING_AFTER_MS = 350;
const REPLY_AFTER_MS = 1300;

function clockOf(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  { title: '内容と金額を送る', body: '「ランチ 850」のように送る。このデモでは、分類が辞書で決まる文例だけを送れます' },
  {
    title: '辞書で分類する',
    body: '大項目と中項目をキーワードの辞書で決める。辞書に無い語は Jev（だめなら Gemini）。カテゴリの後ろの（辞書）が判定元',
  },
  { title: '確認カードが返る', body: 'OK を押すまでは「共同費（未確認）」で、月の合計に入らない（ホームの「要確認」）' },
  { title: 'OK で確定する', body: '共同費になり、合計に入る。「家計簿一覧を見る」で支出一覧へ' },
];

export default function LineChat() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(() => new Set());
  const [minutes, setMinutes] = useState(START_MINUTES);
  const nextId = useRef(1);
  // 返事を待つタイマー（同じ Set を使い続け、画面を離れたら止める）
  const timers = useRef<Set<number>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);
  // 文例のチップと送る文の欄のラベル（見えている説明の行）
  const labelId = useId();

  const draft = DEMO_CHAT_EXAMPLES.find((e) => e.key === draftKey) ?? null;

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
    };
  }, []);

  // 新しい発言が見えるように、トークの中だけを動かす（カードが高いときはカードの上端に合わせる）
  useEffect(() => {
    const body = bodyRef.current;
    const last = body?.lastElementChild as HTMLElement | null | undefined;
    if (!body || !last) return;
    const top = last.offsetHeight > body.clientHeight ? last.offsetTop - 8 : body.scrollHeight;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    body.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  }, [items]);

  const later = (ms: number, run: () => void) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      run();
    }, ms);
    timers.current.add(t);
  };

  // 自分の発言を足し、入力中の表示のあとに公式アカウントのカードを返す
  const say = (text: string, reply: (id: number, time: string) => ChatItem) => {
    const time = clockOf(minutes);
    setMinutes((m) => m + 1);
    setItems((prev) => [...prev, { id: nextId.current++, kind: 'user', text, time }]);
    setBusy(true);
    const typingId = nextId.current++;
    later(TYPING_AFTER_MS, () => setItems((prev) => [...prev, { id: typingId, kind: 'typing' }]));
    later(REPLY_AFTER_MS, () => {
      const replyId = nextId.current++;
      setItems((prev) => [...prev.filter((i) => i.id !== typingId), reply(replyId, time)]);
      setBusy(false);
    });
  };

  const send = () => {
    if (!draft || busy) return;
    const example = draft;
    setDraftKey(null);
    say(example.text, (id, time) => ({
      id,
      kind: 'card',
      card: textExpenseCard(example, DEMO_TODAY),
      example,
      confirmable: true,
      time,
    }));
  };

  const confirm = (item: Extract<ChatItem, { kind: 'card' }>) => {
    if (busy || confirmed.has(item.id)) return;
    setConfirmed((prev) => new Set(prev).add(item.id));
    say(CARD_TEXT.okDisplayText, (id, time) => ({
      id,
      kind: 'card',
      card: confirmedTextCard(item.example, DEMO_TODAY),
      example: item.example,
      confirmable: false,
      time,
    }));
  };

  const reset = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current.clear();
    setItems([]);
    setDraftKey(null);
    setBusy(false);
    setConfirmed(new Set());
    setMinutes(START_MINUTES);
  };

  const footer = (
    <div className="shrink-0 border-t border-black/5 bg-white px-2.5 pb-3 pt-2 dark:border-white/5 dark:bg-[#20252f]">
      <p id={labelId} className="mb-1.5 text-[11px] text-slate-500 dark:text-slate-400">
        文例を選んで送信（自由入力はできません）
      </p>
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
        {DEMO_CHAT_EXAMPLES.map((example) => {
          const selected = example.key === draftKey;
          return (
            <button
              key={example.key}
              type="button"
              aria-pressed={selected}
              disabled={busy}
              onClick={() => setDraftKey(selected ? null : example.key)}
              className={`rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                selected
                  ? 'border-emerald-500 bg-emerald-500 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-transparent dark:text-slate-200 dark:hover:bg-white/5'
              }`}
            >
              {example.text}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Plus aria-hidden className="h-5 w-5 shrink-0 text-slate-400" />
        <output
          aria-labelledby={labelId}
          className="block min-w-0 flex-1 truncate rounded-full bg-slate-100 px-3 py-2 text-[14px] text-[#111] dark:bg-white/10 dark:text-white"
        >
          {draft ? draft.text : <span className="text-slate-400">上の文例を選んでください</span>}
        </output>
        <button
          type="button"
          aria-label="送信"
          title="送信"
          disabled={!draft || busy}
          onClick={send}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-500 text-white transition-opacity disabled:opacity-35"
        >
          <SendHorizontal className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start">
      <LinePhone
        title={DEMO_LINE_GROUP.name}
        memberCount={DEMO_LINE_GROUP.memberCount}
        clock={clockOf(Math.max(START_MINUTES, minutes - 1))}
        footer={footer}
        bodyRef={bodyRef}
        live
      >
        <DateDivider label={talkDateLabel(DEMO_TODAY)} />
        {items.length === 0 && (
          <p className="mx-auto max-w-[15rem] rounded-xl bg-black/15 px-3 py-2 text-center text-[12px] leading-relaxed text-white dark:bg-white/10">
            下の文例を選んで、右の送信ボタンを押してください
          </p>
        )}
        {items.map((item) => {
          if (item.kind === 'user') return <UserMessage key={item.id} text={item.text} time={item.time} />;
          if (item.kind === 'typing') {
            return (
              <BotMessage key={item.id}>
                <TypingBubble />
              </BotMessage>
            );
          }
          return (
            <BotMessage key={item.id} time={item.time}>
              <LineExpenseCard
                card={item.card}
                onOk={item.confirmable ? () => confirm(item) : undefined}
                okDisabled={busy || confirmed.has(item.id)}
              />
            </BotMessage>
          );
        })}
      </LinePhone>

      <GlassCard className="p-5">
        <h2 className="text-base font-semibold text-fg">LINE に送るだけで記録する</h2>
        <p className="mt-1 text-sm text-muted">
          LINE グループ（または個人のトーク）に内容と金額を送ると、家計簿の LINE 公式アカウントが分類して、確認のカードを返します。
        </p>
        <ol className="mt-4 space-y-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/12 text-xs font-semibold tabular-nums text-accent">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{step.title}</span>
                <span className="block text-xs text-muted">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-line/70 bg-fg/[0.03] p-3 text-xs text-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          カードの文言・色・ボタンは、本番の LINE のカードと同じです。修正・レシート添付・行の右のボタンは、デモでは押せません。操作はどこにも保存されません。
        </p>
        <button
          type="button"
          onClick={reset}
          disabled={items.length === 0}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line bg-card/70 px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-fg/5 disabled:opacity-40"
        >
          <RotateCcw className="h-4 w-4" />
          最初からやり直す
        </button>
      </GlassCard>
    </div>
  );
}
