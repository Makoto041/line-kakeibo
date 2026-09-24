'use client';

// 設定（予算・期間・表示・規約へのリンク）。ホームの歯車から開く設定シートと、単独の /settings ページで同じものを使う。
// 読み込み・保存の処理は刷新前の設定ページと同じ:
// - 読み込み時に localStorage の期間設定を Firestore へ移す（migrateLocalToFirestore）
// - 予算の読み込みに失敗したら予算は保存しない（既定値で上書きしない）
// - 月間予算は 1 円以上。保存は期間 → 予算の順に一括で行い、保存後はキャッシュ（dateSettings: / settingsBudget: / budget:）も更新する
// 説明文は置かず、数値だけを出す（例: 残り警告の横に「¥56,000」）。失敗は短い語のトースト、
// 成功はシートなら閉じる・ページなら保存ボタンを「保存済み」にして示す。
import { useEffect, useId, useState } from 'react';
import { Check, FileText, Lock, RotateCw, ShieldCheck } from 'lucide-react';
import dayjs from 'dayjs';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useLineAuth } from '@/lib/hooks';
import {
  getDateRangeSettings,
  saveDateRangeSettings,
  migrateLocalToFirestore,
  DEFAULT_SETTINGS,
  type DateRangeSettings,
} from '@/lib/dateSettings';
import { db } from '@/lib/firebase';
import { getCategoryVisual } from '@/lib/categoryVisuals';
import { CANONICAL_CATEGORIES } from '@/lib/categoryNormalization';
import { getCached, setCached } from '@/lib/swrCache';
import { yen } from '@/lib/money';
import { cx } from '@/lib/cx';
import { T } from '@/lib/uiText';
import { usePeriod } from '@/components/period/PeriodProvider';
import { useToast } from '@/components/ui/Toast';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { IconButton } from '@/components/ui/IconButton';
import { NavRow, SheetSection } from '@/components/ui/Rows';
import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton';
import { ThemeToggle } from '@/components/ThemeToggle';

// 予算設定インターフェース
interface BudgetConfig {
  monthlyBudget: number;
  categoryBudgets: Record<string, number>;
  alertThreshold: number;
}

const defaultBudgetConfig: BudgetConfig = {
  monthlyBudget: 200000,
  categoryBudgets: {},
  alertThreshold: 20,
};

// カテゴリ別予算の項目は正準カテゴリ（bot/分類器・支出データと統一）。
// 予算は category.name をキーに保存するため、名称を揃えることで実支出と突き合う。
const defaultCategories = CANONICAL_CATEGORIES.map((name) => ({ id: name, name }));

function normalizeBudgetConfig(data: unknown): BudgetConfig {
  const raw = data as Partial<BudgetConfig> | undefined;
  const normalizedCategoryBudgets: Record<string, number> = {};

  if (raw?.categoryBudgets && typeof raw.categoryBudgets === 'object' && !Array.isArray(raw.categoryBudgets)) {
    for (const [key, value] of Object.entries(raw.categoryBudgets)) {
      const numValue = typeof value === 'string' ? parseFloat(value) : value;
      if (typeof numValue === 'number' && Number.isFinite(numValue) && numValue >= 0) {
        normalizedCategoryBudgets[key] = numValue;
      }
    }
  }

  return {
    monthlyBudget:
      typeof raw?.monthlyBudget === 'number' && raw.monthlyBudget > 0
        ? raw.monthlyBudget
        : defaultBudgetConfig.monthlyBudget,
    categoryBudgets: normalizedCategoryBudgets,
    alertThreshold:
      typeof raw?.alertThreshold === 'number' && raw.alertThreshold >= 0 && raw.alertThreshold <= 100
        ? raw.alertThreshold
        : defaultBudgetConfig.alertThreshold,
  };
}

export type SettingsTab = 'budget' | 'period' | 'display';

interface SettingsPanelProps {
  initialTab?: SettingsTab;
  /** 保存に成功したあと（シートは閉じる・ホームの予算を読み直す） */
  onSaved?: () => void;
  /** page: 単独の /settings（保存の固定ボタンをナビの上に置き、保存後はボタンを「保存済み」にする） */
  variant?: 'sheet' | 'page';
}

const FIELD_INPUT = 'min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-5';

export function SettingsPanel({ initialTab = 'budget', onSaved, variant = 'sheet' }: SettingsPanelProps) {
  const { lineId, settled } = useLineAuth();
  const { setDateSettings: publishDateSettings } = usePeriod();
  const toast = useToast();
  const radioName = useId();

  // 再訪時の読み込み表示を避けるためのキャッシュキー
  const dsCacheKey = lineId ? `dateSettings:${lineId}` : '';
  const sbCacheKey = lineId ? `settingsBudget:${lineId}` : '';
  const cachedDate = dsCacheKey ? getCached<DateRangeSettings>(dsCacheKey) : undefined;
  const cachedBudget = sbCacheKey ? getCached<BudgetConfig>(sbCacheKey) : undefined;

  // 期間設定
  const [dateSettings, setDateSettings] = useState<DateRangeSettings>(cachedDate || DEFAULT_SETTINGS);
  const [tempStartDate, setTempStartDate] = useState(cachedDate?.startDate || '');
  const [tempEndDate, setTempEndDate] = useState(cachedDate?.endDate || '');
  const [tempStartDay, setTempStartDay] = useState(cachedDate?.customStartDay || 1);

  // 予算設定
  const [budgetConfig, setBudgetConfig] = useState<BudgetConfig>(cachedBudget || defaultBudgetConfig);
  const [budgetHasLoaded, setBudgetHasLoaded] = useState(!!cachedBudget);
  const [budgetLoadError, setBudgetLoadError] = useState(false);

  // 共通（date・budget ともキャッシュ済みなら読み込み表示を出さない）
  const [loading, setLoading] = useState(!(cachedDate && cachedBudget));
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [reloadNonce, setReloadNonce] = useState(0);
  // どの利用者の設定を読み終えたか（認証の確定直後に既定値を一瞬出さない）
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const pending = !!lineId && loadedFor !== lineId && !(cachedDate && cachedBudget);
  // 最後に保存した内容（ページで「保存済み」を出すため。どこかを変えたら保存ボタンに戻る）
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const snapshot = JSON.stringify([dateSettings.mode, tempStartDate, tempEndDate, tempStartDay, budgetConfig]);
  const isSaved = savedSnapshot === snapshot;

  useEffect(() => {
    let cancelled = false;
    const loadAllSettings = async () => {
      if (!lineId) {
        setLoading(false);
        return;
      }

      // キャッシュがあれば即表示し、裏で再取得（読み込み表示を出さない）
      const hadCache = !!(getCached(`dateSettings:${lineId}`) && getCached(`settingsBudget:${lineId}`));
      try {
        if (!hadCache) setLoading(true);
        setBudgetLoadError(false);

        // 期間設定の読み込み
        await migrateLocalToFirestore(lineId);
        const loadedDateSettings = await getDateRangeSettings(lineId);
        if (cancelled) return;
        setCached(`dateSettings:${lineId}`, loadedDateSettings);
        setDateSettings(loadedDateSettings);
        setTempStartDate(loadedDateSettings.startDate || '');
        setTempEndDate(loadedDateSettings.endDate || '');
        setTempStartDay(loadedDateSettings.customStartDay || 1);

        // 予算設定の読み込み
        if (db) {
          const docRef = doc(db, 'budgetSettings', lineId);
          const docSnap = await getDoc(docRef);
          if (cancelled) return;
          if (docSnap.exists()) {
            const normalizedConfig = normalizeBudgetConfig(docSnap.data());
            setCached(`settingsBudget:${lineId}`, normalizedConfig);
            setBudgetConfig(normalizedConfig);
          }
          setBudgetHasLoaded(true);
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
        if (cancelled) return;
        setBudgetLoadError(true);
        toast.show('failed');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoadedFor(lineId);
        }
      }
    };

    loadAllSettings();
    return () => {
      cancelled = true;
    };
  }, [lineId, reloadNonce, toast]);

  const saveDateSettingsHandler = async () => {
    if (!lineId) return;

    const newSettings: DateRangeSettings = {
      mode: dateSettings.mode,
      ...(dateSettings.mode === 'custom' &&
        tempStartDate &&
        tempEndDate && {
          startDate: tempStartDate,
          endDate: tempEndDate,
        }),
      ...(dateSettings.mode === 'customStart' && {
        customStartDay: tempStartDay,
      }),
    };

    await saveDateRangeSettings(lineId, newSettings);
    setDateSettings(newSettings);
    // 保存後はキャッシュも更新し、3 タブ共通の期間にもすぐ反映する
    setCached(`dateSettings:${lineId}`, newSettings);
    publishDateSettings(newSettings);
  };

  /** 保存できなかった（読み込めていない・入力が不正）ときは false */
  const saveBudgetSettingsHandler = async (): Promise<boolean> => {
    if (!lineId || !db) return false;

    // 読み込めていない設定を既定値で上書きしない
    if (budgetLoadError || !budgetHasLoaded) return false;

    if (!Number.isFinite(budgetConfig.monthlyBudget) || budgetConfig.monthlyBudget <= 0) return false;

    const docRef = doc(db, 'budgetSettings', lineId);
    await setDoc(docRef, {
      ...budgetConfig,
      updatedAt: new Date(),
    });
    // 保存後はキャッシュも更新（settings再訪・ホームの予算表示に即反映）
    setCached(`settingsBudget:${lineId}`, budgetConfig);
    setCached(`budget:${lineId}`, budgetConfig);
    return true;
  };

  const handleSaveAll = async () => {
    if (!lineId) {
      toast.show('failed');
      return;
    }

    setSaving(true);
    try {
      await saveDateSettingsHandler();
      const budgetSaved = await saveBudgetSettingsHandler();
      if (!budgetSaved) {
        toast.show('failed');
        return;
      }
      setSavedSnapshot(snapshot);
      onSaved?.();
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.show('failed');
    } finally {
      setSaving(false);
    }
  };

  const categoryBudgetTotal = Object.values(budgetConfig.categoryBudgets).reduce((sum, val) => sum + val, 0);
  const alertAmount = Math.round((budgetConfig.monthlyBudget * budgetConfig.alertThreshold) / 100);

  const links = (
    <SheetSection title={T.settings.links}>
      <NavRow href="/terms" icon={FileText} label={T.settings.terms} />
      <NavRow href="/privacy" icon={ShieldCheck} label={T.settings.privacy} />
    </SheetSection>
  );

  // 認証の確定前はゲスト表示にしない（読み込み中の形だけ）
  if (!settled || (lineId && (loading || pending))) {
    return (
      <SkeletonGroup className="space-y-4 py-2">
        <Skeleton className="h-11 rounded-full" />
        <Skeleton className="h-14 rounded-2xl" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 rounded-2xl" />
      </SkeletonGroup>
    );
  }

  if (!lineId) {
    return (
      <div className="pb-2">
        <div className="kb-chip mt-2 flex h-14 items-center gap-3 rounded-kb-banner px-4 text-[16px] font-medium">
          <Lock size={20} strokeWidth={2} className="shrink-0" />
          {T.settings.signedOut}
        </div>
        <SheetSection title={T.settings.theme}>
          <ThemeToggle />
        </SheetSection>
        {links}
      </div>
    );
  }

  const stickyBottom =
    variant === 'page' ? 'calc(var(--kb-nav-h) + var(--kb-nav-bottom) + 12px + var(--kb-safe-bottom))' : '0px';

  return (
    <div>
      <SegmentedControl
        ariaLabel={T.settings.title}
        height={44}
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'budget', label: T.settings.tabBudget },
          { key: 'period', label: T.settings.tabPeriod },
          { key: 'display', label: T.settings.tabDisplay },
        ]}
        className="mt-1"
      />

      {activeTab === 'budget' && (
        <div className="pb-2 pt-3">
          {budgetLoadError && (
            <div className="mt-4 flex justify-center">
              <IconButton label={T.aria.retry} icon={RotateCw} onClick={() => setReloadNonce((n) => n + 1)} />
            </div>
          )}

          <SheetSection title={T.settings.monthlyBudget}>
            <label className="kb-field flex h-14 items-center gap-2 rounded-2xl px-4">
              <span className="text-[20px] font-bold text-ink-3">¥</span>
              <input
                type="number"
                inputMode="numeric"
                aria-label={T.settings.monthlyBudget}
                value={budgetConfig.monthlyBudget}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value);
                  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
                  setBudgetConfig((prev) => ({ ...prev, monthlyBudget: value }));
                }}
                className={cx(FIELD_INPUT, 'text-[22px] font-bold')}
              />
            </label>
          </SheetSection>

          <SheetSection
            title={T.settings.alert}
            aside={<span className="text-[14px] font-medium text-ink-3">{yen(alertAmount)}</span>}
          >
            <div className="flex items-center gap-4 px-1">
              <input
                type="range"
                min="5"
                max="50"
                step="5"
                aria-label={T.settings.alert}
                value={budgetConfig.alertThreshold}
                onChange={(e) =>
                  setBudgetConfig((prev) => ({ ...prev, alertThreshold: parseInt(e.target.value) }))
                }
                className="h-2 flex-1 cursor-pointer accent-[var(--kb-accent)]"
              />
              <span className="w-12 text-right text-[16px] font-semibold text-ink">
                {budgetConfig.alertThreshold}%
              </span>
            </div>
          </SheetSection>

          <SheetSection
            title={T.settings.categoryBudgets}
            aside={
              <span
                className={cx(
                  'text-[14px] font-medium',
                  categoryBudgetTotal > budgetConfig.monthlyBudget ? 'text-danger' : 'text-ink-3'
                )}
              >
                {T.settings.total} {yen(categoryBudgetTotal)}
              </span>
            }
          >
            <div>
              {defaultCategories.map((category) => {
                const Icon = getCategoryVisual(category.name).icon;
                return (
                  <label
                    key={category.id}
                    className="flex h-[56px] items-center gap-3 border-b border-divider px-1 last:border-b-0"
                  >
                    <Icon size={22} strokeWidth={1.9} className="shrink-0 text-ink" />
                    <span className="w-24 shrink-0 truncate text-[15px] text-ink">{category.name}</span>
                    <span className="kb-field flex h-10 min-w-0 flex-1 items-center gap-1.5 rounded-xl px-3">
                      <span className="text-[14px] text-ink-4">¥</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        placeholder="0"
                        aria-label={category.name}
                        value={budgetConfig.categoryBudgets[category.name] || ''}
                        onChange={(e) => {
                          const value = parseInt(e.target.value) || 0;
                          setBudgetConfig((prev) => ({
                            ...prev,
                            categoryBudgets: {
                              ...prev.categoryBudgets,
                              [category.name]: value,
                            },
                          }));
                        }}
                        className={cx(FIELD_INPUT, 'text-[15px]')}
                      />
                    </span>
                  </label>
                );
              })}
            </div>
          </SheetSection>
        </div>
      )}

      {activeTab === 'period' && (
        <div className="pb-2 pt-3">
          <div className="mt-2">
            <div role="radiogroup" aria-label={T.settings.tabPeriod}>
              {(
                [
                  { mode: 'monthly', label: T.settings.modeMonthly },
                  { mode: 'customStart', label: T.settings.modeCustomStart },
                  { mode: 'custom', label: T.settings.modeCustom },
                ] as const
              ).map(({ mode, label }) => (
                <label
                  key={mode}
                  className="flex h-14 cursor-pointer items-center gap-3 border-b border-divider px-1 last:border-b-0"
                >
                  <input
                    type="radio"
                    name={radioName}
                    value={mode}
                    checked={dateSettings.mode === mode}
                    onChange={(e) =>
                      setDateSettings({ ...dateSettings, mode: e.target.value as DateRangeSettings['mode'] })
                    }
                    className="h-5 w-5 shrink-0 accent-[var(--kb-accent)]"
                  />
                  <span className="text-kb-row text-ink">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {dateSettings.mode === 'customStart' && (
            <SheetSection title={T.settings.startDay}>
              <select
                aria-label={T.settings.startDay}
                value={tempStartDay}
                onChange={(e) => setTempStartDay(parseInt(e.target.value))}
                className="kb-field h-12 w-full rounded-xl px-3 text-[16px]"
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                  <option key={day} value={day}>
                    {T.settings.dayOption(day)}
                  </option>
                ))}
              </select>
            </SheetSection>
          )}

          {dateSettings.mode === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <SheetSection title={T.settings.startDate} className="!mt-6">
                <input
                  type="date"
                  aria-label={T.settings.startDate}
                  value={tempStartDate}
                  onChange={(e) => setTempStartDate(e.target.value)}
                  max={tempEndDate || dayjs().format('YYYY-MM-DD')}
                  className="kb-field h-12 w-full rounded-xl px-3 text-[16px]"
                />
              </SheetSection>
              <SheetSection title={T.settings.endDate} className="!mt-6">
                <input
                  type="date"
                  aria-label={T.settings.endDate}
                  value={tempEndDate}
                  onChange={(e) => setTempEndDate(e.target.value)}
                  min={tempStartDate}
                  max={dayjs().format('YYYY-MM-DD')}
                  className="kb-field h-12 w-full rounded-xl px-3 text-[16px]"
                />
              </SheetSection>
            </div>
          )}
        </div>
      )}

      {activeTab === 'display' && (
        <div className="pb-2 pt-3">
          <SheetSection title={T.settings.theme}>
            <ThemeToggle />
          </SheetSection>
          {links}
        </div>
      )}

      {activeTab !== 'display' && (
        <div
          className="sticky z-10 -mx-1 bg-gradient-to-t from-[var(--kb-card)] from-60% to-transparent px-1 pb-1 pt-4"
          style={{ bottom: stickyBottom }}
        >
          <PrimaryButton
            height={56}
            loading={saving}
            icon={isSaved ? Check : undefined}
            disabled={isSaved}
            onClick={handleSaveAll}
          >
            {isSaved ? T.settings.saved : T.settings.save}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}
