import { PROTOCOL_VERSION, encodeMessage, parseMessage, serverMessageSchema } from "@stickyard/shared";

export type CheckStatus = "connecting" | "connected" | "reload" | "unreachable";

export const CONNECT_TIMEOUT_MS = 10_000;

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(): void;
  onError(): void;
}

export interface SocketLike {
  send(data: string): void;
  close(): void;
}

/** Creates a socket and wires its events to the handlers. Swapped for a fake in tests. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

export const browserSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event: MessageEvent<unknown>) => handlers.onMessage(event.data);
  ws.onclose = () => handlers.onClose();
  ws.onerror = () => handlers.onError();
  return { send: (data) => ws.send(data), close: () => ws.close() };
};

export interface CheckOptions {
  url: string;
  createSocket: SocketFactory;
  onStatus(status: CheckStatus): void;
}

/**
 * Connect, send `hello`, and report one of four states. Returns a stop function.
 * "reload" is final: once client and server disagree on the protocol, nothing else matters.
 */
export function startConnectionCheck({ url, createSocket, onStatus }: CheckOptions): () => void {
  let status: CheckStatus = "connecting";
  let stopped = false;
  let socket: SocketLike | null = null;

  const set = (next: CheckStatus) => {
    if (stopped || status === "reload" || status === next) return;
    status = next;
    onStatus(next);
  };

  const finish = (next: CheckStatus) => {
    set(next);
    clearTimeout(timer);
    socket?.close();
  };

  onStatus(status);
  const timer = setTimeout(() => {
    if (status === "connecting") finish("unreachable");
  }, CONNECT_TIMEOUT_MS);

  try {
    socket = createSocket(url, {
      onOpen: () => socket?.send(encodeMessage({ type: "hello", protocolVersion: PROTOCOL_VERSION })),
      onMessage: (data) => {
        const parsed = parseMessage(typeof data === "string" ? data : new ArrayBuffer(0), serverMessageSchema);
        if (!parsed.ok) return finish("reload");
        const message = parsed.value;
        if (message.type === "welcome") {
          if (message.protocolVersion !== PROTOCOL_VERSION) return finish("reload");
          clearTimeout(timer);
          return set("connected");
        }
        return finish(message.code === "version_mismatch" ? "reload" : "unreachable");
      },
      onClose: () => finish("unreachable"),
      onError: () => finish("unreachable"),
    });
  } catch {
    finish("unreachable");
  }

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
