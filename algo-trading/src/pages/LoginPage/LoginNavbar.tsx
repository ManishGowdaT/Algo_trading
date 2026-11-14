import React from 'react';
import { Link } from 'react-router-dom';
import StatusPill from './StatusPill';

/**
 * Slim top navigation bar (64px) — login/register pages only.
 * Logo left, status pill + "Create account" right.
 */
const LoginNavbar: React.FC = () => (
  <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-8 flex-shrink-0">
    {/* Brand mark */}
    <div className="flex items-center gap-2.5">
      <div
        className="w-8 h-8 rounded-lg bg-brand-primary flex items-center justify-center select-none"
        aria-hidden="true"
      >
        <span className="text-white font-bold text-sm tracking-tighter leading-none">OA</span>
      </div>
      <div className="flex flex-col leading-none">
        <span className="text-[14px] font-bold text-slate-900 tracking-tight">OptionAlgo</span>
        <span className="text-[10px] font-medium text-slate-500 uppercase tracking-widest mt-0.5 hidden sm:block">
          Automated Trading Suite
        </span>
      </div>
    </div>

    {/* Right side */}
    <div className="flex items-center gap-4">
      <StatusPill active label="Angel One SmartAPI" className="hidden sm:inline-flex" />
      <div className="hidden sm:block w-px h-4 bg-slate-200" aria-hidden="true" />
      <Link
        to="/register"
        className="text-[13px] font-medium text-slate-700 hover:text-brand-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 rounded"
      >
        Create account
      </Link>
    </div>
  </header>
);

export default LoginNavbar;
