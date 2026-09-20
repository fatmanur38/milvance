'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiError } from '@/lib/api/client';

/** One query client per browser tab. Chain-derived data is short-lived by design. */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            // A 4xx is an answer, not a blip: do not hammer the API retrying it.
            retry: (failures, error) =>
              !(
                error instanceof ApiError &&
                (error.kind === 'not-found' || error.kind === 'rejected')
              ) && failures < 2,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
