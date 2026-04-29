import React, { useEffect, useRef } from 'react';

interface TranscriptBoxProps {
  currentText: string;
  isFinal: boolean;
}

interface TranscriptEntry {
  text: string;
  isFinal: boolean;
  id: string;
}

export const TranscriptBox: React.FC<TranscriptBoxProps> = ({ currentText, isFinal }) => {
  const [entries, setEntries] = React.useState<TranscriptEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTextRef = useRef<string>('');

  useEffect(() => {
    // Track when new text is finalized
    if (isFinal && currentText && currentText !== lastTextRef.current) {
      setEntries((prev) => [
        ...prev,
        {
          text: currentText,
          isFinal: true,
          id: `final-${Date.now()}`,
        },
      ]);
      lastTextRef.current = currentText;
    }
  }, [isFinal, currentText]);

  useEffect(() => {
    // Auto-scroll to bottom
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, currentText]);

  return (
    <div className="space-y-2 flex flex-col h-full">
      <h3 className="text-sm font-semibold text-slate-200">Transcript</h3>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-hide bg-slate-900 rounded-lg border border-slate-700 p-4 space-y-2"
      >
        {entries.length === 0 && !currentText && (
          <div className="text-slate-500 text-sm italic">Waiting for audio input...</div>
        )}

        {entries.map((entry) => (
          <div key={entry.id} className="text-sm">
            <span className="text-slate-300">{entry.text}</span>
            {entry.isFinal && <span className="text-slate-500 text-xs ml-2">(final)</span>}
          </div>
        ))}

        {currentText && !isFinal && (
          <div className="text-sm">
            <span className="text-yellow-400">{currentText}</span>
            <span className="text-yellow-600 text-xs ml-2">(interim)</span>
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="text-xs text-slate-500 text-right">
          {entries.length} finalized statement{entries.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
};
