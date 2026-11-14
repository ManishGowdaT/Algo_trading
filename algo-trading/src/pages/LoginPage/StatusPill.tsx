import React from 'react';

interface StatusPillProps {
  active?: boolean;
  label: string;
  /** Additional classes */
  className?: string;
}

/**
 * Inline status indicator pill with animated dot.
 * Used in the navbar and in the left-panel footer.
 */
const StatusPill: React.FC<StatusPillProps> = ({ active = true, label, className = '' }) => (
  <div
    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${
      active
        ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
        : 'bg-slate-100 border-slate-200 text-slate-500'
    } ${className}`}
  >
    <span
      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
        active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
      }`}
      aria-hidden="true"
    />
    <span>{label}</span>
  </div>
);

export default StatusPill;
