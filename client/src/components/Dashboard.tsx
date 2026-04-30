import React from 'react';
import { Mic, MicOff } from 'lucide-react';
import { AudioVisualizer } from './AudioVisualizer';
import { PipelineStatus } from './PipelineStatus';
import { TranscriptBox } from './TranscriptBox';
import { ActivityFeed, type ActivityEntry } from './ActivityFeed';
import type { VoiceStreamState } from '../hooks/useVoiceStream';

interface DashboardProps {
  socketConnected: boolean;
  isStreaming: boolean;
  sessionId: string | null;
  state: VoiceStreamState;
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
    try { await onStartStreaming(); }
    catch (err) { console.error('Failed to start streaming:', err); }
    finally { setIsLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="text-center pt-4">
          <h1 className="text-4xl font-bold text-slate-100 mb-1">✈ EchoHost</h1>
          <p className="text-slate-400">Aviation AI Voice Worker · Powered by NVIDIA NIM</p>
        </div>

        {/* Status row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Connection */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-2">Server</p>
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${socketConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
              <span className={`font-semibold ${socketConnected ? 'text-green-400' : 'text-red-400'}`}>
                {socketConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            {sessionId && (
              <p className="text-xs font-mono text-slate-400 mt-1">{sessionId.slice(0, 16)}…</p>
            )}
          </div>

          {/* Pipeline Phase */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-2">Pipeline</p>
            <PipelineStatus phase={state.phase} isStreaming={isStreaming} />
          </div>

          {/* VAD */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-2">Voice Activity</p>
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-3 h-3 rounded-full ${state.isSpeaking ? 'bg-green-400 animate-pulse' : 'bg-slate-600'}`} />
              <span className="text-sm font-mono">{(state.vadProbability * 100).toFixed(0)}%</span>
              <span className="text-xs text-slate-400">{state.isSpeaking ? 'SPEECH' : 'SILENCE'}</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-100 ${state.isSpeaking ? 'bg-green-400' : 'bg-blue-500'}`}
                style={{ width: `${state.vadProbability * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Audio visualizer when streaming */}
        {isStreaming && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-3">Audio Level</p>
            <AudioVisualizer rmsDb={state.isSpeaking ? -20 : -55} isActive={isStreaming} />
          </div>
        )}

        {/* Control button */}
        <button
          onClick={isStreaming ? onStopStreaming : handleStartStreaming}
          disabled={!socketConnected || isLoading}
          className={`w-full py-4 px-6 rounded-xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-200 ${
            isStreaming
              ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800'
              : 'bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800'
          } disabled:opacity-50 disabled:cursor-not-allowed text-white shadow-lg`}
        >
          {isStreaming ? (
            <><MicOff className="w-5 h-5" /> Stop Recording</>
          ) : (
            <><Mic className="w-5 h-5" /> {isLoading ? 'Starting…' : 'Start Recording'}</>
          )}
        </button>

        {/* Transcript + Response */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-3">You Said</p>
            <TranscriptBox currentText={state.transcript} isFinal={state.isFinal} />
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-3">EchoHost Replied</p>
            <div className="bg-slate-900 rounded-lg border border-slate-700 p-3 min-h-[80px]">
              {state.response ? (
                <p className="text-sm text-green-300">{state.response}</p>
              ) : (
                <p className="text-sm text-slate-500 italic">Awaiting response…</p>
              )}
            </div>
            {state.intent && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="text-xs bg-purple-900 border border-purple-700 text-purple-200 px-2 py-1 rounded">
                  {state.intent.intent}
                </span>
                <span className="text-xs text-slate-500">
                  {(state.intent.confidence * 100).toFixed(0)}% conf
                </span>
                {Object.entries(state.intent.entities).map(([k, v]) => (
                  <span key={k} className="text-xs bg-slate-700 text-slate-300 px-2 py-1 rounded font-mono">
                    {k}={v}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Telemetry */}
        {state.telemetry && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-3">Latency — Turn #{state.telemetry.turnNumber}</p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'VAD', val: state.telemetry.latency.vadMs },
                { label: 'ASR', val: state.telemetry.latency.asrMs },
                { label: 'LLM', val: state.telemetry.latency.llmMs },
                { label: 'TTS first byte', val: state.telemetry.latency.ttsFirstByteMs },
                { label: 'Total', val: state.telemetry.latency.totalRoundTripMs, highlight: true },
              ].map(({ label, val, highlight }) => (
                <div key={label} className={`rounded-lg p-3 text-center ${highlight ? 'bg-blue-950 border border-blue-700' : 'bg-slate-900 border border-slate-700'}`}>
                  <p className="text-xs text-slate-400">{label}</p>
                  <p className={`text-lg font-bold font-mono ${highlight ? (val < 500 ? 'text-green-400' : 'text-red-400') : 'text-slate-200'}`}>
                    {val}ms
                  </p>
                </div>
              ))}
            </div>
            {state.telemetry.latency.totalRoundTripMs > 0 && (
              <p className={`text-xs mt-2 text-center ${state.telemetry.latency.totalRoundTripMs < 500 ? 'text-green-400' : 'text-red-400'}`}>
                {state.telemetry.latency.totalRoundTripMs < 500 ? '✓ Under 500ms SLA' : '✗ Over 500ms SLA'}
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {state.error && (
          <div className="bg-red-950 border border-red-700 rounded-xl p-4">
            <p className="text-sm font-semibold text-red-300 mb-1">❌ Error [{state.error.code}]</p>
            <p className="text-sm text-red-200">{state.error.message}</p>
          </div>
        )}

        {/* Activity Feed */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-3">Activity Log</p>
          <ActivityFeed entries={activityEntries} />
        </div>

        <div className="text-center text-xs text-slate-600 pb-4">
          EchoHost v0.1.0 · Node.js 22 · TypeScript 5 · Socket.io · NVIDIA NIM
        </div>
      </div>
    </div>
  );
};
