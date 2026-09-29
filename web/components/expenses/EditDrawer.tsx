"use client";

import type React from "react";
import { Save, X, CreditCard } from "lucide-react";
import type { EditForm, PayerOption } from "../../lib/expenseEdit";

interface Props {
  /** パネルの要素（フォーカスの移動・閉じ込めは呼び出し側が行う） */
  panelRef: React.Ref<HTMLDivElement>;
  form: EditForm;
  /** 精算済み（金額・日付・支払い者を変えられない） */
  settled: boolean;
  categories: string[];
  payerOptions: PayerOption[];
  error: string | null;
  saving: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onCheckboxChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** 支出の編集ドロワー（モバイル: 下からのシート / デスクトップ: 右のドロワー） */
export default function EditDrawer({
  panelRef,
  form,
  settled,
  categories,
  payerOptions,
  error,
  saving,
  onChange,
  onCheckboxChange,
  onSave,
  onCancel,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="支出の編集">
      <button
        type="button"
        aria-label="閉じる"
        onClick={onCancel}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="glass-strong relative z-10 ml-auto flex w-full animate-fade-up flex-col overflow-y-auto p-5 shadow-glass-lg outline-hidden max-sm:mt-auto max-sm:max-h-[88vh] max-sm:rounded-t-2xl sm:h-full sm:max-w-md sm:rounded-l-2xl"
      >
        <div className="space-y-5">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h4 className="text-base font-semibold text-fg">支出の編集</h4>
            <button
              type="button"
              aria-label="閉じる"
              onClick={onCancel}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-fg/5 hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-2 block text-sm font-medium text-fg">説明</label>
              <input
                type="text"
                name="description"
                value={form.description}
                onChange={onChange}
                className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="例: ランチ代"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-fg">金額 (円)</label>
              <input
                type="number"
                name="amount"
                value={form.amount}
                onChange={onChange}
                disabled={settled}
                className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="1000"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-fg">日付</label>
              <input
                type="date"
                name="date"
                value={form.date}
                onChange={onChange}
                disabled={settled}
                className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-fg">カテゴリ</label>
              <select
                name="category"
                value={form.category}
                onChange={onChange}
                className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {categories.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-fg">
                <CreditCard className="h-4 w-4 text-muted" />
                支払い者
              </label>
              <select
                name="payerId"
                value={form.payerId}
                onChange={onChange}
                disabled={settled}
                className="w-full rounded-lg border border-line bg-card px-4 py-3 text-base text-fg focus:border-transparent focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* 現在の支払い者と入力者を必ず含める（選択中の値に対応する option が消えて意図しない支払い者へ変わってしまうのを防ぐ） */}
                {payerOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">デフォルトは入力者と同じです</p>
            </div>
          </div>

          <label className="flex cursor-pointer items-center rounded-lg border border-line bg-card p-3">
            <input
              type="checkbox"
              name="includeInTotal"
              checked={form.includeInTotal}
              onChange={onCheckboxChange}
              className="h-4 w-4 rounded border-line accent-accent"
            />
            <span className="ml-3 text-sm font-medium text-fg">合計に含める</span>
          </label>

          {settled && (
            <p className="rounded-lg bg-fg/[0.04] p-3 text-xs text-muted">
              精算済みの支出は、金額・日付・支払い者を変更できません
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-rose-500/20 bg-rose-500/[0.08] p-3 text-sm text-rose-700 dark:text-rose-300">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="flex flex-1 disabled:opacity-60 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-3 text-sm font-medium text-accent-fg transition-colors hover:opacity-90"
            >
              <Save className="h-4 w-4" />
              保存
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-card px-4 py-3 text-sm font-medium text-fg transition-colors hover:bg-fg/5"
            >
              <X className="h-4 w-4" />
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
