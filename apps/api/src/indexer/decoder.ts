import { scValToNative, xdr } from '@stellar/stellar-sdk';

import { assertU64, toJsonSafe } from '../common/amounts';

/**
 * Decoder for MilvanceCore contract events.
 *
 * The wire shape is not guessed — it was read off the live Testnet contract:
 *
 *   topic[0]  = symbol, the event name in lower snake case (`order_created`)
 *   topic[1..]= the fields marked `#[topic]`, in declaration order
 *   value     = an ScMap of the remaining fields, keyed by field name
 *
 * So `order_id` arrives as a TOPIC and is absent from the value map. Decoding
 * therefore has to merge the two halves; reading only the value would silently
 * drop every entity identifier in the contract.
 *
 * Integers come back from `scValToNative` as `bigint` and stay that way.
 */

/** Event names the deployed contract can emit, derived from `events.rs`. */
export const MILVANCE_EVENT_NAMES = [
  'order_created',
  'order_accepted',
  'order_cancelled',
  'milestone_created',
  'milestone_funded',
  'partial_funding_cancelled',
  'finance_requested',
  'finance_request_cancelled',
  'funding_offer_created',
  'funding_offer_cancelled',
  'offer_accepted',
  'advance_funded',
  'acceptance_released',
  'evidence_submitted',
  'milestone_verified',
  'milestone_settled',
  'milestone_refunded',
  'dispute_opened',
  'dispute_resolved',
  'order_completed',
] as const;

export type MilvanceEventName = (typeof MILVANCE_EVENT_NAMES)[number];

const KNOWN_EVENTS = new Set<string>(MILVANCE_EVENT_NAMES);

export function isMilvanceEventName(name: string): name is MilvanceEventName {
  return KNOWN_EVENTS.has(name);
}

/**
 * The `#[topic]` fields of each event, in declaration order, so topics can be
 * given their proper names. Mirrors `contracts/milvance-core/src/events.rs`.
 */
const TOPIC_FIELDS: Record<MilvanceEventName, readonly string[]> = {
  order_created: ['order_id'],
  order_accepted: ['order_id'],
  order_cancelled: ['order_id'],
  milestone_created: ['order_id', 'milestone_id'],
  milestone_funded: ['order_id', 'milestone_id'],
  partial_funding_cancelled: ['order_id', 'milestone_id'],
  finance_requested: ['milestone_id'],
  finance_request_cancelled: ['milestone_id'],
  funding_offer_created: ['milestone_id', 'offer_id'],
  funding_offer_cancelled: ['milestone_id', 'offer_id'],
  offer_accepted: ['milestone_id', 'offer_id'],
  advance_funded: ['milestone_id', 'offer_id'],
  acceptance_released: ['milestone_id', 'offer_id'],
  evidence_submitted: ['milestone_id'],
  milestone_verified: ['milestone_id'],
  milestone_settled: ['order_id', 'milestone_id'],
  milestone_refunded: ['order_id', 'milestone_id'],
  dispute_opened: ['milestone_id', 'dispute_id'],
  dispute_resolved: ['milestone_id', 'dispute_id'],
  order_completed: ['order_id'],
};

export class EventDecodeError extends Error {
  constructor(
    message: string,
    /** The underlying XDR/conversion failure, kept for diagnosis. */
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'EventDecodeError';
  }
}

/** A raw event as Soroban RPC `getEvents` returns it. */
export interface RawContractEvent {
  readonly id: string;
  readonly type: string;
  readonly ledger: number;
  readonly ledgerClosedAt: string;
  readonly contractId: string;
  readonly txHash: string;
  readonly topic: readonly string[];
  readonly value: string;
  readonly inSuccessfulContractCall: boolean;
  readonly operationIndex?: number;
  readonly transactionIndex?: number;
}

export interface DecodedEvent {
  /** Globally unique, lexicographically ordered RPC event id (`<toid>-<index>`). */
  readonly eventId: string;
  readonly eventIndex: number;
  readonly ledger: bigint;
  readonly ledgerClosedAt: Date;
  readonly txHash: string;
  readonly txIndex: number;
  readonly operationIndex: number;
  readonly contractId: string;
  readonly successful: boolean;
  readonly eventName: string;
  /** True when `eventName` is one this contract version defines. */
  readonly known: boolean;
  /** Topics merged with the value map, BigInts preserved. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly topicsXdr: readonly string[];
  readonly valueXdr: string;
}

/**
 * Split the RPC event id into its ordering parts.
 *
 * Format is `<19-digit zero-padded TOID>-<10-digit zero-padded event index>`,
 * which is why the whole id sorts correctly as a plain string.
 */
export function parseEventId(eventId: string): { toid: bigint; eventIndex: number } {
  const match = /^(\d+)-(\d+)$/.exec(eventId);
  if (match === null) {
    throw new EventDecodeError(`Unrecognised event id: ${JSON.stringify(eventId)}`);
  }
  const [, toidPart, indexPart] = match as unknown as [string, string, string];
  return { toid: BigInt(toidPart), eventIndex: Number(indexPart) };
}

function decodeScVal(base64: string, what: string): unknown {
  let parsed: xdr.ScVal;
  try {
    parsed = xdr.ScVal.fromXDR(base64, 'base64');
  } catch (cause) {
    throw new EventDecodeError(`Malformed ${what} XDR`, cause);
  }
  try {
    return scValToNative(parsed);
  } catch (cause) {
    throw new EventDecodeError(`Could not convert ${what} to a native value`, cause);
  }
}

/**
 * Decode one raw RPC event.
 *
 * Throws `EventDecodeError` on malformed input rather than returning a partly
 * decoded event: a half-decoded financial event is worse than a loud failure,
 * because the indexer would persist it and advance its cursor past it.
 *
 * An event whose name this build does not know is returned with `known: false`
 * and its raw fields intact. That is not an error — a newer contract may emit
 * an event an older indexer has never heard of, and the honest response is to
 * store it unprojected rather than crash or invent a projection.
 */
export function decodeEvent(raw: RawContractEvent): DecodedEvent {
  if (!Array.isArray(raw.topic) || raw.topic.length === 0) {
    throw new EventDecodeError('Contract event has no topics');
  }

  const [nameTopic, ...idTopics] = raw.topic as [string, ...string[]];
  const eventName = decodeScVal(nameTopic, 'event name topic');
  if (typeof eventName !== 'string') {
    throw new EventDecodeError(`Event name topic is not a symbol: ${typeof eventName}`);
  }

  const known = isMilvanceEventName(eventName);
  const fields: Record<string, unknown> = {};

  if (known) {
    const names = TOPIC_FIELDS[eventName];
    if (idTopics.length !== names.length) {
      throw new EventDecodeError(
        `${eventName} expects ${names.length} id topic(s) but carried ${idTopics.length}`,
      );
    }
    names.forEach((fieldName, position) => {
      const topic = idTopics[position];
      /* c8 ignore next 3 -- length was checked above; this keeps the types honest */
      if (topic === undefined) {
        throw new EventDecodeError(`${eventName} is missing topic ${fieldName}`);
      }
      const value = decodeScVal(topic, `${eventName} topic ${fieldName}`);
      if (typeof value !== 'bigint') {
        throw new EventDecodeError(`${eventName} topic ${fieldName} is not a u64`);
      }
      fields[fieldName] = assertU64(value, `${eventName}.${fieldName}`);
    });
  } else {
    idTopics.forEach((topic, position) => {
      fields[`topic_${position + 1}`] = decodeScVal(topic, `topic ${position + 1}`);
    });
  }

  const body = decodeScVal(raw.value, `${eventName} body`);
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (key in fields) {
        throw new EventDecodeError(
          `${eventName} body redefines topic field ${key}; refusing to guess which wins`,
        );
      }
      fields[key] = value;
    }
  } else if (body !== undefined && body !== null) {
    fields.value = body;
  }

  const { eventIndex } = parseEventId(raw.id);
  const closedAt = new Date(raw.ledgerClosedAt);
  if (Number.isNaN(closedAt.getTime())) {
    throw new EventDecodeError(`Unparseable ledgerClosedAt: ${raw.ledgerClosedAt}`);
  }

  return {
    eventId: raw.id,
    eventIndex,
    ledger: BigInt(raw.ledger),
    ledgerClosedAt: closedAt,
    txHash: raw.txHash,
    txIndex: raw.transactionIndex ?? 0,
    operationIndex: raw.operationIndex ?? 0,
    contractId: raw.contractId,
    successful: raw.inSuccessfulContractCall,
    eventName,
    known,
    fields,
    topicsXdr: [...raw.topic],
    valueXdr: raw.value,
  };
}

/**
 * Deterministic chain order: ledger, then position within the ledger, then
 * position within the transaction, then event index.
 *
 * The RPC returns events in this order already; sorting explicitly means a
 * projection never depends on that promise holding.
 */
export function compareEventOrder(a: DecodedEvent, b: DecodedEvent): number {
  if (a.ledger !== b.ledger) {
    return a.ledger < b.ledger ? -1 : 1;
  }
  if (a.txIndex !== b.txIndex) {
    return a.txIndex - b.txIndex;
  }
  if (a.operationIndex !== b.operationIndex) {
    return a.operationIndex - b.operationIndex;
  }
  if (a.eventIndex !== b.eventIndex) {
    return a.eventIndex - b.eventIndex;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** Render decoded fields for storage as JSON: BigInt to string, bytes to hex. */
export function fieldsToJson(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return toJsonSafe(fields) as Record<string, unknown>;
}
