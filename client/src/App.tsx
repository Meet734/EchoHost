import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useVoiceStream } from './hooks/useVoiceStream';
import { Dashboard } from './components/Dashboard';
import type { ActivityEntry } from './components/ActivityFeed';

function App(): React.ReactElement {
  const voiceStreamOptions = useMemo(
    () => ({
      clientId: 'web-dashboard',
      language: 'en-US',
    }),
    [],
  );

  const voiceStream = useVoiceStream(voiceStreamOptions);

  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const maxActivityEntries = 50;
  const streamingStatusRef = useRef<boolean>(false);

  const addActivity = useCallback(
    (message: string, level: ActivityEntry['level'] = 'info') => {
      setActivities((prev) => {
        const newEntries = [
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            timestamp: Date.now(),
            level,
            message,
          },
        ];
        return newEntries.slice(-maxActivityEntries);
      });
    },
    [],
  );

  // Log connection status changes
  useEffect(() => {
    if (voiceStream.socketConnected) {
      addActivity('Socket connected to server', 'success');
    } else {
      addActivity('Socket disconnected', 'warning');
    }
  }, [voiceStream.socketConnected, addActivity]);

  // Log session changes
  useEffect(() => {
    if (voiceStream.sessionId) {
      addActivity(`Session created: ${voiceStream.sessionId}`, 'info');
    }
  }, [voiceStream.sessionId, addActivity]);

  // Log pipeline phase changes
  useEffect(() => {
    if (voiceStream.state?.phase) {
      const phaseMessages: Record<string, string> = {
        idle: 'Pipeline idle - ready for input',
        listening: 'Listening for speech',
        processing: 'Processing audio',
        speaking: 'Generating response',
        error: 'Pipeline error encountered',
      };

      const message = phaseMessages[voiceStream.state.phase];
      if (message) {
        const level = voiceStream.state.phase === 'error' ? 'error' : 'info';
        addActivity(`[FSM] ${message}`, level);
      }
    }
  }, [voiceStream.state?.phase, addActivity]);

  // Log transcript updates
  useEffect(() => {
    if (voiceStream.state?.transcript && voiceStream.state.isFinal) {
      addActivity(`Transcript finalized: "${voiceStream.state.transcript}"`, 'success');
    }
  }, [voiceStream.state?.transcript, voiceStream.state?.isFinal, addActivity]);

  // Log errors
  useEffect(() => {
    if (voiceStream.state?.error) {
      const {
        error: {
          code, message, layer,
        },
      } = voiceStream.state;
      addActivity(`Error [${layer}] ${code}: ${message}`, 'error');
    }
  }, [voiceStream.state?.error, addActivity]);

  // Log streaming status changes - FIXED: no dependency on activities to avoid loop
  useEffect(() => {
    if (voiceStream.isStreaming && !streamingStatusRef.current) {
      streamingStatusRef.current = true;
      addActivity('Audio streaming started', 'success');
    } else if (!voiceStream.isStreaming && streamingStatusRef.current) {
      streamingStatusRef.current = false;
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
