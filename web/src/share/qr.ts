import { correction, generate } from "lean-qr";

/*
 * QR codes for the join link (v0.32.0), made on this device by lean-qr: nothing is sent anywhere.
 * Error correction level M, at most version QR_MAX_VERSION (57 modules a side) so each module stays
 * big enough to scan from across a room; a real join link needs about version 6.
 */

export const QR_MAX_VERSION = 10;
/** Light modules round the code, as the standard asks (drawn by QrCode as part of its panel). */
export const QR_QUIET_ZONE = 4;
/** Longer than any version-10 code can hold: not even tried. */
const MAX_TEXT = 512;

export interface QrMatrix {
  /** Modules a side, without the quiet zone. */
  size: number;
  dark: (x: number, y: number) => boolean;
}

/** The QR code for `text`, or null when there's nothing to encode or it doesn't fit. Never throws. */
export function encodeQr(text: string): QrMatrix | null {
  if (text.length === 0 || text.length > MAX_TEXT) return null;
  try {
    const code = generate(text, { minCorrectionLevel: correction.M, maxCorrectionLevel: correction.M, maxVersion: QR_MAX_VERSION });
    return { size: code.size, dark: (x, y) => code.get(x, y) };
  } catch {
    return null;
  }
}

/** One SVG path for the dark modules: a unit square each, only commands and numbers. */
export function qrPath(m: QrMatrix): string {
  let d = "";
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) if (m.dark(x, y)) d += `M${x} ${y}h1v1h-1z`;
  }
  return d;
}
