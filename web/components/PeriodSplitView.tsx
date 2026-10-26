'use client';

// 期間の折半精算の表示部分。明細・期間・集金するメンバーを props で受け取り、計算（lib/periodSplit.ts）と内訳シートを出す。
// 取得（期間の設定・明細）と保存（集金するメンバー）は呼び出し側（PeriodSplitCard）が持つ。
// Firestore・認証・bot の API に触れずに使えるよう、hooks / householdApi / firebase / lineAuth / dateSettings /
// recurringApi は値として import しない（型だけ。__tests__/periodSplitView.test.mjs で確かめる）。
import { useCallback, useMemo, useState } from 'react';
import { ArrowLeftRight, ArrowRight, ChevronLeft, ChevronRight, Loader2, Scale } from 'lucide-react';
import DrillSheet, { type DrillView } from './drilldown/DrillSheet';
import { CARD_PAYER_NAME, SHARED_PAYER_NAME, toDrillItems, type DrillFilter, type DrillRange } from '../lib/drilldown';
import { subCategoriesOf } from '../lib/categoryTaxonomy';
import { GMAIL_SYSTEM_LINE_ID, RECURRING_SYSTEM_LINE_ID, isPending, resolvePayerName } from '../lib/expenseState';
import { collectHistoricalUsers } from '../lib/expenseEdit';
import type { Expense, HouseholdMember } from '../lib/hooks';
import { computePeriodSplit, formatYenExact, isFullAdvance } from '../lib/periodSplit';
import { yen } from '../lib/money';

/** 表示する期間（YYYY-MM-DD の両端を含む）。期間指定（custom）のときは前後の期間に動かせない */
export type PeriodSplitRange = DrillRange & { mode: 'monthly' | 'custom' };

export interface PeriodSplitViewProps {
  /** 明細（世帯・期間で絞る前のもの。世帯 groupId・期間 range の明細だけを数える） */
  expenses: readonly Expense[];
  groupId: string;
  members: readonly HouseholdMember[];
  /** 集金するメンバー（送金する人）。未設定なら null */
  target: string | null;
  range: PeriodSplitRange;
  /** 期間の見出し（「2026年9月」など） */
  periodTitle: string;
  /** 前の期間・次の期間へ。渡さなければボタンを押せない */
  onPrevPeriod?: () => void;
  onNextPeriod?: () => void;
  /** 読み込み中（明細が無い間はくるくるを出す） */
  busy?: boolean;
  /** 明細が取得の上限に届いた（取りこぼしがありうる） */
  truncated?: boolean;
  /** 集金するメンバーを選べる */
  canSave: boolean;
  /** 集金するメンバーの保存中 */
  saving?: boolean;
  error?: string | null;
  /** 集金するメンバーを選んだ */
  onChoose: (lineId: string) => void;
  /** 内訳シートから支出一覧へのリンク。渡さなければ出さない */
  listHref?: (filter: DrillFilter) => string | null;
  /** 内訳シートの明細から編集画面へのリンク。渡さなければ出さない */
  editHref?: (id: string) => string | null;
}

export default function PeriodSplitView({
  expenses,
  groupId,
  members,
  target,
  range,
  periodTitle,
  onPrevPeriod,
  onNextPeriod,
  busy = false,
  truncated = false,
  canSave,
  saving = false,
  error = null,
  onChoose,
  listHref,
  editHref,
}: PeriodSplitViewProps) {
  const split = useMemo(
    () => computePeriodSplit({ expenses, groupId, members, targetLineId: target, range }),
    [expenses, groupId, members, target, range]
  );
  const nameOf = (id: string | undefined) => members.find((m) => m.lineId === id)?.displayName || 'メンバー';

  // 内訳シート: 折半の計算と同じ明細（世帯・期間内。合計に含み、立替精算済み・立替（全額）でないもの）を、支払い者（payerId）で分ける
  const [drill, setDrill] = useState<DrillView[] | null>(null);
  const closeDrill = useCallback(() => setDrill(null), []);
  const drillItems = useMemo(() => {
    const users = collectHistoricalUsers(expenses);
    const names = new Map(members.map((m) => [m.lineId, m.displayName || 'メンバー']));
    return toDrillItems(
      expenses.filter((e) => e.groupId === groupId),
      {
        range,
        included: (e) => !!e.includeInTotal && e.status !== 'advance_settled' && !isFullAdvance(e),
        payer: (e) => {
          const key = e.payerId || e.lineId;
          const name =
            names.get(key) ??
            (key === GMAIL_SYSTEM_LINE_ID ? CARD_PAYER_NAME : key === RECURRING_SYSTEM_LINE_ID ? SHARED_PAYER_NAME : resolvePayerName(e, users));
          return { key, name };
        },
        pending: isPending,
        subCategoriesOf,
      }
    );
  }, [expenses, groupId, members, range]);
  const targetKey = split.target?.lineId ?? null;
  const counted = drillItems.filter((i) => i.included);
  const targetCount = counted.filter((i) => i.payerKey === targetKey).length;
  const otherPayers = Array.from(new Set(counted.filter((i) => i.payerKey !== targetKey).map((i) => i.payerKey)));
  const totalView: DrillView = { kind: 'set', title: '期間の合計', filter: {} };

  return (
    <div className="glass animate-fade-up rounded-2xl p-5 shadow-glass">
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Scale className="h-4 w-4 text-accent" />
          期間の精算（折半）
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrevPeriod}
            disabled={range.mode === 'custom' || !onPrevPeriod}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40"
            aria-label="前の期間"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="whitespace-nowrap px-1 text-xs font-medium text-fg">{periodTitle}</span>
          <button
            type="button"
            onClick={onNextPeriod}
            disabled={range.mode === 'custom' || !onNextPeriod}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40"
            aria-label="次の期間"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {split.reason === 'not_two_members' ? (
        <p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          世帯のメンバーが2人そろうと計算できます
        </p>
      ) : (
        <>
          {busy && expenses.length === 0 ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted" />
            </div>
          ) : (
            <>
              {/* 図: 送金する人 → 受け取る人。アイコンをタップすると「送金する人」を切り替える */}
              {(() => {
                // 未設定のときは 2 人を並べるだけ（どちらかをタップして送金する人を選ぶ）
                const from = split.transfer ? split.transfer.fromLineId : target;
                const to = split.transfer
                  ? split.transfer.toLineId
                  : target
                  ? members.find((m) => m.lineId !== target)?.lineId ?? null
                  : null;
                const left = target ? members.find((m) => m.lineId === from) ?? null : members[0] ?? null;
                const right = target ? members.find((m) => m.lineId === to) ?? null : members[1] ?? null;
                const idle = !split.transfer;
                return (
                  <div className="mt-5">
                    <div className="flex items-center justify-center gap-3">
                      <PersonButton
                        member={left}
                        role={target ? '送金する人' : undefined}
                        dim={!target}
                        disabled={!canSave || saving || !left}
                        onClick={() => left && onChoose(left.lineId)}
                      />
                      <div className="flex flex-col items-center gap-1">
                        <ArrowRight className={`h-5 w-5 text-muted ${idle ? 'opacity-40' : ''}`} />
                        {target && canSave && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => {
                              const other = members.find((m) => m.lineId !== target);
                              if (other) onChoose(other.lineId);
                            }}
                            className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-50"
                            aria-label="送金する人を入れ替える"
                          >
                            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowLeftRight className="h-3 w-3" />}
                            入れ替え
                          </button>
                        )}
                      </div>
                      <PersonButton
                        member={right}
                        role={target ? '受け取る人' : undefined}
                        dim={!target || idle}
                        disabled={!canSave || saving || !right}
                        onClick={() => right && onChoose(right.lineId)}
                      />
                    </div>

                    {split.reason === 'no_target' ? (
                      <p className="mt-4 text-center text-sm text-muted">送金する人（毎月払う人）をタップしてください</p>
                    ) : (
                      <>
                        <p className="mt-4 text-center text-4xl font-black tabular-nums text-fg">
                          {yen(split.transfer?.amount ?? 0, 'ja-JP')}
                        </p>
                        <p className="mt-1 text-center text-xs text-muted">
                          {split.transfer
                            ? `${nameOf(split.transfer.fromLineId)}が${nameOf(split.transfer.toLineId)}に送金`
                            : '精算は不要です'}
                        </p>
                      </>
                    )}
                  </div>
                );
              })()}
              {error && <p className="mt-2 text-center text-xs text-rose-600 dark:text-rose-400">{error}</p>}

              {/* 内訳: 2 人の支払いと、1 人あたりの負担。タップすると明細まで潜れる */}
              {split.target && split.counterpart && (
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      setDrill([{ kind: 'set', title: `${split.target!.displayName || 'メンバー'}の支払い`, filter: { payers: [split.target!.lineId] } }])
                    }
                    className="min-w-0 rounded-xl border border-line bg-fg/[0.02] p-3 text-center transition-colors hover:bg-fg/5"
                  >
                    <span className="block truncate text-xs text-muted">{split.target.displayName || 'メンバー'}の支払い</span>
                    <span className="mt-0.5 block text-lg font-bold tabular-nums text-fg">{yen(split.targetPaid, 'ja-JP')}</span>
                    <span className="mt-0.5 inline-flex items-center text-[11px] font-medium text-accent">
                      {targetCount}件の内訳
                      <ChevronRight className="h-3 w-3" />
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDrill([
                        {
                          kind: 'set',
                          title: `${split.counterpart!.displayName || 'メンバー'}・カード・共通口座`,
                          filter: { payers: otherPayers },
                          dim: 'payer',
                        },
                      ])
                    }
                    className="min-w-0 rounded-xl border border-line bg-fg/[0.02] p-3 text-center transition-colors hover:bg-fg/5"
                  >
                    <span className="block truncate text-xs text-muted">
                      {split.counterpart.displayName || 'メンバー'}・カード・共通口座
                    </span>
                    <span className="mt-0.5 block text-lg font-bold tabular-nums text-fg">{yen(split.total - split.targetPaid, 'ja-JP')}</span>
                    <span className="mt-0.5 inline-flex items-center text-[11px] font-medium text-accent">
                      {counted.length - targetCount}件の内訳
                      <ChevronRight className="h-3 w-3" />
                    </span>
                  </button>
                </div>
              )}

              <dl className="mt-3 space-y-1 rounded-xl bg-fg/[0.03] p-3 text-xs tabular-nums">
                <div className="flex justify-between">
                  <dt className="text-muted">
                    合計（{split.count}件{split.excludedCount > 0 ? `・除外${split.excludedCount}件` : ''}
                    {split.settledCount > 0 ? `・立替精算済み${split.settledCount}件` : ''}
                    {split.advanceCount > 0 ? `・立替${split.advanceCount}件は全額で別` : ''}）
                  </dt>
                  <dd className="font-medium text-fg">{yen(split.total, 'ja-JP')}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">1人あたり（÷ 2）</dt>
                  <dd className="font-medium text-fg">{formatYenExact(split.half)}</dd>
                </div>
                {split.target && (
                  <div className="flex justify-between">
                    <dt className="text-muted">− {split.target.displayName || 'メンバー'}の支払い</dt>
                    <dd className="font-medium text-fg">{yen(split.targetPaid, 'ja-JP')}</dd>
                  </div>
                )}
                {/* 立替（全額）は折半せず、立て替えた人へ全額を返す */}
                {split.counterpart && split.counterpartAdvanced > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted">+ {split.counterpart.displayName || 'メンバー'}の立替（全額）</dt>
                    <dd className="font-medium text-fg">{yen(split.counterpartAdvanced, 'ja-JP')}</dd>
                  </div>
                )}
                {split.target && split.targetAdvanced > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted">− {split.target.displayName || 'メンバー'}の立替（全額）</dt>
                    <dd className="font-medium text-fg">{yen(split.targetAdvanced, 'ja-JP')}</dd>
                  </div>
                )}
              </dl>

              {split.count > 0 && (
                <button
                  type="button"
                  onClick={() => setDrill([totalView])}
                  className="mt-2 inline-flex w-full items-center justify-center gap-0.5 rounded-xl py-2 text-xs font-medium text-accent hover:bg-fg/5"
                >
                  カテゴリ別の内訳を見る
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              )}

              {truncated && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">件数が多いため、一部を数えられていない可能性があります</p>
              )}
            </>
          )}
        </>
      )}

      {drill && (
        <DrillSheet
          initial={drill}
          items={drillItems}
          range={range}
          listHref={listHref}
          editHref={editHref}
          onClose={closeDrill}
        />
      )}
    </div>
  );
}

function PersonButton({
  member,
  role,
  dim,
  disabled,
  onClick,
}: {
  member: HouseholdMember | null | undefined;
  role?: string;
  dim?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const name = member?.displayName || 'メンバー';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={role ? `${name}（${role}）` : `${name}を送金する人にする`}
      className={`flex w-24 flex-col items-center gap-1 rounded-xl p-1 transition-opacity disabled:cursor-default ${dim ? 'opacity-50' : ''}`}
    >
      <span className="grid h-12 w-12 place-items-center rounded-full bg-accent/12 text-lg font-bold text-accent">
        {Array.from(name)[0] ?? '?'}
      </span>
      <span className="max-w-full truncate text-xs text-fg">{name}</span>
      {role && <span className="text-[10px] text-muted">{role}</span>}
    </button>
  );
}
