import { notFound } from 'next/navigation';

import { OrderDetail } from '@/components/orders/order-detail';

/** Next.js 16: route params arrive as a Promise and must be awaited. */
export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  // Chain order ids are positive integers; anything else is not an order.
  if (!/^[1-9]\d{0,19}$/.test(orderId)) notFound();
  return <OrderDetail orderId={orderId} />;
}
