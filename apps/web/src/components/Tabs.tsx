import type { ReactNode } from 'react';
import { cn } from './ui';

export interface TabDefinition<Value extends string> {
  value: Value;
  label: string;
}

/**
 * Accessible tab strip shared by the operational modules. Pages stay in control
 * of the panel rendering so each tab can lazily fetch only what it needs.
 */
export function Tabs<Value extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: Value;
  onChange: (value: Value) => void;
  tabs: Array<TabDefinition<Value>>;
  label: string;
}): ReactNode {
  return (
    <div
      className="flex flex-wrap gap-1 border-b border-slate-200"
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'border-b-2 px-3 py-2 text-sm font-medium transition',
            value === tab.value
              ? 'border-brand-600 text-brand-700'
              : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
