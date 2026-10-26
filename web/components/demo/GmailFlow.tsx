'use client';

// デモのカード利用の取込（Gmail）。(a) カード会社のメール → (b) 自動で登録（店名の分類・時刻のルール）→ (c) LINE グループへの通知カード
// の 3 段を並べる。メール・店・金額は架空（lib/demo/demoLine.ts の DEMO_CARD_EMAIL）。分類の結果と文言も demoLine.ts から取る。
// 本番のカード利用の通知には「残り予算」の行が出ない（bot/src/gmail/handler.ts の cardUsageOf が remainingBudget を渡さない）ので、デモにも出さない。
import { ArrowDown, ArrowRight, CreditCard, Mail, Sparkles, Tags } from 'lucide-react';
import type { ReactNode } from 'react';
import { GlassCard } from '../home/GlassCard';
import LineExpenseCard from './LineExpenseCard';
import { BotMessage, DateDivider, TALK_BG } from './LineTalk';
import {
  CARD_TEXT,
  CATEGORY_ORIGIN_LABELS,
  DEMO_CARD_EMAIL,
  DEMO_CARD_RESULT,
  DEMO_LINE_GROUP,
  MEAL_BANDS,
  MERCHANT_CLASSIFY_ORDER,
  cardDate,
  cardEmailDate,
  cardEmailLines,
  cardUsageCard,
  mealOfHour,
  talkDateLabel,
} from '../../lib/demo/demoLine';

const CARD = cardUsageCard();
const USED_HOUR = Number(DEMO_CARD_EMAIL.usedAt.time.split(':')[0]);
const MEAL = mealOfHour(USED_HOUR);

function Step({ n, title, Icon, children }: { n: number; title: string; Icon: typeof Mail; children: ReactNode }) {
  return (
    <GlassCard className="p-4 md:p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/12 text-xs tabular-nums text-accent">{n}</span>
        <Icon className="h-4 w-4 text-muted" />
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </GlassCard>
  );
}

function Arrow() {
  return (
    <div aria-hidden className="flex justify-center text-muted">
      <ArrowDown className="h-5 w-5" />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-t border-line/60 py-2.5 first:border-t-0 first:pt-0">
      <dt className="w-16 shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-fg">{children}</dd>
    </div>
  );
}

function Chip({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
        strong ? 'bg-accent text-accent-fg' : 'bg-fg/[0.06] text-fg'
      }`}
    >
      {children}
    </span>
  );
}

export default function GmailFlow() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
      <div className="min-w-0 space-y-3">
        <Step n={1} title="カード会社からメールが届く" Icon={Mail}>
          <div className="overflow-hidden rounded-xl border border-line/70 bg-card/80">
            <dl className="space-y-1 border-b border-line/60 px-4 py-3 text-xs">
              <div className="flex gap-2">
                <dt className="w-10 shrink-0 text-muted">差出人</dt>
                <dd className="min-w-0 truncate text-fg">{DEMO_CARD_EMAIL.from}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-10 shrink-0 text-muted">件名</dt>
                <dd className="min-w-0 truncate font-medium text-fg">{DEMO_CARD_EMAIL.subject}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-10 shrink-0 text-muted">受信</dt>
                <dd className="tabular-nums text-fg">{DEMO_CARD_EMAIL.receivedAt}</dd>
              </div>
            </dl>
            <div className="space-y-1 px-4 py-3 text-sm text-fg">
              <p>{DEMO_CARD_EMAIL.lead}</p>
              {cardEmailLines().map((line) => (
                <p key={line} className="font-mono text-[13px] tabular-nums">
                  {line}
                </p>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Gmail に届いた通知を受けて、メールから利用日時・店名・金額を読み取ります（差出人・店・金額は架空です）。
          </p>
        </Step>

        <Arrow />

        <Step n={2} title="自動で登録する" Icon={Sparkles}>
          <dl>
            <Fact label="大項目">
              <span className="flex flex-wrap items-center gap-1">
                {MERCHANT_CLASSIFY_ORDER.map((name, i) => (
                  <span key={name} className="inline-flex items-center gap-1">
                    {i > 0 && <ArrowRight aria-hidden className="h-3 w-3 text-muted" />}
                    <Chip strong={name === CATEGORY_ORIGIN_LABELS[DEMO_CARD_RESULT.origin]}>{name}</Chip>
                  </span>
                ))}
              </span>
              <span className="mt-1.5 block text-xs text-muted">
                店名は辞書の部分一致で取り違えやすいので、モデルを先に使う。ここでは Jev が「{DEMO_CARD_RESULT.category}」と判定
              </span>
            </Fact>
            <Fact label="中項目">
              <span className="block">
                辞書で「{DEMO_CARD_RESULT.matchedKeyword}」が飲食店に当たり、利用時刻{' '}
                <b className="tabular-nums">{DEMO_CARD_EMAIL.usedAt.time}</b> で決める
              </span>
              <span className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px]">
                {MEAL_BANDS.map((band) => {
                  const hit = band.sub === MEAL;
                  return (
                    <span
                      key={band.sub}
                      className={`rounded-lg px-1 py-1.5 ${hit ? 'bg-accent text-accent-fg' : 'bg-fg/[0.05] text-muted'}`}
                    >
                      <span className="block font-semibold">{band.sub}</span>
                      <span className="block tabular-nums opacity-80">{band.range}</span>
                    </span>
                  );
                })}
              </span>
              <span className="mt-1.5 block text-xs text-muted">
                時刻のルールは、カード利用の飲食店だけに当てる（LINE で送った内容には当てない）
              </span>
            </Fact>
            <Fact label="支払い">
              <span className="flex items-start gap-1.5">
                <CreditCard aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <span>
                  支払った人は「{CARD_TEXT.cardPayer}」、{CARD_TEXT.sharedSplit}で確定（確認は要らない）
                </span>
              </span>
            </Fact>
            <Fact label="結果">
              <span className="flex flex-wrap items-center gap-1.5">
                <Tags aria-hidden className="h-4 w-4 text-muted" />
                <b>
                  {DEMO_CARD_RESULT.category}
                  {CARD_TEXT.subSeparator}
                  {DEMO_CARD_RESULT.subCategory}
                </b>
                <span className="text-xs text-muted">（{CATEGORY_ORIGIN_LABELS[DEMO_CARD_RESULT.origin]}）</span>
                <span className="text-xs text-muted">{cardDate(cardEmailDate())} の支出として保存</span>
              </span>
            </Fact>
          </dl>
        </Step>
      </div>

      <div className="min-w-0">
        <div className="lg:hidden">
          <Arrow />
        </div>
        <Step n={3} title="LINE グループに知らせる" Icon={CreditCard}>
          <div className={`rounded-2xl p-3 ${TALK_BG}`}>
            <p className="mb-2 text-center text-[11px] font-medium text-white/90">{DEMO_LINE_GROUP.name}</p>
            <div className="space-y-3">
              <DateDivider label={talkDateLabel(cardEmailDate())} />
              <BotMessage time={DEMO_CARD_EMAIL.receivedAt.split(' ')[1]}>
                <LineExpenseCard card={CARD} />
              </BotMessage>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            カードの支出は共同費として確定で入るので、OK は押さなくてよい。自分で払ったものなら「自分が払った」、個人の支出なら「除外」で変える（デモでは押せません）。
          </p>
        </Step>
      </div>
    </div>
  );
}
