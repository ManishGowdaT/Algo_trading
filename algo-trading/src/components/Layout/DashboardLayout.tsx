import React, { useCallback, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import MobileBottomNav from './MobileBottomNav';
import { useLocation } from 'react-router-dom';

const DashboardLayout: React.FC = () => {
    const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
    const location = useLocation();
    const isActionScreen = ['/strategies/manual-trading', '/strategies/heikenashi', '/strategies/modified-heikenashi', '/strategies/5-min-breakout'].includes(location.pathname);
    const closeMobileNav = useCallback(() => setIsMobileNavOpen(false), []);
    const openMobileNav = useCallback(() => setIsMobileNavOpen(true), []);

    return (
        <div className={`mobile-layout ${isActionScreen ? 'mobile-layout-with-actions' : ''} flex min-h-screen max-md:min-h-[100dvh] bg-[#F8F9FA] text-[#1E222D]`}>
            <Sidebar isMobileOpen={isMobileNavOpen} onMobileClose={closeMobileNav} />
            {isMobileNavOpen && (
                <button
                    type="button"
                    aria-label="Close navigation"
                    className="fixed inset-0 z-50 hidden bg-slate-950/40 max-md:block"
                    onClick={closeMobileNav}
                />
            )}
            <div className="flex-1 flex flex-col min-w-0">
                <Header onMobileMenuOpen={openMobileNav} />
                <main className={`min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-5 max-md:overflow-visible max-md:overscroll-auto max-md:p-3 ${isActionScreen ? 'max-md:pb-[calc(5rem+env(safe-area-inset-bottom))]' : 'max-md:pb-[calc(6rem+env(safe-area-inset-bottom))]'}`}>
                    <Outlet />
                </main>
            </div>
            <MobileBottomNav />
        </div>
    );
};

export default DashboardLayout;

