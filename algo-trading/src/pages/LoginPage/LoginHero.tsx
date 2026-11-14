import React from 'react';
import { ShieldCheck, Cpu, Activity, Zap } from 'lucide-react';

// ─── High-Fidelity Trading Terminal Preview ─────────────────────────────────
const TradingMockup: React.FC = () => (
  <div className="relative w-full max-w-[340px] mx-auto select-none" aria-hidden="true">
    {/* Ambient backlight glow */}
    <div className="absolute -inset-1.5 bg-gradient-to-r from-blue-500/20 via-indigo-500/15 to-blue-600/20 rounded-2xl blur-lg opacity-70" />

    {/* Main Terminal Window */}
    <div className="relative bg-white rounded-2xl border border-slate-200/90 shadow-[0_16px_36px_-8px_rgba(15,23,42,0.12),0_1px_3px_rgba(15,23,42,0.06)] overflow-hidden">
      {/* Terminal Titlebar Chrome */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-100 bg-slate-50/90">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-400/90" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400/90" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/90" />
          <span className="ml-2 text-[10px] font-semibold text-slate-600 tracking-wider uppercase">
            OptionAlgo Terminal
          </span>
        </div>
        <div className="flex items-center gap-1 text-[9px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200/80">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>11ms</span>
        </div>
      </div>

      {/* Terminal Content Area */}
      <div className="p-4">
        {/* Strike / Contract Header */}
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-slate-900 tracking-tight">NIFTY 24,850 CE</span>
              <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-100">
                +14.2%
              </span>
            </div>
            <p className="text-[9px] font-medium text-slate-400">EXP 28 NOV · INTRADAY</p>
          </div>
          <div className="text-right">
            <div className="text-[12px] font-bold text-slate-900 tabular-nums">₹142.80</div>
            <div className="text-[9px] text-emerald-600 font-semibold tabular-nums">+₹17.70</div>
          </div>
        </div>

        {/* High-Definition Candlestick & Curve Visualization */}
        <div className="relative h-24 my-2.5 bg-slate-50/50 rounded-lg p-1 border border-slate-100">
          <svg viewBox="0 0 280 88" fill="none" className="w-full h-full">
            {/* Subtle Horizontal Gridlines */}
            {[18, 40, 62].map((y) => (
              <line key={y} x1="0" y1={y} x2="280" y2={y} stroke="#E2E8F0" strokeWidth="0.8" strokeDasharray="3 3" />
            ))}

            {/* Area Glow under Price Curve */}
            <path
              d="M0,74 35,66 70,70 105,48 140,54 175,34 210,40 245,20 280,24 L280,88 L0,88 Z"
              fill="url(#premiumAreaGrad)"
              opacity="0.25"
            />

            {/* Main Price Action Curve */}
            <polyline
              points="0,74 35,66 70,70 105,48 140,54 175,34 210,40 245,20 280,24"
              stroke="#0052FF"
              strokeWidth="2.2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Candlesticks with Wicks */}
            {[
              { x: 30,  o: 70, c: 63, h: 58, l: 74, bull: true  },
              { x: 65,  o: 64, c: 69, h: 60, l: 73, bull: false },
              { x: 100, o: 68, c: 49, h: 44, l: 72, bull: true  },
              { x: 135, o: 49, c: 54, h: 46, l: 58, bull: false },
              { x: 170, o: 53, c: 35, h: 30, l: 56, bull: true  },
              { x: 205, o: 36, c: 41, h: 32, l: 45, bull: false },
              { x: 240, o: 40, c: 22, h: 18, l: 42, bull: true  },
            ].map((candle, idx) => {
              const top = Math.min(candle.o, candle.c);
              const height = Math.max(3, Math.abs(candle.o - candle.c));
              const color = candle.bull ? '#10B981' : '#EF4444';
              return (
                <g key={idx}>
                  <line x1={candle.x} y1={candle.h} x2={candle.x} y2={candle.l} stroke={color} strokeWidth="1.2" />
                  <rect
                    x={candle.x - 4}
                    y={top}
                    width="8"
                    height={height}
                    fill={color}
                    rx="1.5"
                  />
                </g>
              );
            })}

            <defs>
              <linearGradient id="premiumAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0052FF" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#0052FF" stopOpacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        {/* Strategy Execution Banner */}
        <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-[10px]">
          <div className="flex items-center gap-1.5 font-semibold text-slate-700">
            <Activity className="w-3 h-3 text-[#0052FF]" />
            <span>VWAP ORB Strategy</span>
          </div>
          <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200/70">
            SL Auto-Trail Active
          </span>
        </div>
      </div>
    </div>

    {/* Floating Telemetry Chip: Realized P&L */}
    <div className="absolute -right-4 -top-3 bg-white/95 backdrop-blur-xs rounded-xl border border-slate-200/90 shadow-[0_8px_20px_-4px_rgba(15,23,42,0.12)] px-3 py-2">
      <div className="text-[9px] font-semibold text-slate-500 uppercase tracking-wide">P&amp;L Today</div>
      <div className="text-[13px] font-extrabold text-emerald-600 tabular-nums leading-tight">+₹18,450.00</div>
    </div>

    {/* Floating Telemetry Chip: Active Risk Gates */}
    <div className="absolute -left-4 -bottom-3 bg-white/95 backdrop-blur-xs rounded-xl border border-slate-200/90 shadow-[0_8px_20px_-4px_rgba(15,23,42,0.12)] px-3 py-2 flex items-center gap-2">
      <div className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center text-[#0052FF]">
        <ShieldCheck className="w-3.5 h-3.5" />
      </div>
      <div>
        <div className="text-[10px] font-bold text-slate-800 leading-tight">Risk Guard</div>
        <div className="text-[9px] font-medium text-slate-500">Max DD Enforced</div>
      </div>
    </div>
  </div>
);

// ─── Main Hero Panel ────────────────────────────────────────────────────────
const LoginHero: React.FC = () => (
  <div className="hidden lg:flex flex-col items-center justify-between h-full bg-[#EEF2FC] border-r border-slate-200/60 p-8 xl:p-12 relative overflow-hidden">
    {/* Subtle technical background grid */}
    <div
      className="absolute inset-0 pointer-events-none opacity-[0.07]"
      aria-hidden="true"
      style={{
        backgroundImage: 'radial-gradient(circle, #0052FF 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    />

    {/* Top Brand Header Pill */}
    <div className="relative z-10 w-full flex items-center justify-between text-xs">
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/80 border border-slate-200/80 text-slate-700 font-semibold shadow-xs">
        <span className="w-2 h-2 rounded-full bg-[#0052FF]" />
        <span className="text-[11px] tracking-tight">Angel One SmartAPI Certified</span>
      </div>
      <span className="text-[11px] font-semibold text-slate-400">Terminal v2.4</span>
    </div>

    {/* Center Core Showcase */}
    <div className="relative z-10 flex flex-col items-center text-center gap-7 w-full my-auto py-6">
      <TradingMockup />

      <div className="max-w-[320px]">
        <h2 className="text-[24px] font-extrabold text-slate-900 leading-tight tracking-tight">
          Systematic Options Trading,{' '}
          <span className="text-[#0052FF]">Automated.</span>
        </h2>
        <p className="mt-2.5 text-[13px] text-slate-600 leading-relaxed font-normal">
          Direct algorithmic routing for Indian indices with sub-second order telemetry, dynamic straddles, and strict risk safeguards.
        </p>

        {/* Carousel Dots */}
        <div className="flex items-center justify-center gap-1.5 mt-5">
          <span className="w-6 h-1.5 rounded-full bg-[#0052FF]" />
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
        </div>
      </div>
    </div>

    {/* Bottom Trust Feature Cards */}
    <div className="relative z-10 grid grid-cols-3 gap-3 w-full max-w-[380px] pt-4 border-t border-slate-200/70">
      <div className="bg-white/80 rounded-xl p-2.5 text-center border border-slate-200/80 shadow-2xs">
        <Cpu className="w-4 h-4 mx-auto text-[#0052FF] mb-1" />
        <div className="text-[11px] font-bold text-slate-800 leading-tight">SmartAPI</div>
        <div className="text-[9px] text-slate-500 font-medium">Direct Broker</div>
      </div>
      <div className="bg-white/80 rounded-xl p-2.5 text-center border border-slate-200/80 shadow-2xs">
        <Zap className="w-4 h-4 mx-auto text-amber-500 mb-1" />
        <div className="text-[11px] font-bold text-slate-800 leading-tight">Sub-Second</div>
        <div className="text-[9px] text-slate-500 font-medium">Order Latency</div>
      </div>
      <div className="bg-white/80 rounded-xl p-2.5 text-center border border-slate-200/80 shadow-2xs">
        <ShieldCheck className="w-4 h-4 mx-auto text-emerald-600 mb-1" />
        <div className="text-[11px] font-bold text-slate-800 leading-tight">Risk Guard</div>
        <div className="text-[9px] text-slate-500 font-medium">Automated SL</div>
      </div>
    </div>
  </div>
);

export default LoginHero;


