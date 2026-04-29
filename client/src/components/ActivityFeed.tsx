import React, { useEffect, useRef } from 'react';

export interface ActivityEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
}

interface ActivityFeedProps {
  entries: ActivityEntry[];
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({ entries }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  const getLevelColor = (level: ActivityEntry['level']): string => {
    switch (level) {
      case 'success':
        return 'text-green-400';
      case 'info':
        return 'text-blue-400';
      case 'warning':
        return 'text-yellow-400';
      case 'error':
        return 'text-red-400';
      default:
        return 'text-slate-400';
    }
  };

  const getLevelBackground = (level: ActivityEntry['level']): string => {
    switch (level) {
      case 'success':
        return 'bg-green-950';
      case 'info':
        return 'bg-blue-950';
      case 'warning':
        return 'bg-yellow-950';
      case 'error':
        return 'bg-red-950';
      default:
        return 'bg-slate-900';
    }
  };

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="space-y-2 flex flex-col h-full">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Activity Feed</h3>
        <span className="text-xs text-slate-500">({entries.length})</span>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-hide bg-slate-900 rounded-lg border border-slate-700 p-3 space-y-1"
      >
        {entries.length === 0 && (
          <div className="text-slate-500 text-xs italic">No activity yet...</div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`flex gap-2 text-xs p-2 rounded border border-slate-600 ${getLevelBackground(entry.level)}`}
          >
            <span className="text-slate-500 flex-shrink-0">{formatTime(entry.timestamp)}</span>
            <span className={`font-mono font-semibold flex-shrink-0 ${getLevelColor(entry.level)}`}>
              [{entry.level.toUpperCase()}]
            </span>
            <span className="text-slate-300 flex-1 break-words">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
