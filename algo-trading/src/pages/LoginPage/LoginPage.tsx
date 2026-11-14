import React from 'react';
import LoginNavbar from './LoginNavbar';
import LoginHero from './LoginHero';
import LoginForm from './LoginForm';

/**
 * LoginPage — composes Navbar + two-column card (Hero | Form) + footer.
 * Auth logic lives entirely in LoginForm → AuthContext.
 */
const LoginPage: React.FC = () => (
  <div className="mobile-auth-page min-h-screen max-md:min-h-[100dvh] bg-tok-page-bg flex flex-col select-none">

    {/* ── Top navbar ───────────────────────────────────────────────────── */}
    <LoginNavbar />

    {/* ── Main area ────────────────────────────────────────────────────── */}
    <main className="flex-1 flex items-center justify-center p-4 sm:p-6 lg:p-8">
      {/*
        Card: max-w-[1040px], two-column on desktop.
        Left col = hero (LoginHero hidden on < lg).
        Right col = form (full width on mobile).
      */}
      <div
        className="
          w-full max-w-[1040px]
          bg-white rounded-card shadow-card
          overflow-hidden
          grid grid-cols-1 lg:grid-cols-[1fr_480px]
          min-h-[540px]
        "
      >
        {/* Left — navy hero panel */}
        <LoginHero />

        {/* Right — form panel */}
        <div className="bg-white border-l-0 lg:border-l border-slate-200 flex flex-col px-8 sm:px-12">
          <LoginForm />
        </div>
      </div>
    </main>

    {/* ── Footer ───────────────────────────────────────────────────────── */}
    <footer className="py-4 text-center text-[11px] text-slate-400 border-t border-slate-200/60 bg-white/60 flex-shrink-0">
      <div className="max-w-[1040px] mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-1">
        <span>OptionAlgo Terminal v2.4 &nbsp;·&nbsp; Integrated with Angel One SmartAPI</span>
        <span>Algorithmic Trading Systems &nbsp;·&nbsp; All Rights Reserved</span>
      </div>
    </footer>
  </div>
);

export default LoginPage;

