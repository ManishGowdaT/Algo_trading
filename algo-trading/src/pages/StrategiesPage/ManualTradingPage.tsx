import React, { useState, useEffect } from 'react';
import {
  Plus,
  History,
  BarChart2,
  ArrowRightLeft,
  Wallet,
  Activity
} from 'lucide-react';

import { usePageTitle } from '../../hooks/usePageTitle';
import { useAngelConnection } from '../../shared/angel/AngelConnectionProvider';
import { apiGet } from '../../trading';

type MarginData = {
  net: number;
  available: number;
  used: number;
};

type IndexPriceData = {
  ltp: number;
};

const ManualTradingPage: React.FC = () => {
  usePageTitle('Manual Trading');
  const { connectStatus } = useAngelConnection();

  const [margins, setMargins] = useState<MarginData | null>(null);
  const [indices, setIndices] = useState<Record<string, number>>({
    'NIFTY 50': 0,
    'SENSEX': 0,
    'BANK NIFTY': 0
  });

  // Fetch live account margins
  useEffect(() => {
    if (connectStatus !== 'connected') {
      setMargins(null);
      return;
    }

    let active = true;
    const fetchMargins = async () => {
      try {
        const response = await apiGet<any>('/angel/margins');
        if (!active) return;
        if (response && response.status && response.data) {
          const d = response.data;
          setMargins({
            net: parseFloat(d.net || '0'),
            available: parseFloat(d.availablecash || d.availablelimitmargin || '0'),
            used: parseFloat(d.utiliseddebits || '0')
          });
        }
      } catch (err) {
        console.error('Failed to fetch broker margins:', err);
      }
    };

    fetchMargins();
    const interval = setInterval(fetchMargins, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [connectStatus]);

  // Fetch live index spot prices
  useEffect(() => {
    if (connectStatus !== 'connected') return;

    let active = true;
    const fetchIndices = async () => {
      try {
        const [nifty, sensex, banknifty] = await Promise.all([
          apiGet<IndexPriceData>('/market/index-ltp?underlying=NIFTY').catch(() => ({ ltp: 0 })),
          apiGet<IndexPriceData>('/market/index-ltp?underlying=SENSEX').catch(() => ({ ltp: 0 })),
          apiGet<IndexPriceData>('/market/index-ltp?underlying=BANKNIFTY').catch(() => ({ ltp: 0 }))
        ]);

        if (!active) return;

        setIndices({
          'NIFTY 50': nifty.ltp,
          'SENSEX': sensex.ltp,
          'BANK NIFTY': banknifty.ltp
        });
      } catch (err) {
        console.error('Failed to fetch indices LTP:', err);
      }
    };

    fetchIndices();
    const interval = setInterval(fetchIndices, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [connectStatus]);

  const formatRupees = (val: number) => {
    return `₹${val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-4 select-none">
      {/* Top Action Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3.5 max-md:p-3 rounded border border-[#E0E3EB] shadow-sm">
        <div>
          <h1 className="text-sm font-bold text-[#1E222D] tracking-tight">Manual Execution Terminal</h1>
          <p className="text-[10px] font-medium text-[#787B86]">Direct Equity & Options Order Placement</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0052FF] hover:bg-[#0047D0] text-white text-xs font-semibold rounded shadow-sm transition-colors">
            <Plus className="w-3.5 h-3.5" />
            Place Order
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-[#F0F3FA] hover:bg-[#E0E3EB] border border-[#E0E3EB] text-[#434651] text-xs font-semibold rounded transition-colors">
            <History className="w-3.5 h-3.5" />
            Order Book
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Watchlist Section */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded border border-[#E0E3EB] shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E0E3EB] flex items-center justify-between bg-[#F8F9FA]">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#1E222D]">Spot Watchlist</h3>
              <button className="text-xs font-semibold text-[#0052FF] hover:underline">Manage List</button>
            </div>
            <div className="divide-y divide-[#E0E3EB]">
              {['NIFTY 50', 'SENSEX', 'BANK NIFTY'].map((idx) => (
                <div key={idx} className="px-4 py-3 flex items-center justify-between hover:bg-[#F8F9FA] transition-colors cursor-pointer group">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-[#F0F3FA] rounded flex items-center justify-center group-hover:bg-[#0052FF] transition-colors">
                      <BarChart2 className="w-4 h-4 text-[#787B86] group-hover:text-white" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-[#1E222D]">{idx}</p>
                      <p className="text-[10px] text-[#787B86] font-medium uppercase">Spot Index</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-bold text-[#1E222D] tabular-nums">
                      {connectStatus === 'connected' && indices[idx] > 0
                        ? formatRupees(indices[idx])
                        : '—'}
                    </p>
                    {connectStatus === 'connected' && indices[idx] > 0 && (
                      <span className="text-[9px] text-[#089981] font-bold uppercase">LIVE</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-2.5 bg-[#F8F9FA] border-t border-[#E0E3EB] text-center">
              <button className="text-[10px] font-bold uppercase text-[#787B86] hover:text-[#0052FF] transition-colors">View All Market Instruments</button>
            </div>
          </div>
        </div>

        {/* Account Summary Sidebar */}
        <div className="space-y-4">
          <div className="bg-[#1E222D] p-5 rounded border border-[#1E222D] text-white shadow-md">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-[#0052FF]" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#787B86]">Equity Funds</span>
              </div>
              <Activity className="w-3.5 h-3.5 text-[#089981]" />
            </div>
            <p className="text-2xl font-bold tabular-nums tracking-tight">
              {connectStatus === 'connected' && margins ? formatRupees(margins.net) : 'Broker Disconnected'}
            </p>
            <div className="mt-4 flex items-center justify-between pt-3 border-t border-[#434651]/40 text-xs">
              <div>
                <p className="text-[10px] font-medium text-[#787B86] uppercase">Margin Used</p>
                <p className="font-bold tabular-nums mt-0.5">
                  {connectStatus === 'connected' && margins ? formatRupees(margins.used) : '—'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-medium text-[#787B86] uppercase">Available Cash</p>
                <p className="font-bold tabular-nums mt-0.5">
                  {connectStatus === 'connected' && margins ? formatRupees(margins.available) : '—'}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded border border-[#E0E3EB] shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#1E222D] mb-3">Order Stream Log</h3>
            <div className="space-y-2">
              {[1, 2].map(i => (
                <div key={i} className="flex gap-3 p-2.5 rounded bg-[#F8F9FA] border border-[#E0E3EB] hover:border-[#0052FF] transition-colors">
                  <div className="w-7 h-7 bg-[#F0F3FA] rounded flex items-center justify-center flex-shrink-0">
                    <ArrowRightLeft className="w-3.5 h-3.5 text-[#787B86]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold text-[#1E222D]">NIFTY JUN PE</p>
                      <span className="text-[10px] font-bold text-[#F23645]">SELL</span>
                    </div>
                    <p className="text-[10px] text-[#787B86] font-medium uppercase mt-0.5">20 JUN • ₹145.20</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManualTradingPage;

