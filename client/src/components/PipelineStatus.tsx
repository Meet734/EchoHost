import React from 'react';

interface PipelineStatusProps {
  phase: string;
  isStreaming: boolean;
}

export const PipelineStatus: React.FC<PipelineStatusProps> = ({ phase, isStreaming }) => {
  const labels: Record<string, string> = {
    IDLE: '⭕ Idle',
    LISTENING: '🎤 Listening',
    VAD_ACTIVE: '📊 Voice Detected',
    TRANSCRIBING: '📝 Transcribing',
    REASONING: '🧠 Reasoning',
    SPEAKING: '🔊 Speaking',
    ERROR: '❌ Error',
  };

  const colors: Record<string, string> = {
    IDLE: 'bg-slate-700 border-slate-600 text-slate-200',
    LISTENING: 'bg-blue-900 border-blue-700 text-blue-200 animate-pulse',
    VAD_ACTIVE: 'bg-purple-900 border-purple-700 text-purple-200 animate-pulse',
    TRANSCRIBING: 'bg-indigo-900 border-indigo-700 text-indigo-200 animate-pulse',
    REASONING: 'bg-yellow-900 border-yellow-700 text-yellow-200 animate-pulse',
    SPEAKING: 'bg-green-900 border-green-700 text-green-200 animate-pulse',
    ERROR: 'bg-red-900 border-red-700 text-red-200',
  };

  const label = labels[phase] ?? phase;
  const color = colors[phase] ?? colors['IDLE'];

  return (
    <div className="flex items-center gap-2">
      <div className={`flex-1 px-3 py-2 rounded-lg border text-sm font-semibold text-center ${color}`}>
        {label}
      </div>
      {isStreaming && (
        <div className="flex gap-1 items-center px-2 py-1 bg-green-950 border border-green-700 rounded-lg">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-green-300">LIVE</span>
        </div>
      )}
    </div>
  );
};
