import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useVoiceStream } from './hooks/useVoiceStream';
import { Dashboard } from './components/Dashboard';
import type { ActivityEntry } from './components/ActivityFeed';

function App(): React.ReactElement {
  const voiceStream = useVoiceStream({ clientId: 'web-dashboard', language: 'en-US' });
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const streamingRef = useRef(false);

  const addActivity = useCallback((message: string, level: ActivityEntry['level'] = 'info') => {
    setActivities((prev) =>
      [...prev, { id: `${Date.now()}-${Math.random()}`, timestamp: Date.now(), level, message }].slice(-50)
    );
  }, []);

  useEffect(() => {
    if (voiceStream.socketConnected) addActivity('Socket connected to server', 'success');
    else addActivity('Socket disconnected', 'warning');
  }, [voiceStream.socketConnected, addActivity]);

  useEffect(() => {
    if (voiceStream.sessionId) addActivity(`Session created: ${voiceStream.sessionId}`, 'info');
  }, [voiceStream.sessionId, addActivity]);

  useEffect(() => {
    const phase = voiceStream.state.phase;
    if (!phase) return;
    const labels: Record<string, string> = {
      IDLE: 'Pipeline idle',
      LISTENING: 'Listening for speech',
      VAD_ACTIVE: 'Voice activity detected',
      TRANSCRIBING: 'Transcribing audio (ASR)',
      REASONING: 'Reasoning with NIM (LLM)',
      SPEAKING: 'Speaking response (TTS)',
      ERROR: 'Pipeline error',
    };
    const msg = labels[phase];
    if (msg) addActivity(`[FSM] ${msg}`, phase === 'ERROR' ? 'error' : 'info');
  }, [voiceStream.state.phase, addActivity]);

  useEffect(() => {
    if (voiceStream.state.isFinal && voiceStream.state.transcript) {
      addActivity(`Transcript: "${voiceStream.state.transcript}"`, 'success');
    }
  }, [voiceStream.state.transcript, voiceStream.state.isFinal, addActivity]);

  useEffect(() => {
    if (voiceStream.state.response) {
      addActivity(`Response: "${voiceStream.state.response}"`, 'success');
    }
  }, [voiceStream.state.response, addActivity]);

  useEffect(() => {
    if (voiceStream.state.error) {
      addActivity(`Error [${voiceStream.state.error.code}]: ${voiceStream.state.error.message}`, 'error');
    }
  }, [voiceStream.state.error, addActivity]);

  useEffect(() => {
    if (voiceStream.isStreaming && !streamingRef.current) {
      streamingRef.current = true;
      addActivity('Audio streaming started', 'success');
    } else if (!voiceStream.isStreaming && streamingRef.current) {
      streamingRef.current = false;
      addActivity('Audio streaming stopped', 'info');
    }
  }, [voiceStream.isStreaming, addActivity]);

  return (
    <Dashboard
      socketConnected={voiceStream.socketConnected}
      isStreaming={voiceStream.isStreaming}
      sessionId={voiceStream.sessionId}
      state={voiceStream.state}
      onStartStreaming={voiceStream.startStreaming}
      onStopStreaming={voiceStream.stopStreaming}
      activityEntries={activities}
    />
  );
}

export default App;
