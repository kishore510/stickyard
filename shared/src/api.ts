import { z } from "zod";

/* Slice 1 stub: tests first. Implemented in the next commit. */
export const MAX_PASSCODE_LENGTH = 256;
export const MAX_CREATE_BODY_BYTES = 1024;
export const createRoomRequestSchema = z.never();
export const createRoomResponseSchema = z.never();
export const apiErrorSchema = z.never();
export const healthResponseSchema = z.never();
export const roomCheckResponseSchema = z.never();
export function isRoomCodeShape(_code: string): boolean {
  throw new Error("not implemented");
}
