import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, ArrowRight, AlertCircle, X } from 'lucide-react';

// ─── Shared input class ──────────────────────────────────────────────────────
const inputBase =
  'w-full h-11 pl-10 pr-4 text-sm text-slate-900 bg-white ' +
  'border border-slate-200 rounded-input placeholder:text-slate-400 ' +
  'focus:outline-none focus:border-brand-primary focus:ring-[3px] focus:ring-brand-primary/[.15] ' +
  'transition-all duration-150 disabled:opacity-60';

// ─── Error alert (dismissible) ───────────────────────────────────────────────
interface ErrorAlertProps {
  message: string;
  onDismiss: () => void;
}
const ErrorAlert: React.FC<ErrorAlertProps> = ({ message, onDismiss }) => (
  <div
    role="alert"
    aria-live="assertive"
    className="flex items-start gap-2.5 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 mb-5"
  >
    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
    <p className="text-xs font-medium flex-1 leading-relaxed">{message}</p>
    <button
      type="button"
      onClick={onDismiss}
      className="text-red-400 hover:text-red-600 p-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
      aria-label="Dismiss error"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  </div>
);

// ─── Main LoginForm ──────────────────────────────────────────────────────────
/**
 * Right-panel authentication form.
 * All auth logic is unchanged — only the presentation layer is here.
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

  // ─── Auth logic — UNCHANGED from original ─────────────────────────────────
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
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col justify-center w-full max-w-sm mx-auto py-12 px-0">

      {/* Heading */}
      <div className="mb-8">
        <h1 className="text-[28px] font-bold tracking-tightest text-slate-900 leading-tight">
          Terminal Login
        </h1>
        <p className="mt-1.5 text-sm text-slate-500">
          Sign in to connect your trading session.
        </p>
      </div>

      {/* Server error */}
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}

      <form onSubmit={handleSubmit} noValidate className="space-y-5">

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
              className={inputBase}
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
              placeholder="••••••••••••"
              autoComplete="current-password"
              required
              disabled={loading}
              className={`${inputBase} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              disabled={loading}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700 rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Remember me */}
        <div className="flex items-center justify-between pt-0.5">
          <label className="flex items-center gap-2 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary focus:ring-offset-0 cursor-pointer"
              style={{ minHeight: 'unset' }}
            />
            <span className="text-[13px] text-slate-600 group-hover:text-slate-900 transition-colors">
              Remember me
            </span>
          </label>
        </div>

        {/* Submit button */}
        <button
          type="submit"
          disabled={loading}
          className="
            w-full h-11 mt-1
            bg-brand-primary hover:bg-brand-hover active:scale-[.99]
            text-white font-semibold text-sm rounded-input
            flex items-center justify-center gap-2
            shadow-card-sm
            transition-all duration-150
            disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100
            focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-primary/[.35] focus-visible:ring-offset-1
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
              <span>Enter trading terminal</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </>
          )}
        </button>
      </form>

      {/* Divider */}
      <div className="flex items-center gap-3 my-6">
        <div className="flex-1 h-px bg-slate-200" />
        <span className="text-[12px] text-slate-400 font-medium">or</span>
        <div className="flex-1 h-px bg-slate-200" />
      </div>

      {/* Register */}
      <p className="text-[13px] text-slate-600 text-center">
        Don&apos;t have an account?{' '}
        <Link
          to="/register"
          className="font-semibold text-brand-primary hover:text-brand-hover transition-colors duration-150 focus-visible:outline-none focus-visible:underline"
        >
          Register now
        </Link>
      </p>

      {/* Encrypted connection note */}
      <div className="flex items-center justify-center gap-1.5 mt-6 text-[11px] text-slate-400">
        <Lock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
        <span>Encrypted connection</span>
      </div>
    </div>
  );
};

export default LoginForm;
