import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, AlertCircle, X, Info } from 'lucide-react';

// ─── Input base class ────────────────────────────────────────────────────────
const inputCls =
  'w-full h-11 pl-10 pr-4 text-sm text-slate-900 bg-white ' +
  'border border-slate-200 rounded-input placeholder:text-slate-400 ' +
  'focus:outline-none focus:border-brand-primary focus:ring-[3px] focus:ring-brand-primary/[.12] ' +
  'transition-all duration-150';

// ─── Dismissible server-error alert ─────────────────────────────────────────
const ErrorAlert: React.FC<{ message: string; onDismiss: () => void }> = ({
  message,
  onDismiss,
}) => (
  <div
    role="alert"
    aria-live="assertive"
    className="flex items-start gap-2.5 p-3 mb-5 rounded-lg bg-red-50 border border-red-200 text-red-700"
  >
    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
    <p className="text-xs font-medium flex-1 leading-relaxed">{message}</p>
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss error"
      className="text-red-400 hover:text-red-600 p-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  </div>
);

// ─── Main LoginForm — Angel One card-style layout ────────────────────────────
/**
 * Right-panel authentication card.
 * Floats on a light background, logo at top, dashed separator, form, info strip.
 * Auth logic is 100% unchanged from the original.
 */
const LoginForm: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // ── Auth logic — UNCHANGED ────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      const queryRedirect = new URLSearchParams(location.search).get('redirect');
      const stateRedirect = (
        location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null
      )?.from;
      const redirectPath =
        queryRedirect ||
        (stateRedirect
          ? `${stateRedirect.pathname || ''}${stateRedirect.search || ''}${stateRedirect.hash || ''}`
          : '/dashboard');
      navigate(redirectPath.startsWith('/') ? redirectPath : '/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials or connection failed.');
    } finally {
      setLoading(false);
    }
  };
  // ─────────────────────────────────────────────────────────────────────────

  return (
    /* Right panel: very light background, center the card */
    <div className="flex-1 bg-[#F5F7FA] flex flex-col items-center justify-center p-6 min-h-full">

      {/* Floating card — Angel One style */}
      <div className="bg-white w-full max-w-[380px] rounded-card border border-slate-200/80 shadow-card overflow-hidden">

        {/* ── Card body ── */}
        <div className="px-8 pt-8 pb-6">

          {/* Logo + brand */}
          <div className="flex items-center gap-2.5 mb-6">
            <div className="w-8 h-8 rounded-lg bg-brand-primary flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-sm tracking-tighter leading-none">OA</span>
            </div>
            <div className="leading-none">
              <span className="font-bold text-[14px] text-slate-900 tracking-tight">OptionAlgo</span>
              <span className="block text-[10px] font-medium text-slate-500 tracking-widest uppercase mt-0.5">
                Automated Trading Suite
              </span>
            </div>
          </div>

          {/* Dashed separator — matches Angel One aesthetic */}
          <div className="border-b border-dashed border-slate-200 mb-6" />

          {/* Welcome text */}
          <p className="text-sm text-slate-500 mb-0.5">Welcome back!</p>
          <h1 className="text-[22px] font-bold text-slate-900 tracking-tightest mb-6 leading-tight">
            Sign in to continue
          </h1>

          {/* Server error */}
          {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}

          {/* ── Form ── */}
          <form onSubmit={handleSubmit} noValidate className="space-y-4">

            {/* Email */}
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="block text-[13px] font-medium text-slate-700">
                Email address
              </label>
              <div className="relative">
                <Mail
                  className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="trader@domain.com"
                  autoComplete="email"
                  required
                  disabled={loading}
                  className={inputCls}
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-[13px] font-medium text-slate-700">
                Password
              </label>
              <div className="relative">
                <Lock
                  className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  autoComplete="current-password"
                  required
                  disabled={loading}
                  className={`${inputCls} pr-11`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={loading}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Remember me */}
            <label className="flex items-center gap-2 cursor-pointer select-none group w-fit">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary focus:ring-offset-0 cursor-pointer"
                style={{ minHeight: 'unset' }}
              />
              <span className="text-[13px] text-slate-500 group-hover:text-slate-700 transition-colors">
                Remember me
              </span>
            </label>

            {/* Primary CTA — full-width, uppercase, Angel One "PROCEED" style */}
            <button
              type="submit"
              disabled={loading}
              className="
                w-full h-11 mt-1
                bg-brand-primary hover:bg-brand-hover active:scale-[.99]
                text-white font-bold text-[13px] tracking-widest uppercase rounded-input
                flex items-center justify-center gap-2
                shadow-card-sm
                transition-all duration-150
                disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100
                focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-primary/[.3] focus-visible:ring-offset-1
              "
            >
              {loading ? (
                <div
                  className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                  role="status"
                  aria-label="Signing in…"
                />
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>

        {/* ── Register link strip ── */}
        <div className="px-8 py-3.5 border-t border-slate-100 text-center">
          <p className="text-[12px] text-slate-500">
            New to OptionAlgo?{' '}
            <Link
              to="/register"
              className="font-bold text-brand-primary uppercase text-[11px] tracking-wide hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
            >
              Register Here
            </Link>
          </p>
        </div>

        {/* ── Info strip (Angel One "Welcome back! Enter your PIN…" equivalent) ── */}
        <div className="flex items-start gap-2.5 px-5 py-3 bg-blue-50 border-t border-blue-100">
          <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <p className="text-[11px] text-blue-700 leading-relaxed">
            Sign in to access your automated trading terminal and monitor live positions.
          </p>
        </div>
      </div>

      {/* Encrypted session note — below card */}
      <div className="flex items-center gap-1.5 mt-4 text-[11px] text-slate-400 select-none">
        <Lock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
        <span>Encrypted connection</span>
      </div>
    </div>
  );
};

export default LoginForm;

