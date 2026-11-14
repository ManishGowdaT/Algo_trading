import React from 'react';

interface FeatureItemProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  tag?: string;
  tagVariant?: 'emerald' | 'slate' | 'blue';
}

const tagStyles: Record<NonNullable<FeatureItemProps['tagVariant']>, string> = {
  emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  slate:   'bg-slate-100  border-slate-200  text-slate-600',
  blue:    'bg-blue-50    border-blue-200   text-blue-700',
};

/**
 * A single capability row on the login hero panel.
 * Icon + title + optional tag + description.
 */
const FeatureItem: React.FC<FeatureItemProps> = ({
  icon,
  title,
  description,
  tag,
  tagVariant = 'slate',
}) => (
  <div className="flex items-start gap-3">
    {/* Icon container */}
    <div
      className="w-8 h-8 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center flex-shrink-0 mt-0.5 text-white"
      aria-hidden="true"
    >
      {icon}
    </div>

    <div className="flex-1 min-w-0">
      <div className="flex flex-wrap items-center gap-2 mb-0.5">
        <span className="text-[13px] font-semibold text-white leading-snug">{title}</span>
        {tag && (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${tagStyles[tagVariant]}`}
          >
            {tag}
          </span>
        )}
      </div>
      <p className="text-xs text-white/55 leading-relaxed">{description}</p>
    </div>
  </div>
);

export default FeatureItem;
