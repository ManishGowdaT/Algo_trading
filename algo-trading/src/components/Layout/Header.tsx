import React from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../shared/theme/ThemeProvider';
import {
    Sun,
    Moon,
    LogOut,
    User as UserIcon,
    Unplug,
    Settings,
    Bell,
    ChevronDown,
    Activity,
    Menu
} from 'lucide-react';
import { useAngelConnection } from '../../shared/angel/AngelConnectionProvider';

interface HeaderProps {
    onMobileMenuOpen?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onMobileMenuOpen }) => {
    const { user, logout } = useAuth();
    const { theme, toggleTheme } = useTheme();
    const { connectStatus, openConnect, disconnect } = useAngelConnection();
    const location = useLocation();

    const handleLogout = async () => {
        try {
            await logout();
            window.location.href = '/login';
        } catch (err) {
            console.error('Logout failed:', err);
        }
    };

    const getPageTitle = () => {
        const path = location.pathname;
        if (path === '/dashboard') return 'System Dashboard';
        if (path.startsWith('/strategies/')) {
            const strat = path.split('/').pop()?.replace(/-/g, ' ');
            return strat ? strat.charAt(0).toUpperCase() + strat.slice(1) : 'Trading Strategy';
        }
        if (path === '/trades') return 'Trade History';
        return 'Trading Terminal';
    };

    return (
        <header className="h-14 max-md:h-14 bg-white border-b border-[#E0E3EB] px-5 max-md:px-3 flex items-center justify-between sticky top-0 z-30 select-none">
            {/* Left Page Title & Live Badge */}
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
                <button
                    type="button"
                    aria-label="Open navigation"
                    className="hidden max-md:flex h-11 w-11 items-center justify-center rounded-lg text-[#787B86] hover:bg-[#F0F3FA] hover:text-[#1E222D]"
                    onClick={onMobileMenuOpen}
                >
                    <Menu className="w-5 h-5" />
                </button>
                <h2 className="truncate text-sm font-bold text-[#1E222D] flex items-center gap-2 tracking-tight capitalize">
                    {getPageTitle()}
                </h2>
                <span className="hidden sm:inline-flex items-center gap-1 bg-[#089981]/10 text-[#089981] text-[10px] font-bold px-2 py-0.5 rounded border border-[#089981]/20 uppercase tracking-wide">
                    <Activity className="w-3 h-3" /> Live Feed
                </span>
            </div>

            {/* Right Action Items & Account Profile */}
            <div className="flex items-center gap-2 md:gap-4 shrink-0">
                {/* Angel One Broker Connection Button */}
                <button
                    onClick={connectStatus === 'connected' ? disconnect : openConnect}
                    className={`
                        flex h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors
                        ${connectStatus === 'connected'
                            ? 'bg-[#089981]/10 text-[#089981] border-[#089981]/30 hover:bg-[#089981]/20'
                            : 'bg-[#F23645]/10 text-[#F23645] border-[#F23645]/30 hover:bg-[#F23645]/20'}
                    `}
                >
                    <Unplug className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{connectStatus === 'connected' ? 'Angel One Connected' : 'Connect Angel Broker'}</span>
                </button>

                <div className="hidden h-4 w-[1px] bg-[#E0E3EB] sm:block" />

                {/* Theme, Notifications & Settings Quick Actions */}
                <div className="flex items-center gap-1">
                    <button
                        onClick={toggleTheme}
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-[#787B86] hover:bg-[#F0F3FA] hover:text-[#1E222D] transition-colors"
                        title="Toggle Theme"
                    >
                        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                    </button>

                    <button aria-label="Notifications" className="hidden h-11 w-11 rounded-lg text-[#787B86] hover:bg-[#F0F3FA] hover:text-[#1E222D] transition-colors relative sm:flex sm:items-center sm:justify-center">
                        <Bell className="w-4 h-4" />
                        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-[#F23645] rounded-full" />
                    </button>

                    <button aria-label="Settings" className="hidden h-11 w-11 rounded-lg text-[#787B86] hover:bg-[#F0F3FA] hover:text-[#1E222D] transition-colors sm:flex sm:items-center sm:justify-center">
                        <Settings className="w-4 h-4" />
                    </button>
                </div>

                <div className="hidden h-4 w-[1px] bg-[#E0E3EB] sm:block" />

                {/* Institutional User Profile Dropdown */}
                <div className="group relative">
                    <button aria-label="Open account menu" className="flex h-11 items-center gap-1.5 rounded-lg border border-transparent px-1.5 hover:bg-[#F0F3FA] hover:border-[#E0E3EB] transition-colors">
                        <div className="w-7 h-7 bg-[#0052FF] rounded flex items-center justify-center text-white font-bold text-xs">
                            <UserIcon className="w-4 h-4" />
                        </div>
                        <div className="hidden sm:block text-left">
                            <p className="text-xs font-bold text-[#1E222D] leading-none">{user?.email?.split('@')[0] || 'Trader'}</p>
                            <p className="text-[9px] font-semibold text-[#787B86] uppercase leading-tight">Angel Pro</p>
                        </div>
                        <ChevronDown className="hidden w-3.5 h-3.5 text-[#787B86] transition-transform duration-200 sm:block sm:group-hover:rotate-180" />
                    </button>

                    {/* Dropdown Menu */}
                    <div className="absolute right-0 mt-1 w-44 bg-white border border-[#E0E3EB] rounded shadow-lg py-1 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-150 z-50">
                        <div className="px-3 py-1.5 border-b border-[#E0E3EB]">
                            <p className="text-[10px] font-bold text-[#787B86] uppercase tracking-wider">Account Overview</p>
                            <p className="text-xs font-semibold text-[#1E222D] truncate">{user?.email || 'trader@algo.com'}</p>
                        </div>
                        <button
                            onClick={handleLogout}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[#F23645] hover:bg-[#F23645]/10 transition-colors text-left"
                        >
                            <LogOut className="w-3.5 h-3.5" />
                            <span>Logout Session</span>
                        </button>
                    </div>
                </div>
            </div>
        </header>
    );
};

export default Header;

