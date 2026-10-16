import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { LogIn, Mail, Lock, ShieldCheck, Eye, EyeOff } from 'lucide-react';

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
    <div className="mobile-auth-page min-h-screen max-md:min-h-[100dvh] bg-slate-950 text-slate-100 flex items-center justify-center p-4 select-none">
      <div className="max-w-sm w-full">
        {/* Header Branding */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center p-2.5 bg-cyan-400 rounded-md shadow-sm mb-3">
            <ShieldCheck className="w-6 h-6 text-slate-950" />
          </div>
          <h1 className="text-lg font-bold text-slate-100 tracking-tight">Institutional Trading Portal</h1>
          <p className="text-xs font-semibold text-slate-300 mt-0.5">Angel One Automated Options Engine</p>
        </div>

        {/* Login Form Card */}
        <div className="bg-slate-900 rounded-xl border border-slate-600 shadow-xl p-6 max-md:p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-rose-400/10 border border-rose-400/40 rounded">
                <p className="text-xs text-rose-200 font-semibold">{error}</p>
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase text-slate-300">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@angelone.com"
                  className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-500 rounded text-xs font-semibold text-slate-100 placeholder:text-slate-400 outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/40"
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase text-slate-300">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-10 max-md:pr-12 py-2 bg-slate-800 border border-slate-500 rounded text-xs font-semibold text-slate-100 placeholder:text-slate-400 outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/40"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute right-1 top-1/2 flex h-9 w-9 max-md:h-11 max-md:w-11 -translate-y-1/2 items-center justify-center rounded text-slate-300 hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-cyan-300"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-11 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 font-bold text-xs uppercase tracking-wider rounded transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-slate-950/30 border-t-slate-950 rounded-full animate-spin" />
              ) : (
                <>
                  <span>Sign In</span>
                  <LogIn className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </form>
        </div>

        <div className="mt-6 text-center">
          <Link to="/register" className="mobile-auth-link text-xs font-semibold text-cyan-300 hover:underline">
            Create New Account
          </Link>
          <p className="text-slate-300 text-[10px] font-bold uppercase tracking-wider">Enterprise Algo Terminal v2.4</p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;

