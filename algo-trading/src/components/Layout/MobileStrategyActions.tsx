import React from 'react';
import { Play, Square, XCircle } from 'lucide-react';

interface MobileStrategyActionsProps {
    isRunning: boolean;
    hasPosition: boolean;
    isExiting: boolean;
    canStart?: boolean;
    onStart: () => void;
    onStop: () => void;
    onExit: () => void;
}

const MobileStrategyActions: React.FC<MobileStrategyActionsProps> = ({
    isRunning,
    hasPosition,
    isExiting,
    canStart = true,
    onStart,
    onStop,
    onExit,
}) => (
    <div
        className="fixed inset-x-0 bottom-0 z-[45] hidden gap-2 border-t border-[#E0E3EB] bg-white/95 px-3 pt-2 shadow-[0_-4px_16px_rgba(30,34,45,0.08)] backdrop-blur max-md:flex"
        style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
        role="toolbar"
        aria-label="Strategy actions"
    >
        {hasPosition && (
            <button type="button" onClick={onExit} disabled={isExiting} className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#FF9800] px-3 text-xs font-bold text-white disabled:opacity-60">
                <XCircle className="h-4 w-4" />
                {isExiting ? 'Exiting…' : 'Exit Position'}
            </button>
        )}
        {isRunning ? (
            <button type="button" onClick={onStop} className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#F23645] px-3 text-xs font-bold text-white">
                <Square className="h-4 w-4 fill-current" />
                Stop Strategy
            </button>
        ) : (
            <button type="button" onClick={onStart} disabled={!canStart} className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#089981] px-3 text-xs font-bold text-white disabled:opacity-60">
                <Play className="h-4 w-4 fill-current" />
                Start Strategy
            </button>
        )}
    </div>
);

export default MobileStrategyActions;
