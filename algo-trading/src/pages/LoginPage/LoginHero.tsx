import React from 'react';
import { Activity, Layers, Zap } from 'lucide-react';
import FeatureItem from './FeatureItem';
import StatusPill from './StatusPill';

/**
 * Left hero panel — navy background, white text, feature rows.
 * Visible only on desktop (lg+).
 */
const LoginHero: React.FC = () => (
  <div
    className="hidden lg:flex flex-col justify-between p-12 bg-navy-900 relative overflow-hidden"
    style={{ minHeight: 0 }}
  >
    {/* Subtle dot pattern at ~6% opacity */}
    <div
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
      style={{
        backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.065) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    />

    {/* Content — sits above the dot pattern */}
    <div className="relative z-10 flex flex-col h-full justify-between gap-10">

      {/* Top block: badge + headline + description */}
      <div>
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/15 bg-white/8 text-[11px] font-semibold uppercase tracking-wider text-white/70 mb-6">
          Institutional Derivatives Gateway
        </div>

        <h2 className="text-[26px] font-bold leading-snug tracking-tightest text-white mb-3">
          Precision algorithmic execution for Indian options markets.
        </h2>

        <p className="text-[13px] text-white/55 leading-relaxed max-w-sm">
          Multi-strategy routing directly through Angel One SmartAPI. Automated risk checks,
          order lifecycle telemetry and isolated per-account execution contexts.
        </p>
      </div>

      {/* Feature rows */}
      <div className="space-y-5">
        <FeatureItem
          icon={<Activity className="w-4 h-4" />}
          title="Index VWAP ORB & Momentum"
          tag="Active"
          tagVariant="emerald"
          description="Sub-second signal evaluation on Nifty & BankNifty strikes with automated stop-loss trailing."
        />
        <FeatureItem
          icon={<Layers className="w-4 h-4" />}
          title="Multi-Account Risk Containment"
          tag="Enforced"
          tagVariant="slate"
          description="Account-isolated contexts, max drawdown gates, and strict order rate-limiting safeguards."
        />
        <FeatureItem
          icon={<Zap className="w-4 h-4" />}
          title="Real-time Order Telemetry"
          description="Live order status, fill confirmations and position sync across all connected accounts."
        />
      </div>

      {/* Bottom status line */}
      <div className="border-t border-white/10 pt-5">
        <StatusPill active label="Backend: Online" className="bg-transparent border-emerald-400/30 text-emerald-400" />
        <p className="text-[11px] text-white/35 mt-2">
          Powered by Angel One SmartAPI &nbsp;·&nbsp; v2.4
        </p>
      </div>
    </div>
  </div>
);

export default LoginHero;
