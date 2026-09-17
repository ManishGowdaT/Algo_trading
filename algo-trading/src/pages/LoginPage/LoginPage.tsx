import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { LogIn, Mail, Lock, ShieldCheck } from 'lucide-react';

const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center p-4 select-none">
      <div className="max-w-sm w-full">
        {/* Header Branding */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center p-2.5 bg-[#0052FF] rounded-md shadow-sm mb-3">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-lg font-bold text-[#1E222D] tracking-tight">Institutional Trading Portal</h1>
          <p className="text-xs font-semibold text-[#787B86] mt-0.5">Angel One Automated Options Engine</p>
        </div>

        {/* Login Form Card */}
        <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-6 max-md:p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-[#F23645]/10 border border-[#F23645]/30 rounded">
                <p className="text-xs text-[#F23645] font-semibold">{error}</p>
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase text-[#787B86]">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#787B86]" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@angelone.com"
                  className="w-full pl-9 pr-3 py-2 bg-[#F0F3FA] border border-[#E0E3EB] rounded text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF]"
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase text-[#787B86]">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#787B86]" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-3 py-2 bg-[#F0F3FA] border border-[#E0E3EB] rounded text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF]"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-[#0052FF] hover:bg-[#0047D6] text-white font-bold text-xs uppercase tracking-wider rounded transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
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
          <Link to="/register" className="text-xs font-semibold text-[#0052FF] hover:underline">
            Create New Account
          </Link>
          <p className="text-[#787B86] text-[10px] font-bold uppercase tracking-wider">Enterprise Algo Terminal v2.4</p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;

