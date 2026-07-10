import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export function trackServerConnections(server: Server, sockets: Set<Socket>): void {
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
}

function forceCloseServerConnections(server: Server, sockets: Set<Socket>): void {
  try {
    server.closeIdleConnections?.();
  } catch {
    // Ignore shutdown errors during update install.
  }

  try {
    server.closeAllConnections?.();
  } catch {
    // Older Node builds may not support force-closing server connections.
  }

  for (const socket of sockets) {
    socket.destroy();
  }
}

export function closeServerForUpdateInstall(
  server: Server | null,
  sockets: Set<Socket>,
  forceAfterMs = 1500,
): Promise<void> {
  if (!server) {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      sockets.clear();
      resolve();
    };

    forceTimer = setTimeout(() => {
      forceCloseServerConnections(server, sockets);
      finish();
    }, forceAfterMs);
    forceTimer.unref?.();

    try {
      server.close(() => finish());
      server.closeIdleConnections?.();
    } catch {
      forceCloseServerConnections(server, sockets);
      finish();
    }
  });
}
