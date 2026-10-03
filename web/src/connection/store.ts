import { create } from "zustand";
import { WORKER_URL, toWebSocketUrl } from "../config";
import { browserSocketFactory, startConnectionCheck, type CheckStatus } from "./connectionCheck";

interface ConnectionCheckState {
  status: CheckStatus;
  /** Start (or restart) the check. Returns a stop function. */
  start(): () => void;
}

export const useConnectionCheck = create<ConnectionCheckState>()((set) => ({
  status: "connecting",
  start: () =>
    startConnectionCheck({
      url: toWebSocketUrl(WORKER_URL),
      createSocket: browserSocketFactory,
      onStatus: (status) => set({ status }),
    }),
}));
