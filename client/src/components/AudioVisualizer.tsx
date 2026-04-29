import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  rmsDb: number;
  isActive: boolean;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ rmsDb, isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const smoothRmsRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;

      // Smooth the RMS value for visual continuity
      smoothRmsRef.current += (rmsDb - smoothRmsRef.current) * 0.1;

      // Normalize RMS to 0-1 range (typically -40 to 0 dB)
      const normalizedRms = Math.max(0, Math.min(1, (smoothRmsRef.current + 40) / 40));

      // Clear canvas
      ctx.fillStyle = isActive ? 'rgba(15, 23, 42, 0.8)' : 'rgba(15, 23, 42, 0.95)';
      ctx.fillRect(0, 0, width, height);

      // Draw grid
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.3)';
      ctx.lineWidth = 0.5;

      for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Draw waveform as pulsing bar
      const barWidth = width * 0.3;
      const barHeight = height * normalizedRms * 0.8;
      const barX = (width - barWidth) / 2;
      const barY = height - barHeight - 10;

      // Gradient for the bar
      const gradient = ctx.createLinearGradient(barX, barY + barHeight, barX, barY);

      if (isActive) {
        if (normalizedRms > 0.5) {
          gradient.addColorStop(0, 'rgba(239, 68, 68, 0.2)');
          gradient.addColorStop(1, 'rgba(239, 68, 68, 1)');
        } else if (normalizedRms > 0.2) {
          gradient.addColorStop(0, 'rgba(251, 146, 60, 0.2)');
          gradient.addColorStop(1, 'rgba(251, 146, 60, 1)');
        } else {
          gradient.addColorStop(0, 'rgba(34, 197, 94, 0.2)');
          gradient.addColorStop(1, 'rgba(34, 197, 94, 1)');
        }
      } else {
        gradient.addColorStop(0, 'rgba(71, 85, 105, 0.2)');
        gradient.addColorStop(1, 'rgba(71, 85, 105, 0.8)');
      }

      ctx.fillStyle = gradient;
      ctx.fillRect(barX, barY, barWidth, barHeight);

      // Draw RMS text
      ctx.fillStyle = 'rgba(226, 232, 240, 0.7)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${rmsDb.toFixed(1)} dB`, width / 2, 20);

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [rmsDb, isActive]);

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={200}
      className="w-full h-48 rounded-lg border border-slate-700 bg-slate-950"
    />
  );
};
