import { downloadBlob } from "./png";

/*
 * Export on phones (v0.40.0): how a made file reaches the person. Where sharing is asked for (the
 * Export sheet on a phone) and `navigator.canShare` says this file can be shared, it goes to the
 * system share sheet (Web Share with files: Save to Files, Photos, a chat...). Otherwise, or if
 * sharing fails, it downloads through a temporary link (png.ts downloadBlob). Only the file is
 * shared: no title, text or URL. Nothing is uploaded by this page either way.
 */

export type Delivery =
  /** The share sheet took it. */
  | "shared"
  /** Downloaded through a temporary link. */
  | "downloaded"
  /** The person closed the share sheet: nothing else happens. */
  | "cancelled"
  /** The browser wants a fresh tap before sharing (drawing a PNG can outlast the first one). */
  | "needsTap";

/** The part of `navigator` used here (absent members: no Web Share). */
export interface ShareNavigator {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
}

const errorName = (e: unknown) => (typeof e === "object" && e !== null && "name" in e ? String(e.name) : "");

/** Shares `blob` as a file named `name` where it can (and `share` asks for it), else downloads it. Never throws for a share failure. */
export async function deliverFile(
  blob: Blob,
  name: string,
  { share }: { share: boolean },
  nav: ShareNavigator | undefined = typeof navigator === "undefined" ? undefined : navigator,
  download: (blob: Blob, name: string) => void = downloadBlob,
): Promise<Delivery> {
  if (share && nav?.share && nav.canShare && typeof File === "function") {
    const data: ShareData = { files: [new File([blob], name, { type: blob.type })] };
    let can = false;
    try {
      can = nav.canShare(data);
    } catch {
      can = false;
    }
    if (can) {
      try {
        await nav.share(data);
        return "shared";
      } catch (e) {
        const reason = errorName(e);
        if (reason === "AbortError") return "cancelled";
        if (reason === "NotAllowedError") return "needsTap";
        // Anything else (a type the share target refused, a busy share sheet...): download instead.
      }
    }
  }
  download(blob, name);
  return "downloaded";
}
