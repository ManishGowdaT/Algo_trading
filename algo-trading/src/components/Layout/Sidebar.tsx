import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
    LayoutDashboard,
    Zap,
    ChevronDown,
    ChevronRight,
    Target,
    Activity,
    BarChart3,
    Clock,
    TrendingUp,
    Shield,
    History,
    X,
    Search
} from 'lucide-react';

interface SidebarProps {
    isMobileOpen?: boolean;
    onMobileClose?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ isMobileOpen = false, onMobileClose }) => {
    const location = useLocation();
    const [isStrategiesOpen, setIsStrategiesOpen] = useState(true);

    useEffect(() => {
        onMobileClose?.();
    }, [location.pathname, onMobileClose]);

    const strategies = [
        { name: 'Manual Trading', path: '/strategies/manual-trading', icon: Activity },
        { name: 'Heikenashi', path: '/strategies/heikenashi', icon: TrendingUp },
        { name: 'Mod Heikenashi', path: '/strategies/modified-heikenashi', icon: TrendingUp },
        { name: '5-Min Breakout', path: '/strategies/5-min-breakout', icon: Zap },
        { name: 'Ichimoku', path: '/strategies/ichimoku', icon: BarChart3 },
        { name: 'VWAP SMMA', path: '/strategies/vwap-smma', icon: Clock },
        { name: 'Expiry Strategy', path: '/strategies/expiry', icon: Target },
    ];

    const isActive = (path: string) => location.pathname === path;
    const isStrategyActive = strategies.some(s => isActive(s.path));

    return (
        <aside className={`mobile-sidebar w-56 bg-white border-r border-[#E0E3EB] h-screen flex flex-col sticky top-0 z-40 select-none max-md:h-[100dvh] max-md:fixed max-md:left-0 max-md:top-0 max-md:bottom-0 max-md:z-[60] max-md:w-72 max-md:transition-transform max-md:duration-200 ${isMobileOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}`}>
            {/* Platform Branding */}
            <div className="h-14 px-4 border-b border-[#E0E3EB] flex items-center gap-2.5">
                <div className="w-7 h-7 bg-[#0052FF] rounded flex items-center justify-center text-white shadow-sm">
                    <Shield className="w-4 h-4" />
                </div>
                <div className="flex flex-col">
                    <span className="text-sm font-bold tracking-tight text-[#1E222D]">OptionAlgo</span>
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-[#787B86]">Angel Algo Terminal</span>
                </div>
                <button
                    type="button"
                    aria-label="Close navigation"
                    className="ml-auto hidden max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center rounded text-[#787B86] hover:bg-[#F0F3FA]"
                    onClick={onMobileClose}
                >
                    <X className="w-5 h-5" />
                </button>
            </div>

            {/* Navigation Menu */}
            <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto custom-scrollbar">
                <div className="px-3 text-[10px] font-bold text-[#787B86] uppercase tracking-wider mb-2">Main Menu</div>

                <NavLink
                    to="/dashboard"
                    onClick={onMobileClose}
                    className={({ isActive }) => `
                        flex max-md:min-h-11 items-center gap-2.5 px-3 py-2 rounded text-xs font-semibold transition-colors
                        ${isActive
                            ? 'bg-[#0052FF]/10 text-[#0052FF]'
                            : 'text-[#434651] hover:bg-[#F0F3FA] hover:text-[#1E222D]'}
                    `}
                >
                    <LayoutDashboard className={`w-4 h-4 ${isActive('/dashboard') ? 'text-[#0052FF]' : 'text-[#787B86]'}`} />
                    <span>Dashboard</span>
                </NavLink>

                <NavLink to="/search" onClick={onMobileClose} className={({ isActive }) => `flex max-md:min-h-11 items-center gap-2.5 px-3 py-2 rounded text-xs font-semibold transition-colors ${isActive ? 'bg-[#0052FF]/10 text-[#0052FF]' : 'text-[#434651] hover:bg-[#F0F3FA]'}`}>
                    <Search className="w-4 h-4" /><span>Search</span>
                </NavLink>

                <NavLink
                    to="/trades"
                    onClick={onMobileClose}
                    className={({ isActive }) => `
                        flex max-md:min-h-11 items-center gap-2.5 px-3 py-2 rounded text-xs font-semibold transition-colors
                        ${isActive
                            ? 'bg-[#0052FF]/10 text-[#0052FF]'
                            : 'text-[#434651] hover:bg-[#F0F3FA] hover:text-[#1E222D]'}
                    `}
                >
                    <History className={`w-4 h-4 ${isActive('/trades') ? 'text-[#0052FF]' : 'text-[#787B86]'}`} />
                    <span>Trades</span>
                </NavLink>

                <div className="pt-1">
                    <button
                        onClick={() => setIsStrategiesOpen(!isStrategiesOpen)}
                        className={`
                            w-full max-md:min-h-11 flex items-center justify-between px-3 py-2 rounded text-xs font-semibold transition-colors
                            ${isStrategyActive
                                ? 'text-[#0052FF]'
                                : 'text-[#434651] hover:bg-[#F0F3FA] hover:text-[#1E222D]'}
                        `}
                    >
                        <div className="flex items-center gap-2.5">
                            <Zap className={`w-4 h-4 ${isStrategyActive ? 'text-[#0052FF]' : 'text-[#787B86]'}`} />
                            <span>Strategies</span>
                        </div>
                        {isStrategiesOpen ? <ChevronDown className="w-3.5 h-3.5 text-[#787B86]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#787B86]" />}
                    </button>

                    {isStrategiesOpen && (
                        <div className="ml-3 pl-3 border-l border-[#E0E3EB] mt-1 space-y-0.5">
                            {strategies.map((strat) => (
                                <NavLink
                                    key={strat.path}
                                    to={strat.path}
                                    onClick={onMobileClose}
                                    className={({ isActive }) => `
                                        flex max-md:min-h-11 items-center gap-2 px-2.5 py-1.5 rounded text-[11px] font-medium transition-colors
                                        ${isActive
                                            ? 'text-[#0052FF] bg-[#0052FF]/10 font-semibold'
                                            : 'text-[#5D606B] hover:bg-[#F0F3FA] hover:text-[#1E222D]'}
                                    `}
                                >
                                    <strat.icon className="w-3.5 h-3.5 opacity-70" />
                                    <span className="truncate">{strat.name}</span>
                                </NavLink>
                            ))}
                        </div>
                    )}
                </div>
            </nav>

            {/* Bottom System Status Panel */}
            <div className="p-3 border-t border-[#E0E3EB] bg-[#F8F9FA]">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#089981] opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#089981]"></span>
                        </span>
                        <span className="text-[11px] font-medium text-[#2A2E39]">Engine Active</span>
                    </div>
                    <span className="text-[9px] font-bold text-[#787B86] bg-[#E0E3EB] px-1.5 py-0.5 rounded uppercase">v1.0.0</span>
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;

