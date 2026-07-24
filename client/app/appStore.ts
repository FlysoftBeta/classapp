import { create } from "zustand";
import {
  appReducer,
  initialAppStore,
  type AppAction,
  type AppStore,
} from "@/client/app/appReducer";

type AppStoreState = AppStore & {
  dispatch: (action: AppAction) => void;
  reset: () => void;
};

export const useAppStore = create<AppStoreState>((set) => ({
  ...initialAppStore,
  dispatch: (action) =>
    set((state) => {
      const { dispatch, reset, ...appState } = state;
      return {
        ...appReducer(appState, action),
        dispatch,
        reset,
      };
    }),
  reset: () =>
    set((state) => ({
      ...initialAppStore,
      dispatch: state.dispatch,
      reset: state.reset,
    })),
}));
