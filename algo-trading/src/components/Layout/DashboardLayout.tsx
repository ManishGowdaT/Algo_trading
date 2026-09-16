import React, { useCallback, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';

const DashboardLayout: React.FC = () => {
    const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
    const closeMobileNav = useCallback(() => setIsMobileNavOpen(false), []);
    const openMobileNav = useCallback(() => setIsMobileNavOpen(true), []);

    return (
        <div className="flex min-h-screen bg-[#F8F9FA] text-[#1E222D]">
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
                <main className="flex-1 p-4 md:p-5 max-md:p-3 overflow-y-auto">
                    <Outlet />
                </main>
            </div>
        </div>
    );
};

export default DashboardLayout;

