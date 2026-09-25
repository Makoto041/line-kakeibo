'use client';

// オン／オフのスイッチ（role="switch"）。名前は aria-label か、見出しの id を aria-labelledby で渡す。
import { cx } from '@/lib/cx';

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  labelledBy?: string;
  className?: string;
}

export function Switch({ checked, onChange, disabled, label, labelledBy, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-ink/15',
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'absolute left-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_6px_rgba(15,27,61,0.22)] transition-transform duration-200',
          checked ? 'translate-x-5' : 'translate-x-0'
        )}
      />
    </button>
  );
}

/**
 * スイッチ付きの行。行のどこを押しても切り替わる（タップ領域を行の高さまで広げる）。
 * キーボードではスイッチ自体にフォーカスして操作する（行はフォーカスを受けない）。
 */
export function SwitchRow({
  label,
  labelId,
  checked,
  onChange,
  disabled,
  className,
}: {
  label: string;
  labelId: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      onClick={(e) => {
        if (disabled) return;
        if ((e.target as Element).closest('[role="switch"]')) return;
        onChange(!checked);
      }}
      className={cx(
        'flex min-h-[60px] select-none items-center gap-4 rounded-2xl kb-glass-2 px-4',
        disabled ? 'cursor-default' : 'cursor-pointer',
        className
      )}
    >
      <span id={labelId} className="min-w-0 flex-1 truncate text-kb-row text-ink">
        {label}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} labelledBy={labelId} />
    </div>
  );
}
