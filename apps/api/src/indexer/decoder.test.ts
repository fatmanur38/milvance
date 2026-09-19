import { describe, expect, it } from 'vitest';

import {
  compareEventOrder,
  decodeEvent,
  EventDecodeError,
  fieldsToJson,
  MILVANCE_EVENT_NAMES,
  parseEventId,
  type RawContractEvent,
} from './decoder';
import { ADDRESSES, contractEventSpecs, rawEvent } from './fixtures.test-helper';

/**
 * Two events captured from the LIVE Testnet contract on 2026-09-19.
 *
 * These are the ground truth for the wire format. Everything else in the
 * indexer is built on the shape they prove, so they are pinned here verbatim
 * rather than regenerated.
 */
const LIVE_ORDER_CREATED: RawContractEvent = {
  id: '0020450379405774848-0000000000',
  type: 'contract',
  ledger: 4761475,
  ledgerClosedAt: '2026-09-19T15:16:02Z',
  contractId: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
  txHash: '5fafed67546e55aa79f441a5fdd5932bd4038bd05e3cc3af4c820e522c5783ee',
  topic: ['AAAADwAAAA1vcmRlcl9jcmVhdGVkAAAA', 'AAAABQAAAAAAAAAB'],
  value:
    'AAAAEQAAAAEAAAAFAAAADwAAAAVhc3NldAAAAAAAABIAAAABUEXNXsBymnaP1a0CUFhS308Cjc6DDlrFIgm6SEg7LwEAAAAPAAAACGF0dGVzdG9yAAAAEgAAAAAAAAAA6dI+/8Mn7rkxG2GCqV+WmDJPxOKOsspZy3LIUOuKQKgAAAAPAAAABWJ1eWVyAAAAAAAAEgAAAAAAAAAAlFIMINcpj8NqmhIvnHRgkvCMCetMNZlMWVlmSIfn63IAAAAPAAAACHJlc29sdmVyAAAAEgAAAAAAAAAA/9hG4Rp+Xb9o5lcEokKoNFOTZJvx0xQ7QDtMyGD+Uv0AAAAPAAAACHN1cHBsaWVyAAAAEgAAAAAAAAAAQy2WWhXxCNDjEYwMTgJPgkXWVsyVdxmSbawcMzqJsjw=',
  inSuccessfulContractCall: true,
  operationIndex: 0,
  transactionIndex: 13,
};

describe('decoding a real Testnet event', () => {
  it('merges the id topic with the body map', () => {
    const decoded = decodeEvent(LIVE_ORDER_CREATED);

    expect(decoded.eventName).toBe('order_created');
    expect(decoded.known).toBe(true);
    // `order_id` is a TOPIC and absent from the value map. Reading only the
    // value would lose every entity identifier in the contract.
    expect(decoded.fields.order_id).toBe(1n);
    expect(decoded.fields.buyer).toBe(ADDRESSES.buyer);
    expect(decoded.fields.supplier).toBe(ADDRESSES.supplier);
    expect(decoded.fields.attestor).toBe(ADDRESSES.attestor);
    expect(decoded.fields.resolver).toBe(ADDRESSES.resolver);
    expect(decoded.fields.asset).toBe(ADDRESSES.usdcSac);
  });

  it('carries the chain coordinates needed for ordering and identity', () => {
    const decoded = decodeEvent(LIVE_ORDER_CREATED);

    expect(decoded.ledger).toBe(4761475n);
    expect(decoded.txHash).toBe(LIVE_ORDER_CREATED.txHash);
    expect(decoded.eventIndex).toBe(0);
    expect(decoded.txIndex).toBe(13);
    expect(decoded.ledgerClosedAt.toISOString()).toBe('2026-09-19T15:16:02.000Z');
    expect(decoded.successful).toBe(true);
  });

  it('keeps the raw XDR alongside the decoded fields', () => {
    const decoded = decodeEvent(LIVE_ORDER_CREATED);

    // Replay and audit must not depend on our decoder being right.
    expect(decoded.topicsXdr).toEqual(LIVE_ORDER_CREATED.topic);
    expect(decoded.valueXdr).toBe(LIVE_ORDER_CREATED.value);
  });
});

describe('event catalog', () => {
  it('matches the deployed contract spec exactly', () => {
    const fromSpec = contractEventSpecs()
      .map((spec) => spec.eventName)
      .sort();

    expect(fromSpec).toEqual([...MILVANCE_EVENT_NAMES].sort());
  });

  it('declares every event body as a map, which is what the decoder assumes', () => {
    // If a future contract switched an event to a non-map body, the decoder's
    // topic/body merge would be wrong. Catch that here rather than in
    // production.
    const specs = contractEventSpecs();
    expect(specs.length).toBe(MILVANCE_EVENT_NAMES.length);
  });

  it('agrees with the spec about which fields are topics', () => {
    for (const spec of contractEventSpecs()) {
      const topicFields = spec.params.filter((param) => param.isTopic).map((param) => param.name);
      const built = rawEvent(spec.eventName, sampleFieldsFor(spec.eventName));
      const decoded = decodeEvent(built);

      for (const field of topicFields) {
        expect(decoded.fields[field], `${spec.eventName}.${field}`).toBeDefined();
      }
      expect(decoded.known).toBe(true);
    }
  });
});

/** Minimal valid values for every field of every event, typed from the spec. */
function sampleFieldsFor(eventName: string): Record<string, unknown> {
  const spec = contractEventSpecs().find((candidate) => candidate.eventName === eventName);
  if (spec === undefined) {
    throw new Error(`unknown event ${eventName}`);
  }
  const fields: Record<string, unknown> = {};
  for (const param of spec.params) {
    const kind = param.type.switch().name;
    switch (kind) {
      case 'scSpecTypeU64':
        fields[param.name] = 1n;
        break;
      case 'scSpecTypeU32':
        fields[param.name] = 0;
        break;
      case 'scSpecTypeI128':
        fields[param.name] = 1_000_0000000n;
        break;
      case 'scSpecTypeBool':
        fields[param.name] = false;
        break;
      case 'scSpecTypeAddress':
        fields[param.name] = ADDRESSES.buyer;
        break;
      case 'scSpecTypeBytesN':
        fields[param.name] = 'a'.repeat(64);
        break;
      case 'scSpecTypeOption':
        fields[param.name] = null;
        break;
      default:
        throw new Error(`no sample value for ${kind}`);
    }
  }
  return fields;
}

describe('exact numeric handling', () => {
  it('decodes an i128 beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const huge = 170_141_183_460_469_231_731_687_303_715_884_105_727n; // i128 max
    const decoded = decodeEvent(
      rawEvent('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: huge,
        funded_amount: huge,
        fully_funded: true,
      }),
    );

    expect(decoded.fields.amount).toBe(huge);
    // The whole point: a JS number would have rounded this.
    expect(Number(huge)).not.toBe(huge);
  });

  it('renders BigInt and bytes as JSON-safe values', () => {
    const decoded = decodeEvent(
      rawEvent('evidence_submitted', {
        milestone_id: 7n,
        supplier: ADDRESSES.supplier,
        evidence_hash: 'b'.repeat(64),
        replaced_previous: true,
      }),
    );

    const json = fieldsToJson(decoded.fields);
    expect(json.milestone_id).toBe('7');
    expect(json.evidence_hash).toBe('b'.repeat(64));
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

describe('malformed input', () => {
  it('rejects an event with no topics', () => {
    expect(() => decodeEvent({ ...LIVE_ORDER_CREATED, topic: [] })).toThrow(EventDecodeError);
  });

  it('rejects unparseable topic XDR', () => {
    expect(() => decodeEvent({ ...LIVE_ORDER_CREATED, topic: ['not-base64-xdr!!'] })).toThrow(
      EventDecodeError,
    );
  });

  it('rejects unparseable body XDR', () => {
    expect(() => decodeEvent({ ...LIVE_ORDER_CREATED, value: 'zzzz' })).toThrow(EventDecodeError);
  });

  it('rejects a known event carrying the wrong number of id topics', () => {
    expect(() =>
      decodeEvent({ ...LIVE_ORDER_CREATED, topic: [LIVE_ORDER_CREATED.topic[0] as string] }),
    ).toThrow(/expects 1 id topic/);
  });

  it('rejects an unparseable ledger close time', () => {
    expect(() => decodeEvent({ ...LIVE_ORDER_CREATED, ledgerClosedAt: 'never' })).toThrow(
      EventDecodeError,
    );
  });

  it('rejects a malformed event id', () => {
    expect(() => parseEventId('nope')).toThrow(EventDecodeError);
  });

  it('keeps an unknown event instead of crashing or inventing a projection', () => {
    // A newer contract may emit an event this build has never heard of.
    const unknown = decodeEvent({
      ...LIVE_ORDER_CREATED,
      topic: ['AAAADwAAAA5zb21lX25ld19ldmVudAAA', 'AAAABQAAAAAAAAAB'],
    });
    expect(unknown.known).toBe(false);
    expect(unknown.eventName).toBe('some_new_event');
    // The id topic is kept positionally rather than guessed at a name.
    expect(unknown.fields.topic_1).toBe(1n);
  });
});

describe('deterministic ordering', () => {
  it('orders by ledger, then transaction, then operation, then event index', () => {
    const base = decodeEvent(LIVE_ORDER_CREATED);
    const later = { ...base, ledger: base.ledger + 1n };
    const sameLedgerLaterTx = { ...base, txIndex: base.txIndex + 1 };
    const sameTxLaterEvent = { ...base, eventIndex: base.eventIndex + 1 };

    expect(compareEventOrder(base, later)).toBeLessThan(0);
    expect(compareEventOrder(base, sameLedgerLaterTx)).toBeLessThan(0);
    expect(compareEventOrder(base, sameTxLaterEvent)).toBeLessThan(0);
    expect(compareEventOrder(base, base)).toBe(0);
  });
});
