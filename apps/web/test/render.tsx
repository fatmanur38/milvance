import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { queryKeys } from '@/lib/api/queries';
import type {
  MilestoneEvidence,
  MilestoneFinance,
  OrderWithMilestones,
  PublicMetrics,
} from '@/lib/api/schemas';

/**
 * Render with a query cache pre-seeded in the API's own shapes. Seeded queries
 * never refetch, so a test states exactly what the read model returned.
 */
export function renderWithData(
  ui: ReactElement,
  seed: {
    order?: OrderWithMilestones;
    finance?: Record<string, MilestoneFinance>;
    evidence?: Record<string, MilestoneEvidence>;
    orders?: { participant: string; orders: OrderWithMilestones[] };
    metrics?: PublicMetrics;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  if (seed.order) client.setQueryData(queryKeys.order(seed.order.orderId), seed.order);
  for (const [id, value] of Object.entries(seed.finance ?? {})) {
    client.setQueryData(queryKeys.milestoneFinance(id), value);
  }
  for (const [id, value] of Object.entries(seed.evidence ?? {})) {
    client.setQueryData(queryKeys.milestoneEvidence(id), value);
  }
  if (seed.orders) {
    client.setQueryData(queryKeys.orders(seed.orders.participant), {
      orders: seed.orders.orders,
      count: seed.orders.orders.length,
    });
  }
  if (seed.metrics) client.setQueryData(queryKeys.publicMetrics, seed.metrics);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
