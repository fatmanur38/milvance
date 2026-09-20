import type { OrderWithMilestones } from '../api/schemas';
import { orderRolesFor, type OrderRole } from './roles';
import { milestoneTitle } from './status';

/**
 * "What needs me?" across every order a wallet is part of.
 *
 * A summary only, computed from order and milestone state without per-
 * milestone finance detail. The order page shows the exact actions; this
 * points people to the right order.
 */
export interface AttentionItem {
  readonly orderId: string;
  readonly milestoneId?: string;
  readonly role: OrderRole;
  readonly title: string;
}

export function attentionItems(
  wallet: string | undefined,
  orders: readonly OrderWithMilestones[],
): AttentionItem[] {
  if (wallet === undefined) return [];
  const items: AttentionItem[] = [];

  for (const order of orders) {
    const roles = orderRolesFor(wallet, order);

    if (order.status === 'CREATED') {
      if (roles.includes('buyer') && order.milestones.length === 0) {
        items.push({ orderId: order.orderId, role: 'buyer', title: 'Add the first milestone' });
      }
      if (roles.includes('supplier') && order.milestones.length > 0) {
        items.push({
          orderId: order.orderId,
          role: 'supplier',
          title: 'Review and accept the order',
        });
      }
      continue;
    }
    if (order.status !== 'ACTIVE') continue;

    for (const milestone of order.milestones) {
      const name = milestoneTitle(milestone.index);
      const at = (role: OrderRole, title: string) =>
        items.push({ orderId: order.orderId, milestoneId: milestone.milestoneId, role, title });

      if (roles.includes('buyer') && milestone.status === 'UNFUNDED') {
        at('buyer', `Protect the ${name} payment`);
      }
      if (roles.includes('supplier')) {
        if (milestone.status === 'FUNDED')
          at('supplier', `${name} is protected — request working capital or submit evidence`);
        if (milestone.status === 'FINANCE_REQUESTED')
          at('supplier', `Compare funding offers on ${name}`);
        if (milestone.status === 'FINANCED')
          at('supplier', `Advance received on ${name} — convert to TRY or submit evidence`);
        if (milestone.status === 'VERIFIED') at('supplier', `Release the ${name} payment`);
      }
      if (roles.includes('attestor') && milestone.status === 'SUBMITTED') {
        at('attestor', `Review evidence and verify ${name}`);
      }
      if (roles.includes('resolver') && milestone.status === 'DISPUTED') {
        at('resolver', `Resolve the dispute on ${name}`);
      }
    }
  }
  return items;
}
