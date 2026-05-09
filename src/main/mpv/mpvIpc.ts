/**
 * mpv JSON IPC client.
 *
 * Connects to an mpv socket (Unix domain socket or Windows named pipe)
 * and exchanges JSON commands using mpv's JSON IPC protocol.
 *
 * Each command gets a unique request_id so responses are matched back to the
 * correct caller even when mpv sends async event messages in between.
 */

import net from 'node:net';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const COMMAND_TIMEOUT_MS = 2000;

export class MpvIpc {
  private socket: net.Socket | undefined;
  private requestId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';

  constructor(private readonly ipcPath: string) {}

  /** Connect to the running mpv IPC socket. Rejects if mpv is not yet ready. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.ipcPath);

      socket.once('connect', () => {
        this.socket = socket;
        resolve();
      });

      socket.once('error', reject);

      socket.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');

        // mpv sends newline-delimited JSON
        let nlIndex: number;
        while ((nlIndex = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nlIndex).trim();
          this.buffer = this.buffer.slice(nlIndex + 1);
          if (line.length > 0) this.handleLine(line);
        }
      });

      socket.on('close', () => {
        this.socket = undefined;
        // Reject any outstanding requests
        for (const [id, req] of this.pending) {
          clearTimeout(req.timeout);
          req.reject(new Error('mpv IPC socket closed'));
          this.pending.delete(id);
        }
      });
    });
  }

  private handleLine(line: string): void {
    let msg: Record<string, JsonValue>;
    try {
      msg = JSON.parse(line) as Record<string, JsonValue>;
    } catch {
      return; // Malformed line — ignore
    }

    // Response to a command we sent (has request_id)
    if (typeof msg['request_id'] === 'number') {
      const req = this.pending.get(msg['request_id'] as number);
      if (!req) return;

      this.pending.delete(msg['request_id'] as number);
      clearTimeout(req.timeout);

      const error = msg['error'];
      if (error && error !== 'success') {
        req.reject(new Error(`mpv error: ${error}`));
      } else {
        req.resolve((msg['data'] as JsonValue) ?? null);
      }
      return;
    }

    // Async event from mpv — no listener hookup yet; log if debugging.
    // Extend this class with EventEmitter if event handling is needed later.
  }

  /** Send a raw mpv JSON command and return the response data. */
  command(command: JsonValue[]): Promise<JsonValue> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('mpv IPC is not connected'));
    }

    const id = this.requestId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv command timed out: ${JSON.stringify(command)}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });

      const payload = JSON.stringify({ command, request_id: id }) + '\n';
      this.socket!.write(payload, 'utf8');
    });
  }

  /** Get an mpv property value. */
  getProperty(name: string): Promise<JsonValue> {
    return this.command(['get_property', name]);
  }

  /** Set an mpv property. */
  setProperty(name: string, value: JsonValue): Promise<JsonValue> {
    return this.command(['set_property', name, value]);
  }

  /** Destroy the socket connection. Outstanding requests are rejected. */
  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  get isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }
}
