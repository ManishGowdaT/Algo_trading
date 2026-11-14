import React from 'react';

// ─── Floating terminal mockup illustration ───────────────────────────────────
const TradingMockup: React.FC = () => (
  <div className="relative w-72 mx-auto select-none" aria-hidden="true">
    {/* Main terminal card */}
    <div className="bg-white rounded-xl shadow-[0_8px_32px_rgba(11,31,90,0.14)] overflow-hidden">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-slate-100 bg-slate-50/80">
        <span className="w-2 h-2 rounded-full bg-rose-400" />
        <span className="w-2 h-2 rounded-full bg-amber-400" />
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        <span className="ml-2 text-[9px] font-semibold text-slate-500 tracking-wide uppercase">
          OptionAlgo Terminal
        </span>
      </div>

      {/* Chart area */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[9px] font-bold text-slate-800">NIFTY 50 · CE</span>
            <span className="text-[9px] text-emerald-600 font-semibold">↑ 1.84%</span>
          </div>
          <span className="text-[8px] text-slate-400">VWAP ORB</span>
        </div>

        {/* SVG chart */}
        <svg viewBox="0 0 240 76" fill="none" className="w-full">
          {/* Horizontal grid */}
          {[18, 36, 54].map((y) => (
            <line key={y} x1="0" y1={y} x2="240" y2={y} stroke="#F1F5F9" strokeWidth="1" />
          ))}
          {/* Blue price line */}
          <polyline
            points="0,68 30,60 60,63 90,43 120,49 150,30 180,36 210,18 240,22"
            stroke="#0B5FFF"
            strokeWidth="1.8"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Area fill */}
          <path
            d="M0,68 30,60 60,63 90,43 120,49 150,30 180,36 210,18 240,22 L240,76 L0,76 Z"
            fill="url(#mockupGrad)"
            opacity="0.12"
          />
          {/* Candle bodies */}
          {[
            { x: 24,  o: 64, c: 58, bull: true  },
            { x: 56,  o: 58, c: 62, bull: false },
            { x: 88,  o: 62, c: 44, bull: true  },
            { x: 120, o: 44, c: 49, bull: false },
            { x: 152, o: 49, c: 31, bull: true  },
            { x: 184, o: 31, c: 36, bull: false },
            { x: 216, o: 36, c: 20, bull: true  },
          ].map((c, i) => (
            <g key={i}>
              <line
                x1={c.x} y1={Math.min(c.o, c.c) - 3}
                x2={c.x} y2={Math.max(c.o, c.c) + 3}
                stroke={c.bull ? '#12B76A' : '#F04438'}
                strokeWidth="1"
              />
              <rect
                x={c.x - 4}
                y={Math.min(c.o, c.c)}
                width="8"
                height={Math.max(2, Math.abs(c.o - c.c))}
                fill={c.bull ? '#12B76A' : '#F04438'}
                rx="1"
                opacity="0.8"
              />
            </g>
          ))}
          <defs>
            <linearGradient id="mockupGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0B5FFF" />
              <stop offset="100%" stopColor="#0B5FFF" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>

        {/* Strategy status row */}
        <div className="mt-2 flex items-center gap-2">
          <span className="flex items-center gap-1 text-[8px] bg-emerald-50 text-emerald-700 font-semibold px-2 py-0.5 rounded-full border border-emerald-200">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            4 Active Strategies
          </span>
          <span className="text-[8px] text-slate-400">Synced just now</span>
        </div>
      </div>
    </div>

    {/* Floating P&L chip */}
    <div className="absolute -right-5 top-6 bg-white rounded-xl shadow-[0_4px_16px_rgba(11,31,90,0.14)] px-3 py-2">
      <div className="text-[8px] text-slate-500 font-medium">P&L Today</div>
      <div className="text-[12px] font-bold text-emerald-600 tabular-nums">+₹8,240</div>
    </div>

    {/* Floating orders chip */}
    <div className="absolute -left-5 bottom-10 bg-white rounded-xl shadow-[0_4px_16px_rgba(11,31,90,0.14)] px-3 py-2">
      <div className="text-[8px] text-slate-500 font-medium">Open Orders</div>
      <div className="text-[12px] font-bold text-slate-800 tabular-nums">12</div>
    </div>
  </div>
);

// ─── Main hero panel ─────────────────────────────────────────────────────────
/**
 * Left panel — light indigo-lavender background, trading mockup, headline,
 * carousel dots, trust signals. Visible only on lg+ screens.
 */
const LoginHero: React.FC = () => (
  <div className="hidden lg:flex flex-col items-center justify-between h-full bg-[#EBF0FE] p-10 xl:p-12 py-14">
    {/* Spacer */}
    <div />

    {/* Center block */}
    <div className="flex flex-col items-center text-center gap-8 w-full">
      <TradingMockup />

      <div className="max-w-[280px]">
        <h2 className="text-[22px] font-bold text-slate-900 leading-snug tracking-tightest">
          Systematic Options Trading,{' '}
          <span className="text-brand-primary">Automated.</span>
        </h2>
        <p className="mt-2.5 text-[13px] text-slate-600 leading-relaxed">
          Multi-strategy execution via Angel One SmartAPI with real-time telemetry
          and automated risk controls.
        </p>

        {/* Carousel dots */}
        <div className="flex items-center justify-center gap-2 mt-5">
          <span className="w-5 h-1.5 rounded-full bg-brand-primary" />
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
        </div>
      </div>
    </div>

    {/* Trust signals */}
    <div className="flex items-center gap-5">
      <div className="text-center">
        <div className="text-[11px] font-bold text-slate-800">SmartAPI</div>
        <div className="text-[10px] text-slate-500 mt-0.5">Integrated</div>
      </div>
      <div className="w-px h-7 bg-slate-300/80" />
      <div className="text-center">
        <div className="text-[11px] font-bold text-slate-800">Multi-Strategy</div>
        <div className="text-[10px] text-slate-500 mt-0.5">Execution</div>
      </div>
      <div className="w-px h-7 bg-slate-300/80" />
      <div className="text-center">
        <div className="text-[11px] font-bold text-slate-800">Automated</div>
        <div className="text-[10px] text-slate-500 mt-0.5">Risk Controls</div>
      </div>
    </div>
  </div>
);

export default LoginHero;

