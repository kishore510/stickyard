import { create } from "zustand";
import { WORKER_URL, healthUrl } from "../config";
import { startConnectionCheck, type CheckStatus } from "./connectionCheck";

interface ConnectionCheckState {
  status: CheckStatus;
  /** Start (or restart) the check. Returns a stop function. */
  start(): () => void;
}

export const useConnectionCheck = create<ConnectionCheckState>()((set) => ({
  status: "connecting",
  start: () =>
    startConnectionCheck({
      url: healthUrl(WORKER_URL),
      fetch: (input, init) => fetch(input, init),
      onStatus: (status) => set({ status }),
    }),
}));
