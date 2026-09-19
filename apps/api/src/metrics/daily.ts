import type { DecodedEvent } from '../indexer/decoder';

/** Counts only successful, projected contract events. No browser report can
 * increment these figures, and a duplicate event never reaches this function. */
export function dailyMetric(event: DecodedEvent) {
  return {
    ordersCreated: event.eventName === 'order_created' ? 1 : 0,
    milestonesFunded:
      event.eventName === 'milestone_funded' && event.fields.fully_funded === true ? 1 : 0,
    advancesFunded: event.eventName === 'advance_funded' ? 1 : 0,
    milestonesSettled: event.eventName === 'milestone_settled' ? 1 : 0,
    milestonesRefunded: event.eventName === 'milestone_refunded' ? 1 : 0,
    disputesOpened: event.eventName === 'dispute_opened' ? 1 : 0,
  };
}
