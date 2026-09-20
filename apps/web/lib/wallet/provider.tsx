'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { WalletController, BrowserSessionStore, type WalletState } from './controller';
import { FreighterWallet } from './freighter';
import { HorizonTrustline } from './trustline';
import { MilvanceContract } from './contract';

interface WalletContextValue {
  controller: WalletController;
  state: WalletState;
}

const WalletContext = createContext<WalletContextValue | null>(null);
/** How often to ask Freighter which account is active. Cheap: extension-local. */
const ACCOUNT_POLL_MS = 3000;
const serverState: WalletState = { phase: 'disconnected' };
const serverSnapshot = () => serverState;

export function WalletProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [controller] = useState(() => {
    const wallet = new FreighterWallet();
    return new WalletController(
      wallet,
      new HorizonTrustline(),
      new MilvanceContract(wallet),
      new BrowserSessionStore(),
    );
  });
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, serverSnapshot);
  useEffect(() => {
    void controller.restore();
    // Freighter cannot notify the page when the user switches account or
    // network, so we ask it — while the tab is visible, and again whenever it
    // comes back. Without this, switching roles in Freighter leaves the
    // workspace showing the previous party until a manual reconnect.
    const sync = (): void => {
      if (document.visibilityState === 'visible') void controller.sync();
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    const timer = window.setInterval(sync, ACCOUNT_POLL_MS);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      window.clearInterval(timer);
    };
  }, [controller]);
  return <WalletContext.Provider value={{ controller, state }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error('WalletProvider is required.');
  return context;
}
