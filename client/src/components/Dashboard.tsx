import React from 'react';
import {
  Wifi,
  WifiOff,
  Mic,
  MicOff,
  Copy,
} from 'lucide-react';
import { AudioVisualizer } from './AudioVisualizer';
import { PipelineStatus } from './PipelineStatus';
import { TranscriptBox } from './TranscriptBox';
import { ActivityFeed, type ActivityEntry } from './ActivityFeed';
import type { SystemState } from '../../../shared/types';

interface DashboardProps {
  socketConnected: boolean;
  isStreaming: boolean;
  sessionId: string | null;
  state: SystemState | null;
  onStartStreaming: () => Promise<void>;
  onStopStreaming: () => void;
  activityEntries: ActivityEntry[];
}

export const Dashboard: React.FC<DashboardProps> = ({
  socketConnected,
  isStreaming,
  sessionId,
  state,
  onStartStreaming,
  onStopStreaming,
  activityEntries,
}) => {
  const [isLoading, setIsLoading] = React.useState(false);
  const [copiedId, setCopiedId] = React.useState(false);

  const handleStartStreaming = async () => {
    setIsLoading(true);
    try {
      await onStartStreaming();
    } catch (err) {
      console.error('Failed to start streaming:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const copySessionId = () => {
    if (sessionId) {
      navigator.clipboard.writeText(sessionId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 pb-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-100">EchoHost Dashboard</h1>
            <p className="text-sm text-slate-400 mt-1">
              Low-latency S2S Aviation AI Worker
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              {socketConnected ? (
                <>
                  <Wifi className="w-5 h-5 text-green-400" />
                  <span className="text-sm text-green-400">Connected</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-5 h-5 text-red-400" />
                  <span className="text-sm text-red-400">Disconnected</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Session Info */}
        {sessionId && (
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500">Session ID</p>
              <p className="text-sm font-mono text-slate-300">{sessionId}</p>
            </div>
            <button
              onClick={copySessionId}
              className="p-2 hover:bg-slate-800 rounded transition-colors"
              title="Copy Session ID"
            >
              <Copy className={`w-4 h-4 ${copiedId ? 'text-green-400' : 'text-slate-400'}`} />
            </button>
          </div>
        )}

        {/* Main Content Grid */}
        <div className="grid grid-cols-3 gap-6">
          {/* Left Column - Audio and Pipeline */}
          <div className="col-span-2 space-y-6">
            {/* Audio Visualizer */}
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-slate-200 mb-4">Real-time Audio Level</h3>
              <AudioVisualizer
                rmsDb={state?.transcript ? -20 : -60}
                isActive={isStreaming}
              />
            </div>

            {/* Pipeline Status */}
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
              <PipelineStatus
                phase={state?.phase ?? 'error'}
                isStreaming={isStreaming}
              />
            </div>

            {/* Control Button */}
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
              <button
                onClick={isStreaming ? onStopStreaming : handleStartStreaming}
                disabled={!socketConnected || isLoading}
                className={`w-full py-3 px-4 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all ${
                  isStreaming
                    ? 'bg-red-600 hover:bg-red-700 disabled:bg-red-900'
                    : 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-900'
                } disabled:opacity-50 disabled:cursor-not-allowed text-white`}
              >
                {isStreaming ? (
                  <>
                    <MicOff className="w-5 h-5" />
                    Stop Streaming
                  </>
                ) : (
                  <>
                    <Mic className="w-5 h-5" />
                    {isLoading ? 'Starting...' : 'Start Streaming'}
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Right Column - Info and Latency */}
          <div className="space-y-6">
            {/* System State Info */}
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-200">System State</h3>

              <div>
                <p className="text-xs text-slate-500">Phase</p>
                <p className="text-sm font-mono text-slate-300">{state?.phase ?? 'N/A'}</p>
              </div>

              <div>
                <p className="text-xs text-slate-500">Session</p>
                <p className="text-sm font-mono text-slate-300">
                  {state?.sessionId ? state.sessionId.slice(0, 8) + '...' : 'None'}
                </p>
              </div>

              {state?.lastTurnLatency && (
                <div className="pt-2 border-t border-slate-700 space-y-2">
                  <p className="text-xs font-semibold text-slate-300">Latency Breakdown</p>

                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">ASR</span>
                    <span className="text-slate-300 font-mono">
                      {state.lastTurnLatency.asrMs}ms
                    </span>
                  </div>

                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Reasoning</span>
                    <span className="text-slate-300 font-mono">
                      {state.lastTurnLatency.reasoningMs}ms
                    </span>
                  </div>

                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">TTS</span>
                    <span className="text-slate-300 font-mono">
                      {state.lastTurnLatency.ttsMs}ms
                    </span>
                  </div>

                  <div className="flex justify-between text-xs pt-2 border-t border-slate-700">
                    <span className="text-slate-400 font-semibold">E2E</span>
                    <span className="text-green-400 font-mono font-bold">
                      {state.lastTurnLatency.e2eMs}ms
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Error State */}
            {state?.error && (
              <div className="bg-red-950 border border-red-700 rounded-lg p-4 space-y-2">
                <p className="text-xs font-semibold text-red-300">Error</p>
                <p className="text-xs text-red-200">{state.error.message}</p>
                <p className="text-xs text-red-400">
                  {state.error.layer ? `Layer: ${state.error.layer}` : 'Unknown layer'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Row - Transcript and Activity Feed */}
        <div className="grid grid-cols-2 gap-6 h-64">
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
            <TranscriptBox
              currentText={state?.transcript ?? ''}
              isFinal={state?.isFinal ?? false}
            />
          </div>

          <div className="bg-slate-900 border border-slate-700 rounded-lg p-4">
            <ActivityFeed entries={activityEntries} />
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-slate-500 pt-4 border-t border-slate-700">
          <p>EchoHost v0.1.0 - Powered by NVIDIA NIM</p>
        </div>
      </div>
    </div>
  );
};
