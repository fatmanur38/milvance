'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  attachRun,
  clearRuns,
  forgetRun,
  readRuns,
  type DemoRun,
  type RunStore,
} from '@/lib/demo/session';

/**
 * The Trade Lab's own notes, kept in this browser.
 *
 * Only which template a trade followed — wording the chain does not store.
 * Every amount and status in the lab is read from the API, so this hook never
 * decides anything financial and losing it costs nothing but stage names.
 */
export function useDemoRuns(): {
  runs: DemoRun[];
  attach: (orderId: string, templateId: string) => void;
  forget: (orderId: string) => void;
  clear: () => void;
} {
  const [runs, setRuns] = useState<DemoRun[]>([]);

  // Read after mount: server rendering has no browser storage, and reading it
  // during render would make the first paint differ from the server's.
  useEffect(() => {
    setRuns(readRuns(store()));
  }, []);

  const attach = useCallback((orderId: string, templateId: string) => {
    setRuns(attachRun(store(), { orderId, templateId }));
  }, []);
  const forget = useCallback((orderId: string) => {
    setRuns(forgetRun(store(), orderId));
  }, []);
  const clear = useCallback(() => {
    setRuns(clearRuns(store()));
  }, []);

  return { runs, attach, forget, clear };
}

function store(): RunStore | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    // Storage can be blocked outright. The lab works without it.
    return undefined;
  }
}
