import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@echohost/shared';
import { StreamManager, type StreamManagerServices } from './orchestrator/stream-manager';
import { ASRService } from './services/asr-service';
import { ReasoningEngine } from './services/reasoning-engine';
import { TTSService } from './services/tts-service';

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number.parseInt(process.env.SOCKET_PORT ?? '3001', 10);

let globalServices: StreamManagerServices;
const activeManagers = new Set<StreamManager>();

async function bootstrap(): Promise<void> {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  const server = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: {
      origin: process.env.CLIENT_ORIGIN ?? '*',
      methods: ['GET', 'POST'],
      credentials: false,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25_000,
    pingTimeout: 60_000,
    maxHttpBufferSize: 1e6,
  });

  console.log('[INFO] Initialising AI services...');
  const asrService = new ASRService();
  const reasoningEngine = new ReasoningEngine();
  const ttsService = new TTSService();
  console.log('[SUCCESS] AI services ready.');

  globalServices = {
    asr: asrService,
    reasoning: reasoningEngine,
    tts: ttsService,
  };

  io.on('connection', (socket) => {
    console.log(`[INFO] Client connected: ${socket.id}`);

    const manager = new StreamManager(socket, globalServices);
    activeManagers.add(manager);

    socket.on('session:start', (data: { clientVersion: string }) => {
      console.log(`[INFO] session:start received from ${socket.id}, clientVersion=${data.clientVersion}`);
      manager.start(data.clientVersion);
    });

    socket.on('audio:chunk', (packet: ArrayBuffer | Uint8Array) => {
      manager.handleAudioChunk(packet);
    });

    socket.on('tts:interrupt', () => {
      manager.handleInterrupt();
    });

    socket.on('session:stop', async () => {
      console.log(`[INFO] Client requested session stop: ${socket.id}`);
      await manager.dispose();
      activeManagers.delete(manager);
    });

    socket.on('disconnect', async () => {
      console.log(`[INFO] Client disconnected: ${socket.id}`);
      await manager.dispose();
      activeManagers.delete(manager);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[SUCCESS] EchoHost server listening on http://${HOST}:${PORT}`);
    console.log(`[INFO] WebSocket endpoint: ws://${HOST}:${PORT}/socket.io/`);
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('[INFO] Shutdown signal received. Draining sessions...');
    io.close();

    const disposalPromises = Array.from(activeManagers).map(manager =>
      manager.dispose().catch(err => {
        console.error(`[ERROR] Error disposing manager ${manager.sessionId}:`, err);
      })
    );
    await Promise.all(disposalPromises);
    activeManagers.clear();

    server.close(() => {
      console.log('[SUCCESS] Server shut down cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERROR] Failed to bootstrap server: ${message}`);
  process.exit(1);
});

