import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SessionInfo } from '@encore/shared';

interface SessionState {
  session: SessionInfo | null;
  /** absolute API origin — empty string = same origin (web); set explicitly in the Capacitor app */
  serverUrl: string;
  setSession: (s: SessionInfo | null) => void;
  setServerUrl: (url: string) => void;
  logout: () => void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      session: null,
      serverUrl: '',
      setSession: (session) => set({ session }),
      setServerUrl: (serverUrl) => set({ serverUrl: serverUrl.replace(/\/+$/, '') }),
      logout: () => set({ session: null }),
    }),
    { name: 'encore-session' },
  ),
);

export const isNativeApp = (): boolean =>
  typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.();
