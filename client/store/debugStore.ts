import { create } from "zustand";

interface DebugState {
  showInfiniIds: boolean;
  showInfiniLogs: boolean;
  setShowInfiniIds: (show: boolean) => void;
  setShowInfiniLogs: (show: boolean) => void;
}

export const useDebugStore = create<DebugState>((set) => ({
  showInfiniIds: false,
  showInfiniLogs: false,
  setShowInfiniIds: (showInfiniIds) => set({ showInfiniIds }),
  setShowInfiniLogs: (showInfiniLogs) => set({ showInfiniLogs }),
}));
