import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  ArrowRight,
  ShieldCheck,
  Server,
  Activity,
  Layers,
  ChevronRight,
  Cpu
} from 'lucide-react';

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
      setError(err instanceof Error ? err.message : 'Invalid credentials or connection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen max-md:min-h-[100dvh] bg-[#F8FAFC] flex flex-col justify-between selection:bg-[#0052FF]/10 selection:text-[#0052FF]">
      {/* Top Navigation Bar - Clean Brokerage Header */}
      <header className="w-full bg-white border-b border-slate-200/80 px-6 sm:px-10 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-[#0052FF] flex items-center justify-center text-white shadow-sm font-bold text-sm tracking-tighter">
            OA
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-sm tracking-tight text-slate-900 leading-none">OptionAlgo</span>
            <span className="text-[10px] font-semibold text-slate-500 tracking-wide uppercase mt-0.5">Automated Trading Suite</span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded bg-slate-50 border border-slate-200/80 text-slate-600">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-medium text-[11px] text-slate-700">Angel One SmartAPI</span>
          </div>
          <span className="text-slate-400">|</span>
          <Link
            to="/register"
            className="font-medium text-slate-700 hover:text-[#0052FF] transition-colors"
          >
            Create account
          </Link>
        </div>
      </header>

      {/* Main Content Area - Constrained Two-Column Trading Portal */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 lg:p-10">
        <div className="w-full max-w-5xl bg-white border border-slate-200/80 rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.05),0_10px_24px_rgba(0,0,0,0.02)] overflow-hidden grid grid-cols-1 lg:grid-cols-12 min-h-[560px]">
          
          {/* Left Column: System Architecture & Execution Specs (58%) */}
          <div className="lg:col-span-7 bg-[#FAFBFD] p-8 sm:p-10 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-200/80">
            <div>
              {/* Product Badge */}
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-blue-50 border border-blue-100 text-[#0052FF] text-[11px] font-semibold tracking-wide uppercase mb-5">
                <Cpu className="w-3.5 h-3.5" />
                <span>Institutional Derivatives Gateway</span>
              </div>

              <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight leading-snug">
                Precision algorithmic execution for Indian options markets.
              </h1>
              <p className="mt-3 text-sm text-slate-600 leading-relaxed max-w-lg">
                Direct integration with Angel One SmartAPI. Multi-strategy routing, automated risk checks, and real-time order lifecycle telemetry.
              </p>

              {/* Execution Capabilities Matrix */}
              <div className="mt-8 space-y-3">
                <div className="p-3.5 rounded-lg bg-white border border-slate-200/70 shadow-xs flex items-start gap-3.5">
                  <div className="w-7 h-7 rounded bg-blue-50 flex items-center justify-center text-[#0052FF] shrink-0 mt-0.5">
                    <Activity className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800">Index VWAP ORB &amp; Momentum</span>
                      <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">Active</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-normal">
                      Sub-second signal evaluation on Nifty &amp; BankNifty index strikes with automated stop-loss trailing.
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-lg bg-white border border-slate-200/70 shadow-xs flex items-start gap-3.5">
                  <div className="w-7 h-7 rounded bg-indigo-50 flex items-center justify-center text-indigo-600 shrink-0 mt-0.5">
                    <Layers className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800">Multi-Account Risk Containment</span>
                      <span className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">Enforced</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-normal">
                      Account-isolated execution contexts, max drawdown gates, and strict order rate-limiting safeguards.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Status Ticker */}
            <div className="mt-8 pt-5 border-t border-slate-200/70 flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500">
              <div className="flex items-center gap-2">
                <Server className="w-3.5 h-3.5 text-slate-400" />
                <span>Backend Cluster: <span className="font-semibold text-slate-700">Online (Render / Node.js)</span></span>
              </div>
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                <span>SmartAPI Certified Auth</span>
              </div>
            </div>
          </div>

          {/* Right Column: Terminal Authentication Card (42%) */}
          <div className="lg:col-span-5 bg-white p-8 sm:p-10 flex flex-col justify-center">
            <div className="w-full max-w-sm mx-auto">
              {/* Header */}
              <div className="mb-6">
                <h2 className="text-xl font-bold text-slate-900 tracking-tight">Terminal Login</h2>
                <p className="text-xs text-slate-500 mt-1">Authenticate to connect your active trading session</p>
              </div>

              {/* Error Alert */}
              {error && (
                <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-1.5 shrink-0"></span>
                  <span className="font-medium leading-relaxed">{error}</span>
                </div>
              )}

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-700">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="trader@domain.com"
                      required
                      autoComplete="email"
                      className="w-full h-10 pl-9 pr-3.5 text-sm rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#0052FF] focus:ring-1 focus:ring-[#0052FF] transition-all"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-slate-700">
                      Password
                    </label>
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      required
                      autoComplete="current-password"
                      className="w-full h-10 pl-9 pr-10 text-sm rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#0052FF] focus:ring-1 focus:ring-[#0052FF] transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700 rounded transition-colors"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-10 mt-2 bg-[#0052FF] hover:bg-[#0047D0] active:bg-[#0038A8] text-white font-semibold text-sm rounded-lg shadow-sm flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#0052FF] focus:ring-offset-2"
                >
                  {loading ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <>
                      <span>Enter Trading Terminal</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>

              {/* Registration Prompt */}
              <div className="mt-6 pt-5 border-t border-slate-200/80 text-center">
                <p className="text-xs text-slate-600">
                  Don't have an execution account?{' '}
                  <Link
                    to="/register"
                    className="font-semibold text-[#0052FF] hover:text-[#0040C7] inline-flex items-center gap-0.5 transition-colors"
                  >
                    <span>Register now</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </p>
              </div>

              {/* Security Tag */}
              <div className="mt-5 flex items-center justify-center gap-2 text-[11px] text-slate-400">
                <Lock className="w-3 h-3 text-slate-400" />
                <span>256-bit TLS Protected Session</span>
              </div>
            </div>
          </div>

        </div>
      </main>

      {/* Footer */}
      <footer className="w-full py-4 text-center text-xs text-slate-500 border-t border-slate-200/80 bg-white">
        <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px]">
          <span>OptionAlgo Terminal v2.4 • Integrated with Angel One SmartAPI</span>
          <span className="text-slate-400">Algorithmic Trading Systems • All Rights Reserved</span>
        </div>
      </footer>
    </div>
  );
};

export default LoginPage;

