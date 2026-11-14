import React from 'react';
import LoginHero from './LoginHero';
import LoginForm from './LoginForm';

/**
 * LoginPage — Angel One-inspired institutional two-panel layout.
 *
 * LEFT  (44%, lg+): light lavender-indigo panel, trading mockup, headline, trust signals.
 * RIGHT (flex-1):   crisp light background + centered floating auth card (OA brand inside).
 *
 * No top navbar — branding lives inside the form card, matching the Angel One design language.
 * Auth logic is 100% in LoginForm → AuthContext, unchanged.
 */
const LoginPage: React.FC = () => (
  <div className="mobile-auth-page min-h-screen max-md:min-h-[100dvh] flex flex-col lg:flex-row select-none bg-[#F8FAFC]">
    {/* ── Left Hero Panel ── */}
    <div className="hidden lg:block w-[44%] xl:w-[42%] flex-shrink-0 h-screen sticky top-0">
      <LoginHero />
    </div>

    {/* ── Right Authentication Panel ── */}
    <div className="flex-1 flex flex-col justify-center min-h-screen max-md:min-h-[100dvh]">
      <LoginForm />
    </div>
  </div>
);

export default LoginPage;
