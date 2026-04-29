import React from 'react';
import type { PipelinePhase } from '../../../shared/types';

interface PipelineStatusProps {
  phase: PipelinePhase;
  isStreaming: boolean;
}

const phases: PipelinePhase[] = ['idle', 'listening', 'processing', 'speaking'];

export const PipelineStatus: React.FC<PipelineStatusProps> = ({ phase, isStreaming }) => {
  const getPhaseIndex = (p: PipelinePhase): number => {
    if (p === 'error') return -1;
    return phases.indexOf(p);
  };

  const currentIndex = getPhaseIndex(phase);
  const isError = phase === 'error';

  const getPhaseColor = (_p: PipelinePhase, idx: number): string => {
    if (isError) return 'bg-red-900 border-red-700';
    if (idx < currentIndex) return 'bg-green-900 border-green-700';
    if (idx === currentIndex) return 'bg-blue-900 border-blue-700 animate-pulse';
    return 'bg-slate-700 border-slate-600';
  };

  const getPhaseLabel = (p: PipelinePhase): string => {
    const labels: Record<PipelinePhase, string> = {
      idle: 'Idle',
      listening: 'Listening',
      processing: 'Processing',
      speaking: 'Speaking',
      error: 'Error',
    };
    return labels[p];
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Pipeline Status</h3>
        {isStreaming && (
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
            <span className="text-xs text-green-400">Streaming</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 items-center justify-between bg-slate-900 p-4 rounded-lg border border-slate-700">
        {phases.map((p, idx) => (
          <React.Fragment key={p}>
            <div
              className={`flex items-center justify-center w-28 h-10 rounded border transition-all ${getPhaseColor(p, idx)}`}
            >
              <span className="text-xs font-medium text-slate-200">{getPhaseLabel(p)}</span>
            </div>
            {idx < phases.length - 1 && (
              <div
                className={`flex-1 h-0.5 ${idx < currentIndex ? 'bg-green-600' : 'bg-slate-600'}`}
              ></div>
            )}
          </React.Fragment>
        ))}
      </div>

      {isError && (
        <div className="p-3 bg-red-900 border border-red-700 rounded text-xs text-red-100">
          Pipeline encountered an error. Please reconnect.
        </div>
      )}
    </div>
  );
};
