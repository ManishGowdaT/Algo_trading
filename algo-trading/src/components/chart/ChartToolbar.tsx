import React, { useState } from 'react';
import { Calendar, Eye, EyeOff, SlidersHorizontal, RotateCcw, Check } from 'lucide-react';
import type { LayerToggles } from './TradingViewChart';

type ChartToolbarProps = {
  timeframe: string;
  onTimeframeChange: (tf: string) => void;
  selectedDate: string;
  onDateChange: (date: string) => void;
  chartType: 'candlestick' | 'heikenAshi';
  onChartTypeChange: (type: 'candlestick' | 'heikenAshi') => void;
  toggles: LayerToggles;
  onToggleChange: (key: keyof LayerToggles) => void;
  emaPeriod: number;
  jmaLength: number;
  onApplyParams: (emaPeriod: number, jmaLength: number) => void;
};

export const ChartToolbar: React.FC<ChartToolbarProps> = ({
  timeframe,
  onTimeframeChange,
  selectedDate,
  onDateChange,
  chartType,
  onChartTypeChange,
  toggles,
  onToggleChange,
  emaPeriod,
  jmaLength,
  onApplyParams,
}) => {
  const [panelOpen, setPanelOpen] = useState(false);
  const [tempEma, setTempEma] = useState<number>(emaPeriod);
  const [tempJma, setTempJma] = useState<number>(jmaLength);

  const timeframes = [
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '1h', value: '1h' },
  ];

  const handleApply = () => {
    onApplyParams(Math.max(1, tempEma), Math.max(1, tempJma));
    setPanelOpen(false);
  };

  const handleReset = () => {
    setTempEma(20);
    setTempJma(7);
    onApplyParams(20, 7);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-2 max-md:flex-col max-md:items-stretch max-md:p-1.5 bg-[#F8F9FA] rounded border border-[#E0E3EB] mb-3 relative select-none">
      {/* Timeframe, Chart Type & Date */}
      <div className="flex items-center gap-3 max-md:w-full max-md:flex-col max-md:items-stretch max-md:gap-2">
        {/* Timeframe Selector */}
        <div className="flex items-center bg-[#E0E3EB] p-0.5 rounded max-md:w-full">
          {timeframes.map((tf) => (
            <button
              key={tf.value}
              onClick={() => onTimeframeChange(tf.value)}
              className={`px-2.5 py-1 max-md:min-h-11 max-md:flex-1 text-xs font-semibold rounded transition-colors ${
                timeframe === tf.value
                  ? 'bg-white text-[#0052FF] shadow-sm'
                  : 'text-[#5D606B] hover:text-[#1E222D]'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* Chart Type Selector */}
        <div className="flex items-center bg-[#E0E3EB] p-0.5 rounded max-md:w-full">
          <button
            onClick={() => onChartTypeChange('candlestick')}
            className={`px-2.5 py-1 max-md:min-h-11 max-md:flex-1 text-xs font-semibold rounded transition-colors ${
              chartType === 'candlestick'
                ? 'bg-white text-[#0052FF] shadow-sm'
                : 'text-[#5D606B] hover:text-[#1E222D]'
            }`}
            title="Standard Candlestick Chart"
          >
            🕯️ Regular
          </button>
          <button
            onClick={() => onChartTypeChange('heikenAshi')}
                className={`px-2.5 py-1 max-md:min-h-11 max-md:flex-1 text-xs font-semibold rounded transition-colors ${
              chartType === 'heikenAshi'
                ? 'bg-white text-[#0052FF] shadow-sm'
                : 'text-[#5D606B] hover:text-[#1E222D]'
            }`}
            title="Heiken Ashi Smoothed Chart"
          >
            📊 Heiken Ashi
          </button>
        </div>

        {/* Date Picker */}
        <div className="flex items-center gap-1.5 bg-white border border-[#E0E3EB] px-2.5 py-1 rounded max-md:w-full">
          <Calendar className="w-3.5 h-3.5 text-[#0052FF]" />
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="min-w-0 bg-transparent text-xs font-medium text-[#1E222D] outline-none border-none cursor-pointer max-md:flex-1"
          />
        </div>
      </div>

      {/* Indicators Panel Button & Controls */}
      <div className="relative flex items-center gap-2 max-md:w-full">
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          className={`flex items-center gap-1.5 px-3 py-1 max-md:min-h-11 max-md:w-full max-md:justify-center rounded text-xs font-semibold transition-colors border ${
            panelOpen
              ? 'bg-[#0052FF] text-white border-[#0052FF]'
              : 'bg-white text-[#1E222D] border-[#E0E3EB] hover:border-[#0052FF]'
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>Indicators &amp; Overlays</span>
        </button>

        {/* Indicators Popover Panel */}
        {panelOpen && (
          <div className="absolute right-0 top-9 w-72 max-md:fixed max-md:inset-x-2 max-md:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-md:top-auto max-md:right-auto max-md:w-auto max-md:max-w-none max-md:max-h-[calc(100vh-8rem)] max-md:max-h-[calc(100dvh-8rem)] max-md:overflow-y-auto max-md:rounded-2xl max-md:p-4 bg-white border border-[#E0E3EB] shadow-xl rounded p-3.5 z-50 space-y-3">
            <div className="flex items-center justify-between border-b border-[#E0E3EB] pb-2">
              <h4 className="text-xs font-bold uppercase text-[#1E222D] tracking-wider">
                Chart Indicators
              </h4>
              <span className="text-[9px] font-semibold text-[#787B86] bg-[#F0F3FA] px-1.5 py-0.5 rounded">Visual Overlay</span>
            </div>

            {/* EMA Settings */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => onToggleChange('showEma')}
                  className="flex items-center gap-2 text-xs font-medium text-[#1E222D]"
                >
                  {toggles.showEma ? <Eye className="w-3.5 h-3.5 text-[#0052FF]" /> : <EyeOff className="w-3.5 h-3.5 text-[#787B86]" />}
                  <span>Exponential Moving Avg (EMA)</span>
                </button>
              </div>
              <div className="flex items-center gap-2 pl-5">
                <label className="text-[10px] font-bold uppercase text-[#787B86]">Length:</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={tempEma}
                  onChange={(e) => setTempEma(parseInt(e.target.value) || 20)}
                  className="w-16 px-2 py-0.5 bg-[#F0F3FA] text-[#1E222D] rounded text-xs font-mono font-semibold outline-none border border-[#E0E3EB] focus:border-[#0052FF]"
                />
              </div>
            </div>

            {/* JMA Settings */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => onToggleChange('showJma')}
                  className="flex items-center gap-2 text-xs font-medium text-[#1E222D]"
                >
                  {toggles.showJma ? <Eye className="w-3.5 h-3.5 text-[#9C27B0]" /> : <EyeOff className="w-3.5 h-3.5 text-[#787B86]" />}
                  <span>Jurik Moving Avg (JMA)</span>
                </button>
              </div>
              <div className="flex items-center gap-2 pl-5">
                <label className="text-[10px] font-bold uppercase text-[#787B86]">Length:</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={tempJma}
                  onChange={(e) => setTempJma(parseInt(e.target.value) || 7)}
                  className="w-16 px-2 py-0.5 bg-[#F0F3FA] text-[#1E222D] rounded text-xs font-mono font-semibold outline-none border border-[#E0E3EB] focus:border-[#9C27B0]"
                />
              </div>
            </div>

            {/* Mod HA & Trades Toggles */}
            <div className="pt-2 border-t border-[#E0E3EB] space-y-1.5">
              <button
                onClick={() => onToggleChange('showMha')}
                className="flex items-center gap-2 max-md:min-h-11 text-xs font-medium text-[#1E222D] w-full"
              >
                {toggles.showMha ? <Eye className="w-3.5 h-3.5 text-[#0052FF]" /> : <EyeOff className="w-3.5 h-3.5 text-[#787B86]" />}
                <span>Modified Heiken Ashi Candles</span>
              </button>

              <button
                onClick={() => onToggleChange('showMarkers')}
                className="flex items-center gap-2 max-md:min-h-11 text-xs font-medium text-[#1E222D] w-full"
              >
                {toggles.showMarkers ? <Eye className="w-3.5 h-3.5 text-[#089981]" /> : <EyeOff className="w-3.5 h-3.5 text-[#787B86]" />}
                <span>Buy / Sell Trade Markers</span>
              </button>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2 border-t border-[#E0E3EB]">
              <button
                onClick={handleReset}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1 max-md:min-h-11 bg-[#F0F3FA] hover:bg-[#E0E3EB] text-[#434651] text-xs font-semibold rounded transition-colors"
              >
                <RotateCcw className="w-3 h-3" /> Reset
              </button>
              <button
                onClick={handleApply}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1 max-md:min-h-11 bg-[#0052FF] hover:bg-[#0047D0] text-white text-xs font-semibold rounded shadow-sm transition-colors"
              >
                <Check className="w-3 h-3" /> Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

