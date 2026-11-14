import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { LogIn, Mail, Lock, Eye, EyeOff, TrendingUp, BarChart2, Shield, Zap } from 'lucide-react';

// ---------------------------------------------------------------------------
// Decorative candlestick chart illustration (SVG, no live data)
// ---------------------------------------------------------------------------
const CandlestickIllustration: React.FC = () => (
  <svg viewBox="0 0 320 160" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full" aria-hidden="true">
    {/* Grid lines */}
    {[0, 1, 2, 3, 4].map((i) => (
      <line key={i} x1="0" y1={32 * i} x2="320" y2={32 * i} stroke="#E0E3EB" strokeWidth="0.5" strokeDasharray="4 4" />
    ))}
    {/* Price line */}
    <polyline
      points="0,120 40,100 80,110 120,75 160,85 200,55 240,65 280,40 320,48"
      stroke="#0052FF"
      strokeWidth="2"
      strokeLinejoin="round"
      fill="none"
    />
    {/* Area fill under price line */}
    <path
      d="M0,120 40,100 80,110 120,75 160,85 200,55 240,65 280,40 320,48 L320,160 L0,160 Z"
      fill="url(#areaGrad)"
      opacity="0.12"
    />
    {/* Candles */}
    {[
      { x: 24, o: 108, c: 92, h: 85, l: 115, bull: true },
      { x: 64, o: 102, c: 112, h: 95, l: 118, bull: false },
      { x: 104, o: 110, c: 78, h: 70, l: 118, bull: true },
      { x: 144, o: 80, c: 88, h: 75, l: 95, bull: false },
      { x: 184, o: 86, c: 58, h: 50, l: 92, bull: true },
      { x: 224, o: 60, c: 68, h: 54, l: 72, bull: false },
      { x: 264, o: 66, c: 42, h: 36, l: 70, bull: true },
      { x: 304, o: 44, c: 50, h: 40, l: 56, bull: false },
    ].map((c, i) => (
      <g key={i}>
        {/* Wick */}
        <line x1={c.x} y1={c.h} x2={c.x} y2={c.l} stroke={c.bull ? '#26A66B' : '#EF5350'} strokeWidth="1.2" />
        {/* Body */}
        <rect
          x={c.x - 5}
          y={Math.min(c.o, c.c)}
          width="10"
          height={Math.max(2, Math.abs(c.o - c.c))}
          fill={c.bull ? '#26A66B' : '#EF5350'}
          rx="1"
          opacity="0.85"
        />
      </g>
    ))}
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#0052FF" />
        <stop offset="100%" stopColor="#0052FF" stopOpacity="0" />
      </linearGradient>
    </defs>
  </svg>
);

// ---------------------------------------------------------------------------
// Feature pill component
// ---------------------------------------------------------------------------
const FeaturePill: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <div className="flex items-center gap-2 px-3 py-1.5 bg-[#F0F3FA] border border-[#E0E3EB] rounded-full text-xs font-medium text-[#1E222D]">
    <span className="text-[#0052FF]">{icon}</span>
    {label}
  </div>
);

// ---------------------------------------------------------------------------
// Main LoginPage component
// ---------------------------------------------------------------------------
const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      const queryRedirect = new URLSearchParams(location.search).get('redirect');
      const stateRedirect = (location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null)?.from;
      const redirectPath = queryRedirect || (stateRedirect
        ? `${stateRedirect.pathname || ''}${stateRedirect.search || ''}${stateRedirect.hash || ''}`
        : '/dashboard');
      navigate(redirectPath.startsWith('/') ? redirectPath : '/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mobile-auth-page min-h-screen max-md:min-h-[100dvh] bg-white flex select-none">

      {/* ── LEFT PANEL (desktop only) ─────────────────────────────────────── */}
      <div className="hidden lg:flex lg:w-[55%] bg-[#F8F9FA] border-r border-[#E0E3EB] flex-col justify-between p-10 xl:p-14">

        {/* Logo / Brand */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-9 h-9 bg-[#0052FF] rounded-lg shadow-sm">
            <TrendingUp className="w-5 h-5 text-white" />
          </div>
          <div>
            <span className="text-[15px] font-bold text-[#1E222D] tracking-tight">OptionAlgo</span>
            <span className="block text-[10px] font-semibold text-[#787B86] uppercase tracking-widest -mt-0.5">Algo Trading Platform</span>
          </div>
        </div>

        {/* Hero text */}
        <div className="space-y-5">
          <div>
            <h1 className="text-[28px] xl:text-[32px] font-bold text-[#1E222D] leading-snug tracking-tight">
              Smarter Options Trading.<br />
              <span className="text-[#0052FF]">Systematic Execution.</span>
            </h1>
            <p className="mt-3 text-sm text-[#5D6673] leading-relaxed max-w-sm">
              An intelligent options trading platform designed for systematic strategies,
              real-time market insights and disciplined execution.
            </p>
          </div>

          {/* Chart illustration */}
          <div className="bg-white border border-[#E0E3EB] rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-[#787B86] uppercase tracking-wider">Strategy P&amp;L — Illustrative</span>
              <span className="flex items-center gap-1 text-[11px] font-bold text-[#26A66B]">
                <TrendingUp className="w-3 h-3" /> Chart View
              </span>
            </div>
            <div className="h-36">
              <CandlestickIllustration />
            </div>
            <p className="mt-2 text-[10px] text-[#B0B5C3] text-center">Decorative illustration — not live market data</p>
          </div>

          {/* Feature pills */}
          <div className="flex flex-wrap gap-2">
            <FeaturePill icon={<BarChart2 className="w-3 h-3" />} label="Real-time Market Data" />
            <FeaturePill icon={<Zap className="w-3 h-3" />} label="Automated Strategy Execution" />
            <FeaturePill icon={<Shield className="w-3 h-3" />} label="Intelligent Risk Management" />
            <FeaturePill icon={<TrendingUp className="w-3 h-3" />} label="Position Monitoring" />
          </div>
        </div>

        {/* Footer note */}
        <p className="text-[10px] text-[#B0B5C3] font-medium">
          Powered by Angel One API &nbsp;·&nbsp; Enterprise Algo Terminal v2.4
        </p>
      </div>

      {/* ── RIGHT PANEL — Login form ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 sm:px-10 bg-white">

        {/* Mobile-only logo */}
        <div className="flex lg:hidden flex-col items-center mb-8">
          <div className="flex items-center justify-center w-10 h-10 bg-[#0052FF] rounded-xl shadow mb-2">
            <TrendingUp className="w-5 h-5 text-white" />
          </div>
          <span className="text-base font-bold text-[#1E222D] tracking-tight">OptionAlgo</span>
          <span className="text-[10px] font-semibold text-[#787B86] uppercase tracking-widest">Algo Trading Platform</span>
        </div>

        {/* Form container */}
        <div className="w-full max-w-sm">

          <div className="mb-7">
            <h2 className="text-xl font-bold text-[#1E222D] tracking-tight">Welcome back</h2>
            <p className="mt-1 text-sm text-[#787B86]">Sign in to access your trading terminal.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>

            {/* Error banner */}
            {error && (
              <div className="flex items-start gap-2.5 p-3 bg-[#FFF1F0] border border-[#FFCDD2] rounded-lg" role="alert">
                <svg className="w-4 h-4 text-[#EF5350] mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
                <p className="text-xs font-medium text-[#C62828]">{error}</p>
              </div>
            )}

            {/* Email */}
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="block text-xs font-semibold text-[#1E222D]">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#B0B5C3] pointer-events-none" />
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full pl-9 pr-3 py-2.5 bg-white border border-[#E0E3EB] rounded-lg text-sm text-[#1E222D] placeholder:text-[#C1C7D0] outline-none focus:border-[#0052FF] focus:ring-2 focus:ring-[#0052FF]/15 transition-shadow"
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-xs font-semibold text-[#1E222D]">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#B0B5C3] pointer-events-none" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full pl-9 pr-11 py-2.5 bg-white border border-[#E0E3EB] rounded-lg text-sm text-[#1E222D] placeholder:text-[#C1C7D0] outline-none focus:border-[#0052FF] focus:ring-2 focus:ring-[#0052FF]/15 transition-shadow"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 flex h-9 w-9 max-md:h-11 max-md:w-11 items-center justify-center rounded-md text-[#B0B5C3] hover:text-[#1E222D] hover:bg-[#F0F3FA] transition-colors focus-visible:ring-2 focus-visible:ring-[#0052FF]"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Sign In button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-11 py-2.5 bg-[#0052FF] hover:bg-[#0047D0] active:bg-[#003DB3] text-white font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed shadow-sm focus-visible:ring-2 focus-visible:ring-[#0052FF] focus-visible:ring-offset-2"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <span>Sign In</span>
                  <LogIn className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="my-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-[#E0E3EB]" />
            <span className="text-[11px] text-[#B0B5C3] font-medium">New to OptionAlgo?</span>
            <div className="flex-1 h-px bg-[#E0E3EB]" />
          </div>

          {/* Register link */}
          <Link
            to="/register"
            className="mobile-auth-link w-full flex items-center justify-center min-h-11 py-2.5 border border-[#E0E3EB] hover:border-[#0052FF] hover:text-[#0052FF] text-sm font-semibold text-[#1E222D] rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-[#0052FF] focus-visible:ring-offset-2"
          >
            Create New Account
          </Link>

          {/* Legal footnote */}
          <p className="mt-6 text-center text-[10px] text-[#B0B5C3] leading-relaxed">
            By signing in you agree to the platform's terms of use.<br />
            <span className="font-semibold text-[#C1C7D0]">Enterprise Algo Terminal v2.4</span>
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;

