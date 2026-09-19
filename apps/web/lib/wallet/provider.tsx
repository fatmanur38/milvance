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
    const onFocus = () => void controller.refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [controller]);
  return <WalletContext.Provider value={{ controller, state }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error('WalletProvider is required.');
  return context;
}
