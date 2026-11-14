import React from 'react';
import LoginHero from './LoginHero';
import LoginForm from './LoginForm';

/**
 * LoginPage — Angel One-inspired two-panel layout.
 *
 * LEFT  (42%, lg+): light lavender-indigo panel, trading mockup, headline, trust signals.
 * RIGHT (flex-1):   light background + centered floating auth card (OA brand inside).
 *
 * No top navbar — branding lives inside the form card, like Angel One's design.
 * Auth logic is 100% in LoginForm → AuthContext, unchanged.
 */
const LoginPage: React.FC = () => (
  <div className="mobile-auth-page min-h-screen max-md:min-h-[100dvh] flex select-none">
    {/* ── Left panel ── */}
    <div className="hidden lg:block w-[42%] flex-shrink-0">
      <LoginHero />
    </div>

    {/* ── Right panel ── */}
    <LoginForm />
  </div>
);

export default LoginPage;

