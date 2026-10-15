// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { deliverFile, type ShareNavigator } from "../src/export/deliver";

/*
 * Export on phones (v0.40.0): a file goes to the share sheet (Web Share with files) where
 * `navigator.canShare` says this file can be shared, else it downloads through a temporary link.
 * Cancelling the share sheet downloads nothing. A share the browser refuses because the tap is
 * too long ago (a PNG takes a moment to draw) asks for one more tap instead of failing.
 */

const blob = () => new Blob(["{}"], { type: "application/json" });
const named = (name: string) => Object.assign(new Error(name), { name });

function nav({ can = true, share = async () => {} }: { can?: boolean | (() => boolean); share?: () => Promise<void> } = {}) {
  const canShare = vi.fn((_data: ShareData) => (typeof can === "function" ? can() : can));
  const shareFn = vi.fn((_data: ShareData) => share());
  return { canShare, share: shareFn } satisfies ShareNavigator;
}

describe("delivering an exported file", () => {
  it("shares the file where canShare allows it (phones), with nothing else in the share", async () => {
    const n = nav();
    const download = vi.fn();
    expect(await deliverFile(blob(), "stickyard-board-2026-10-15.json", { share: true }, n, download)).toBe("shared");
    expect(download).not.toHaveBeenCalled();
    const data = n.share.mock.calls[0]![0];
    expect(Object.keys(data)).toEqual(["files"]);
    expect(data.files![0]!.name).toBe("stickyard-board-2026-10-15.json");
    expect(data.files![0]!.type).toBe("application/json");
  });

  it("downloads when canShare says no (for example a .json or .md file on Android Chrome)", async () => {
    const n = nav({ can: false });
    const download = vi.fn();
    expect(await deliverFile(blob(), "a.json", { share: true }, n, download)).toBe("downloaded");
    expect(n.share).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "a.json");
  });

  it("downloads when there is no Web Share, or canShare throws", async () => {
    const download = vi.fn();
    expect(await deliverFile(blob(), "a.json", { share: true }, {}, download)).toBe("downloaded");
    expect(await deliverFile(blob(), "a.json", { share: true }, undefined, download)).toBe("downloaded");
    const throwing = nav({
      can: () => {
        throw new Error("no");
      },
    });
    expect(await deliverFile(blob(), "a.json", { share: true }, throwing, download)).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(3);
  });

  it("never shares when sharing isn't asked for (the laptop's Properties)", async () => {
    const n = nav();
    const download = vi.fn();
    expect(await deliverFile(blob(), "a.png", { share: false }, n, download)).toBe("downloaded");
    expect(n.canShare).not.toHaveBeenCalled();
  });

  it("a cancelled share sheet is cancelled: nothing downloads", async () => {
    const n = nav({ share: () => Promise.reject(named("AbortError")) });
    const download = vi.fn();
    expect(await deliverFile(blob(), "a.png", { share: true }, n, download)).toBe("cancelled");
    expect(download).not.toHaveBeenCalled();
  });

  it("a share refused for want of a fresh tap asks for one", async () => {
    const n = nav({ share: () => Promise.reject(named("NotAllowedError")) });
    const download = vi.fn();
    expect(await deliverFile(blob(), "a.png", { share: true }, n, download)).toBe("needsTap");
    expect(download).not.toHaveBeenCalled();
  });

  it("any other share failure falls back to a download", async () => {
    const n = nav({ share: () => Promise.reject(named("DataError")) });
    const download = vi.fn();
    expect(await deliverFile(blob(), "a.png", { share: true }, n, download)).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(1);
  });
});
