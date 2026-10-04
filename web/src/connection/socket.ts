/* A WebSocket behind a small interface, so tests can swap in a fake. */

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  /** `code`: the close code, when the socket says (4410: the room has expired). */
  onClose(code?: number): void;
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
