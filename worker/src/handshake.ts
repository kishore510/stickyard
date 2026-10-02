import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  parseMessage,
  type ErrorCode,
  type ServerMessage,
} from "@stickyard/shared";

function error(code: ErrorCode, message: string): ServerMessage {
  return { type: "error", code, message };
}

/** Turn one raw inbound frame into the reply. Pure and never throws. */
export function handleClientFrame(raw: string | ArrayBuffer): ServerMessage {
  const parsed = parseMessage(raw, clientMessageSchema);
  if (!parsed.ok) {
    return parsed.error === "too_large"
      ? error("too_large", "Message is too large.")
      : error("bad_message", "Message could not be understood.");
  }

  const message = parsed.value;
  switch (message.type) {
    case "hello":
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        return error("version_mismatch", `Server speaks protocol v${PROTOCOL_VERSION}. Please reload.`);
      }
      return { type: "welcome", protocolVersion: PROTOCOL_VERSION };
  }
}
