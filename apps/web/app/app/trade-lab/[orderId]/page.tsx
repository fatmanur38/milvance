import { notFound } from 'next/navigation';

import { RunView } from '@/components/demo/run-view';

/** Next.js 16: route params arrive as a Promise and must be awaited. */
export default async function TradeLabRunPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  // Chain order ids are positive integers; anything else is not a trade.
  if (!/^[1-9]\d{0,19}$/.test(orderId)) notFound();
  return <RunView orderId={orderId} />;
}
