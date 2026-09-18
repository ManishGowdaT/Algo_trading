import React, { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Activity, BarChart3, Home, LogOut, UserRound, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const items = [
    { label: 'Home', path: '/dashboard', icon: Home },
    { label: 'Strategies', path: '/strategies', icon: Activity },
    { label: 'Trades', path: '/trades', icon: BarChart3 },
    { label: 'Orders', path: '/strategies/manual-trading', icon: Activity },
];

const MobileBottomNav: React.FC = () => {
    const location = useLocation();
    const { user, logout } = useAuth();
    const [isAccountOpen, setIsAccountOpen] = useState(false);
    const navigate = useNavigate();

    const handleLogout = async () => {
        await logout();
        navigate('/login', { replace: true });
    };

    return (
        <>
            <nav
                className="fixed inset-x-0 bottom-0 z-40 hidden border-t border-[#E0E3EB] bg-white/95 px-2 pt-2 shadow-[0_-4px_16px_rgba(30,34,45,0.08)] backdrop-blur max-md:block"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                aria-label="Mobile navigation"
            >
                <div className="grid grid-cols-5 gap-1">
                    {items.map(({ label, path, icon: Icon }) => (
                        <NavLink
                            key={label}
                            to={path}
                            className={({ isActive }) => `flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-semibold ${isActive || (label === 'Strategies' && location.pathname.startsWith('/strategies/')) ? 'bg-[#0052FF]/10 text-[#0052FF]' : 'text-[#787B86]'}`}
                            aria-label={label}
                        >
                            <Icon className="h-5 w-5" />
                            <span>{label}</span>
                        </NavLink>
                    ))}
                    <button
                        type="button"
                        onClick={() => setIsAccountOpen(true)}
                        className="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-semibold text-[#787B86]"
                        aria-label="Account"
                    >
                        <UserRound className="h-5 w-5" />
                        <span>Account</span>
                    </button>
                </div>
            </nav>

            {isAccountOpen && (
                <div className="fixed inset-0 z-[70] hidden bg-slate-950/40 max-md:block" onClick={() => setIsAccountOpen(false)}>
                    <section
                        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-4 shadow-2xl"
                        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Account"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="mb-3 flex items-center justify-between">
                            <div>
                                <p className="text-[10px] font-bold uppercase tracking-wider text-[#787B86]">Account</p>
                                <p className="max-w-[280px] truncate text-sm font-semibold text-[#1E222D]">{user?.email || 'Trader'}</p>
                            </div>
                            <button type="button" onClick={() => setIsAccountOpen(false)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[#787B86]" aria-label="Close account">
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <button type="button" onClick={() => void handleLogout()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#F23645]/10 px-4 text-sm font-semibold text-[#F23645]">
                            <LogOut className="h-4 w-4" />
                            Logout Session
                        </button>
                    </section>
                </div>
            )}
        </>
    );
};

export default MobileBottomNav;
