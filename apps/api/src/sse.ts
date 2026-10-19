/**
 * Server-sent events over a hijacked Fastify reply (HANDOFF §6). Nginx must not buffer these
 * (X-Accel-Buffering: no, plus proxy_buffering off on the events location).
 */
import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const HEARTBEAT_MS = 15_000;

export class SseStream {
  closed = false;
  private readonly onEnd: (() => void)[] = [];

  constructor(private readonly raw: ServerResponse) {
    raw.on('close', () => this.markClosed());
  }

  send(event: string, data: unknown): boolean {
    if (this.closed || this.raw.writableEnded) return false;
    return this.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    if (this.closed || this.raw.writableEnded) return;
    this.raw.write(`: ${text}\n\n`);
  }

  /** run once when the stream ends for any reason (client gone, done, shutdown) */
  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.onEnd.push(fn);
  }

  end(): void {
    if (!this.raw.writableEnded) this.raw.end();
    this.markClosed();
  }

  private markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.onEnd.splice(0)) {
      try {
        fn();
      } catch {
        // cleanup must not throw into the socket close handler
      }
    }
  }
}

/** Open streams of one server, ended on shutdown so server.close() isn't held open. */
export class SseRegistry {
  readonly streams = new Set<SseStream>();
  endAll() {
    for (const s of [...this.streams]) s.end();
  }
}

/**
 * Take over the reply and write SSE headers. Headers already set on the reply by hooks
 * (CORS, rate-limit) are carried over because a hijacked reply skips Fastify's send path.
 */
export function openSse(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: SseRegistry,
  extra: Record<string, string> = {},
): SseStream {
  const carried: Record<string, string | string[] | number> = {};
  for (const [k, v] of Object.entries(reply.getHeaders())) {
    if (v != null) carried[k] = v as string | string[] | number;
  }
  reply.hijack();
  const socket = request.raw.socket;
  socket?.setTimeout?.(0);
  socket?.setNoDelay?.(true);
  socket?.setKeepAlive?.(true);
  reply.raw.writeHead(200, {
    ...carried,
    ...extra,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const stream = new SseStream(reply.raw);
  // tell EventSource how long to wait before reconnecting
  reply.raw.write('retry: 3000\n\n');
  registry.streams.add(stream);
  stream.onClose(() => registry.streams.delete(stream));
  const beat = setInterval(() => stream.comment('ping'), HEARTBEAT_MS);
  beat.unref?.();
  stream.onClose(() => clearInterval(beat));
  return stream;
}
