import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Lock, Mail, ShieldCheck, UserPlus } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const RegisterPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register(email, password, confirmPassword);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mobile-auth-page min-h-screen max-md:min-h-[100dvh] bg-[#F8F9FA] flex items-center justify-center p-4 select-none">
      <div className="max-w-sm w-full">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center p-2.5 bg-[#0052FF] rounded-md shadow-sm mb-3">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-lg font-bold text-[#1E222D] tracking-tight">Create Trading Account</h1>
          <p className="text-xs font-semibold text-[#787B86] mt-0.5">Create your application login</p>
        </div>

        <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-6 max-md:p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-[#F23645]/10 border border-[#F23645]/30 rounded">
                <p className="text-xs text-[#F23645] font-semibold">{error}</p>
              </div>
            )}

            <label className="block text-[10px] font-bold uppercase text-[#787B86]">
              Email Address
              <div className="relative mt-1">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#787B86]" />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="user@example.com" className="w-full pl-9 pr-3 py-2 bg-[#F0F3FA] border border-[#E0E3EB] rounded text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF]" />
              </div>
            </label>

            <label className="block text-[10px] font-bold uppercase text-[#787B86]">
              Password
              <div className="relative mt-1">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#787B86]" />
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="At least 8 characters" className="w-full pl-9 pr-10 max-md:pr-12 py-2 bg-[#F0F3FA] border border-[#E0E3EB] rounded text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF]" />
                <button type="button" onClick={() => setShowPassword((visible) => !visible)} className="absolute right-1 top-1/2 flex h-9 w-9 max-md:h-11 max-md:w-11 -translate-y-1/2 items-center justify-center rounded text-[#787B86] hover:bg-[#E0E3EB]" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <label className="block text-[10px] font-bold uppercase text-[#787B86]">
              Confirm Password
              <div className="relative mt-1">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#787B86]" />
                <input type={showConfirmPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} placeholder="Repeat password" className="w-full pl-9 pr-10 max-md:pr-12 py-2 bg-[#F0F3FA] border border-[#E0E3EB] rounded text-xs font-semibold text-[#1E222D] outline-none focus:border-[#0052FF]" />
                <button type="button" onClick={() => setShowConfirmPassword((visible) => !visible)} className="absolute right-1 top-1/2 flex h-9 w-9 max-md:h-11 max-md:w-11 -translate-y-1/2 items-center justify-center rounded text-[#787B86] hover:bg-[#E0E3EB]" aria-label={showConfirmPassword ? 'Hide password confirmation' : 'Show password confirmation'}>
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <button type="submit" disabled={loading} className="w-full py-2.5 bg-[#0052FF] hover:bg-[#0047D6] text-white font-bold text-xs uppercase tracking-wider rounded transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
              {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <><span>Create Account</span><UserPlus className="w-3.5 h-3.5" /></>}
            </button>
          </form>
        </div>

        <div className="mt-5 text-center">
          <Link to="/login" className="mobile-auth-link text-xs font-semibold text-[#0052FF] hover:underline">Back to Sign In</Link>
        </div>
      </div>
    </div>
  );
};

export default RegisterPage;
