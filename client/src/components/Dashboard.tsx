import React from 'react';
import { Wifi, WifiOff, Mic, MicOff } from 'lucide-react';
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold text-slate-100 mb-2">EchoHost</h1>
          <p className="text-lg text-slate-400">Aviation AI Voice Assistant</p>
        </div>

        {/* Status & Control Section */}
        <div className="space-y-6">
          {/* Connection Status */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-sm text-slate-500 mb-2">Server Status</p>
                <div className="flex items-center gap-3">
                  {socketConnected ? (
                    <>
                      <div className="w-4 h-4 bg-green-500 rounded-full animate-pulse" />
                      <span className="text-xl font-semibold text-green-400">Connected</span>
                    </>
                  ) : (
                    <>
                      <div className="w-4 h-4 bg-red-500 rounded-full" />
                      <span className="text-xl font-semibold text-red-400">Disconnected</span>
                    </>
                  )}
                </div>
              </div>
              {socketConnected && sessionId && (
                <div className="text-right">
                  <p className="text-xs text-slate-500">Session</p>
                  <p className="text-sm font-mono text-slate-300">{sessionId.slice(0, 12)}...</p>
                </div>
              )}
            </div>

            {!socketConnected && (
              <div className="bg-red-950 border border-red-800 rounded-lg p-4 text-sm text-red-200">
                ⚠️ Unable to connect to server. Make sure the backend is running on http://localhost:3001
              </div>
            )}
          </div>

          {/* Pipeline Status */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <p className="text-sm text-slate-500 mb-4">Pipeline Status</p>
            <PipelineStatus phase={state?.phase ?? 'error'} isStreaming={isStreaming} />
          </div>

          {/* Audio Visualizer */}
          {isStreaming && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
              <p className="text-sm text-slate-500 mb-4">Audio Level</p>
              <AudioVisualizer rmsDb={state?.transcript ? -20 : -60} isActive={isStreaming} />
            </div>
          )}

          {/* Main Control Button */}
          <button
            onClick={isStreaming ? onStopStreaming : handleStartStreaming}
            disabled={!socketConnected || isLoading}
            className={`w-full py-4 px-6 rounded-xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-200 ${
              isStreaming
                ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800'
                : 'bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800'
            } disabled:opacity-50 disabled:cursor-not-allowed text-white shadow-lg hover:shadow-xl disabled:shadow-none`}
          >
            {isStreaming ? (
              <>
                <MicOff className="w-6 h-6" />
                Stop Recording
              </>
            ) : (
              <>
                <Mic className="w-6 h-6" />
                {isLoading ? 'Starting...' : 'Start Recording'}
              </>
            )}
          </button>

          {/* Instructions */}
          <div className="bg-blue-950 border border-blue-800 rounded-xl p-4 text-sm text-blue-200">
            <p className="font-semibold mb-2">📝 How to use:</p>
            <ul className="space-y-1 text-xs">
              <li>✓ Click "Start Recording" to begin</li>
              <li>✓ Speak your aviation question or request</li>
              <li>✓ The AI will process and respond</li>
              <li>✓ Click "Stop Recording" when done</li>
            </ul>
          </div>

          {/* Transcript Area */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <p className="text-sm text-slate-500 mb-4">Transcript</p>
            <TranscriptBox currentText={state?.transcript ?? ''} isFinal={state?.isFinal ?? false} />
          </div>

          {/* Activity Feed */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <p className="text-sm text-slate-500 mb-4">Activity</p>
            <ActivityFeed entries={activityEntries} />
          </div>

          {/* Error Display */}
          {state?.error && (
            <div className="bg-red-950 border border-red-700 rounded-xl p-4">
              <p className="text-sm font-semibold text-red-300 mb-2">❌ Error</p>
              <p className="text-sm text-red-200">{state.error.message}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-slate-600 mt-12 pt-6 border-t border-slate-700">
          <p>EchoHost v0.1.0 • Powered by NVIDIA NIM</p>
        </div>
      </div>
    </div>
  );
};
