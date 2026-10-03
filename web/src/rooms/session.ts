import {
  PROTOCOL_VERSION,
  cleanName,
  cleanText,
  encodeMessage,
  parseMessage,
  serverMessageSchema,
  type ClientMessage,
  type Participant,
  type ServerMessage,
} from "@stickyard/shared";
import type { SocketFactory, SocketLike } from "../connection/socket";
import type { CodeCheck } from "./api";

/*
 * One visit to a room: connect, hello, join, then follow participants and echoes.
 * Everything the server sends is validated against the shared schema; anything this page
 * can't understand means it is out of date ("reload"). Names and text are kept as plain
 * strings and only ever rendered as text.
 */

export type RoomStatus = "idle" | "connecting" | "joined" | "invalid" | "full" | "reload" | "unreachable" | "disconnected";

export interface EchoEntry {
  key: number;
  from: string;
  name: string;
  colourIndex: number;
  text: string;
}

export interface RoomView {
  status: RoomStatus;
  you: Participant | null;
  participants: Participant[];
  messages: EchoEntry[];
  /** The last name was refused (locally or by the server). */
  nameError: boolean;
  /** The server said we're sending too fast. Cleared by our next accepted message. */
  rateLimited: boolean;
  /** For an aria-live region: "<name> joined" / "<name> left". */
  announcement: string;
}

export const INITIAL_VIEW: RoomView = {
  status: "idle",
  you: null,
  participants: [],
  messages: [],
  nameError: false,
  rateLimited: false,
  announcement: "",
};

export const JOIN_TIMEOUT_MS = 10_000;
/** Echoes kept on screen. */
export const MAX_MESSAGES = 100;

export interface SessionOptions {
  /** The room's WebSocket URL (with the code). */
  url: string;
  createSocket: SocketFactory;
  /** Asked when the socket fails before opening: was it the code, or the network? */
  checkCode(): Promise<CodeCheck>;
  onChange(view: RoomView): void;
}

export class RoomSession {
  private view: RoomView = INITIAL_VIEW;
  private socket: SocketLike | null = null;
  private opened = false;
  private welcomed = false;
  private stopped = false;
  private pendingName: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextKey = 0;
  /** Everyone seen in this visit, so echoes keep their sender's name after they leave. */
  private readonly known = new Map<string, Participant>();

  constructor(private readonly options: SessionOptions) {}

  /** Joins with `name`, connecting first if needed. Refuses a name that is empty after cleaning. */
  join(name: string): void {
    if (this.stopped) return;
    const clean = cleanName(name);
    if (clean === null) return this.update({ nameError: true });
    this.pendingName = clean;
    this.update({ status: "connecting", nameError: false });
    this.startTimer();
    if (this.socket) {
      if (this.welcomed) this.send({ type: "join", name: clean });
      return;
    }
    try {
      this.socket = this.options.createSocket(this.options.url, {
        onOpen: () => this.onOpen(),
        onMessage: (data) => this.onMessage(data),
        onClose: () => this.onClose(),
        onError: () => {
          // A close event always follows.
        },
      });
    } catch {
      this.finish("unreachable");
    }
  }

  /** Sends text to the room. False if not joined or the text is empty after cleaning. */
  say(text: string): boolean {
    if (this.stopped || this.view.status !== "joined") return false;
    const clean = cleanText(text);
    if (clean === null) return false;
    this.send({ type: "say", text: clean });
    return true;
  }

  /** Leaves: closes the socket and reports nothing further. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }

  private onOpen(): void {
    if (this.stopped) return;
    this.opened = true;
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
  }

  private onClose(): void {
    if (this.stopped) return;
    const { status } = this.view;
    if (status === "invalid" || status === "full" || status === "reload" || status === "unreachable") return;
    clearTimeout(this.timer);
    this.socket = null;
    if (status === "joined") return this.update({ status: "disconnected" });
    if (this.opened) return this.update({ status: "unreachable" });
    // Never opened: the relay refused the upgrade. Find out whether the code is the reason.
    void this.options.checkCode().then((check) => {
      if (!this.stopped) this.update({ status: check === "invalid" ? "invalid" : "unreachable" });
    });
  }

  private onMessage(data: unknown): void {
    if (this.stopped) return;
    const parsed = parseMessage(typeof data === "string" ? data : new ArrayBuffer(0), serverMessageSchema);
    if (!parsed.ok) return this.finish("reload");
    this.handle(parsed.value);
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        if (message.protocolVersion !== PROTOCOL_VERSION) return this.finish("reload");
        this.welcomed = true;
        if (this.pendingName !== null) this.send({ type: "join", name: this.pendingName });
        return;

      case "joined":
        clearTimeout(this.timer);
        for (const p of message.participants) this.known.set(p.id, p);
        this.known.set(message.you.id, message.you);
        return this.update({ status: "joined", you: message.you, participants: message.participants, nameError: false });

      case "participant_joined": {
        const p = message.participant;
        this.known.set(p.id, p);
        const others = this.view.participants.filter((q) => q.id !== p.id);
        return this.update({ participants: [...others, p], announcement: `${p.name} joined` });
      }

      case "participant_left": {
        const gone = this.view.participants.find((p) => p.id === message.id);
        if (!gone) return;
        return this.update({
          participants: this.view.participants.filter((p) => p.id !== message.id),
          announcement: `${gone.name} left`,
        });
      }

      case "echo": {
        const sender = this.known.get(message.from);
        if (!sender) return;
        const entry: EchoEntry = {
          key: this.nextKey++,
          from: sender.id,
          name: sender.name,
          colourIndex: sender.colourIndex,
          text: message.text,
        };
        const mine = sender.id === this.view.you?.id;
        return this.update({
          messages: [...this.view.messages, entry].slice(-MAX_MESSAGES),
          ...(mine ? { rateLimited: false } : {}),
        });
      }

      case "error":
        switch (message.code) {
          case "version_mismatch":
            return this.finish("reload");
          case "room_full":
            return this.finish("full");
          case "invalid_name":
            clearTimeout(this.timer);
            return this.update({ status: "idle", nameError: true });
          case "rate_limited":
            return this.update({ rateLimited: true });
          case "bad_message":
          case "too_large":
          case "not_joined":
          case "already_joined":
            return;
        }
    }
  }

  private startTimer(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.view.status === "connecting") this.finish("unreachable");
    }, JOIN_TIMEOUT_MS);
  }

  /** A final state: report it and close the socket. */
  private finish(status: RoomStatus): void {
    clearTimeout(this.timer);
    this.update({ status });
    this.socket?.close();
    this.socket = null;
  }

  private send(message: ClientMessage): void {
    try {
      this.socket?.send(encodeMessage(message));
    } catch {
      // The close handler reports the lost connection.
    }
  }

  private update(patch: Partial<RoomView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onChange(this.view);
  }
}
