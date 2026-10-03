import type { Participant } from "@stickyard/shared";
import type { SocketFactory } from "../connection/socket";
import type { CodeCheck } from "./api";

/* Slice 1 stub: tests first. Implemented in the next commit. */
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
  nameError: boolean;
  rateLimited: boolean;
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
export const MAX_MESSAGES = 100;

export interface SessionOptions {
  url: string;
  createSocket: SocketFactory;
  checkCode(): Promise<CodeCheck>;
  onChange(view: RoomView): void;
}

export class RoomSession {
  constructor(_options: SessionOptions) {}
  join(_name: string): void {
    throw new Error("not implemented");
  }
  say(_text: string): boolean {
    throw new Error("not implemented");
  }
  close(): void {
    throw new Error("not implemented");
  }
}
