import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, AlertCircle, X, Shield, ArrowRight } from 'lucide-react';

// ─── Input styling with high-precision focus states ─────────────────────────
const inputCls =
  'w-full h-11 pl-10 pr-4 text-sm text-slate-900 bg-white ' +
  'border border-slate-300 rounded-xl placeholder:text-slate-400 ' +
  'focus:outline-none focus:border-[#0052FF] focus:ring-4 focus:ring-[#0052FF]/10 ' +
  'transition-all duration-150';

// ─── Dismissible server-error alert ─────────────────────────────────────────
const ErrorAlert: React.FC<{ message: string; onDismiss: () => void }> = ({
  message,
  onDismiss,
}) => (
  <div
    role="alert"
    aria-live="assertive"
    className="flex items-start gap-2.5 p-3 mb-4 rounded-xl bg-red-50 border border-red-200 text-red-700"
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

// ─── Main LoginForm — Institutional Angel One Reference Card ─────────────────
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

  // ── Auth logic — 100% UNCHANGED ──────────────────────────────────────────
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
    <div className="flex-1 bg-[#F8FAFC] flex flex-col items-center justify-center p-6 sm:p-10 min-h-full">
      {/* Floating Card */}
      <div className="bg-white w-full max-w-[400px] rounded-2xl border border-slate-200/90 shadow-[0_20px_50px_-12px_rgba(15,23,42,0.08),0_1px_3px_rgba(15,23,42,0.04)] overflow-hidden">
        
        {/* Card Body */}
        <div className="p-7 sm:p-8">
          
          {/* Logo & Platform Branding */}
          <div className="flex items-center gap-3 mb-5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#0B5FFF] to-[#0047D0] flex items-center justify-center shadow-xs">
              <span className="text-white font-extrabold text-[13px] tracking-tight">OA</span>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-[15px] text-slate-900 tracking-tight leading-none">OptionAlgo</span>
                <span className="text-[9px] font-bold text-[#0052FF] bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">PRO</span>
              </div>
              <span className="block text-[10px] font-semibold text-slate-400 tracking-widest uppercase mt-0.5">
                Automated Trading Suite
              </span>
            </div>
          </div>

          {/* Clean Dashed Separator */}
          <div className="border-b border-dashed border-slate-200 mb-6" />

          {/* Heading */}
          <div className="mb-5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Welcome Back</span>
            <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight mt-0.5">
              Sign in to continue
            </h1>
          </div>

          {/* Server Error Alert */}
          {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            
            {/* Email Address */}
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="block text-xs font-semibold text-slate-700">
                Email address
              </label>
              <div className="relative">
                <Mail
                  className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
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
              <div className="flex items-center justify-between">
                <label htmlFor="login-password" className="block text-xs font-semibold text-slate-700">
                  Password
                </label>
              </div>
              <div className="relative">
                <Lock
                  className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0052FF]"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Remember Me */}
            <div className="flex items-center justify-between pt-0.5">
              <label className="flex items-center gap-2 cursor-pointer select-none group">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-[#0052FF] focus:ring-[#0052FF] focus:ring-offset-0 cursor-pointer"
                  style={{ minHeight: 'unset' }}
                />
                <span className="text-xs font-medium text-slate-600 group-hover:text-slate-900 transition-colors">
                  Remember me
                </span>
              </label>
            </div>

            {/* Primary Action Button */}
            <button
              type="submit"
              disabled={loading}
              className="
                w-full h-11 mt-1
                bg-[#0052FF] hover:bg-[#0047D0] active:scale-[0.99]
                text-white font-bold text-xs tracking-wider uppercase rounded-xl
                flex items-center justify-center gap-2
                shadow-sm hover:shadow-md
                transition-all duration-150
                disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100
                focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0052FF]/20
              "
            >
              {loading ? (
                <div
                  className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                  role="status"
                  aria-label="Signing in…"
                />
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Register Prompt */}
          <div className="mt-6 pt-4 border-t border-slate-100 text-center">
            <p className="text-xs text-slate-500">
              New to OptionAlgo?{' '}
              <Link
                to="/register"
                className="font-bold text-[#0052FF] hover:text-[#0047D0] tracking-wide uppercase text-[11px] hover:underline"
              >
                Register Here
              </Link>
            </p>
          </div>
        </div>

        {/* Informational Guidance Banner */}
        <div className="flex items-start gap-2.5 px-6 py-3 bg-blue-50/70 border-t border-blue-100/80">
          <Shield className="w-4 h-4 text-[#0052FF] mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-blue-900 leading-relaxed font-medium">
            Authorized session securely routes through Angel One SmartAPI with automated risk bounds.
          </p>
        </div>
      </div>

      {/* Security Tagline */}
      <div className="flex items-center gap-1.5 mt-5 text-[11px] font-medium text-slate-400 select-none">
        <Lock className="w-3.5 h-3.5 text-slate-400" />
        <span>256-bit TLS Protected Terminal Session</span>
      </div>
    </div>
  );
};

export default LoginForm;
