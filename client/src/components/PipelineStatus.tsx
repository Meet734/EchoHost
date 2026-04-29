import React from 'react';

interface PipelineStatusProps {
  phase: string;
  isStreaming: boolean;
}

export const PipelineStatus: React.FC<PipelineStatusProps> = ({ phase, isStreaming }) => {
  const isError = phase === 'ERROR' || phase === 'error';

  const getPhaseLabel = (p: string): string => {
    const normalized = p.toLowerCase();
    const labels: Record<string, string> = {
      idle: '⭕ Idle',
      listening: '🎤 Listening',
      vad_active: '📊 Voice Detected',
      transcribing: '📝 Transcribing',
      reasoning: '🤔 Processing',
      speaking: '🔊 Speaking',
      error: '❌ Error',
    };
    return labels[normalized] ?? normalized;
  };

  const getPhaseColor = (): string => {
    const normalized = phase.toLowerCase();
    if (isError) return 'bg-red-900 border-red-700 text-red-100';
    const colors: Record<string, string> = {
      idle: 'bg-slate-700 border-slate-600 text-slate-100',
      listening: 'bg-blue-900 border-blue-700 text-blue-100 animate-pulse',
      vad_active: 'bg-purple-900 border-purple-700 text-purple-100 animate-pulse',
      transcribing: 'bg-indigo-900 border-indigo-700 text-indigo-100 animate-pulse',
      reasoning: 'bg-yellow-900 border-yellow-700 text-yellow-100 animate-pulse',
      speaking: 'bg-green-900 border-green-700 text-green-100 animate-pulse',
    };
    return colors[normalized] ?? colors.idle;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 justify-between">
        <div className={`flex-1 px-4 py-3 rounded-lg border font-semibold text-center ${getPhaseColor()}`}>
          {getPhaseLabel(phase)}
        </div>
        {isStreaming && (
          <div className="flex gap-2 items-center px-3 py-2 bg-green-950 border border-green-700 rounded-lg">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
            <span className="text-xs font-semibold text-green-300">Streaming</span>
          </div>
        )}
      </div>

      {isError && (
        <div className="p-3 bg-red-950 border border-red-700 rounded-lg text-sm text-red-200">
          Pipeline error - try reconnecting
        </div>
      )}
    </div>
  );
};
