import { Client, networks } from '@milvance/contract-bindings';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * Event fixtures built from the DEPLOYED contract's own spec.
 *
 * Every fixture here is encoded the way `soroban-sdk` actually encodes a
 * `#[contractevent]`: the event name as the first topic, the `#[topic]` fields
 * as further topics in declaration order, and the remaining fields as an ScMap
 * keyed by field name. That shape was verified against two real Testnet events
 * before any of this was written (see `decoder.test.ts`).
 *
 * Crucially the *catalog* — which fields exist, their types, and whether each is
 * a topic — is read from the contract spec embedded in the generated bindings
 * rather than typed out by hand. A fixture cannot drift from the contract
 * without the spec drifting too, at which point `decoder.test.ts` fails.
 */

interface EventParamSpec {
  readonly name: string;
  readonly isTopic: boolean;
  readonly type: xdr.ScSpecTypeDef;
}

export interface ContractEventSpec {
  /** Struct name as declared in Rust, e.g. `OrderCreated`. */
  readonly structName: string;
  /** Wire event name — the first topic — e.g. `order_created`. */
  readonly eventName: string;
  readonly params: readonly EventParamSpec[];
}

/**
 * The generated `Client` carries the contract spec, but does not surface it on
 * its public type. Reading it here is deliberate and test-only: it is what lets
 * these fixtures be derived from the real contract rather than transcribed.
 */
interface SpecCarrier {
  readonly spec: { readonly entries: xdr.ScSpecEntry[] };
}

function specEntries(): xdr.ScSpecEntry[] {
  const client = new Client({
    contractId: networks.testnet.contractId,
    networkPassphrase: networks.testnet.networkPassphrase,
    // No request is ever made: only the embedded spec is read.
    rpcUrl: 'https://rpc.invalid',
  });
  return (client as unknown as SpecCarrier).spec.entries;
}

/** Read every `#[contractevent]` the deployed contract declares. */
export function contractEventSpecs(): ContractEventSpec[] {
  const entries = specEntries();
  const out: ContractEventSpec[] = [];
  for (const entry of entries) {
    if (entry.switch().name !== 'scSpecEntryEventV0') {
      continue;
    }
    const event = entry.eventV0();
    out.push({
      structName: event.name().toString(),
      eventName: event
        .prefixTopics()
        .map((topic) => topic.toString())
        .join('.'),
      params: event.params().map((param) => ({
        name: param.name().toString(),
        isTopic: param.location().name === 'scSpecEventParamLocationTopicList',
        type: param.type(),
      })),
    });
  }
  return out;
}

/** Encode one value according to its spec type, exactly as the contract would. */
function encode(type: xdr.ScSpecTypeDef, value: unknown): xdr.ScVal {
  const kind = type.switch().name;
  switch (kind) {
    case 'scSpecTypeU64':
      return xdr.ScVal.scvU64(new xdr.Uint64(value as bigint));
    case 'scSpecTypeU32':
      return xdr.ScVal.scvU32(Number(value));
    case 'scSpecTypeI128':
      return nativeToScVal(value as bigint, { type: 'i128' });
    case 'scSpecTypeBool':
      return xdr.ScVal.scvBool(Boolean(value));
    case 'scSpecTypeAddress':
      return Address.fromString(String(value)).toScVal();
    case 'scSpecTypeBytesN':
      return xdr.ScVal.scvBytes(Buffer.from(String(value), 'hex'));
    case 'scSpecTypeOption': {
      if (value === null || value === undefined) {
        return xdr.ScVal.scvVoid();
      }
      return encode(type.option().valueType(), value);
    }
    default:
      throw new Error(`Fixture builder has no encoder for spec type ${kind}`);
  }
}

export interface BuiltEvent {
  readonly topic: string[];
  readonly value: string;
}

/**
 * Build the on-the-wire topics and value for one event.
 *
 * Unknown or missing fields throw: a fixture that silently omits a field would
 * quietly weaken every test that uses it.
 */
export function buildEventXdr(
  eventName: string,
  fields: Readonly<Record<string, unknown>>,
): BuiltEvent {
  const spec = contractEventSpecs().find((candidate) => candidate.eventName === eventName);
  if (spec === undefined) {
    throw new Error(`No such contract event: ${eventName}`);
  }

  const topics: xdr.ScVal[] = [xdr.ScVal.scvSymbol(eventName)];
  const mapEntries: xdr.ScMapEntry[] = [];

  for (const param of spec.params) {
    if (!(param.name in fields)) {
      throw new Error(`Fixture for ${eventName} is missing field ${param.name}`);
    }
    const encoded = encode(param.type, fields[param.name]);
    if (param.isTopic) {
      topics.push(encoded);
    } else {
      mapEntries.push(new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(param.name), val: encoded }));
    }
  }

  for (const key of Object.keys(fields)) {
    if (!spec.params.some((param) => param.name === key)) {
      throw new Error(`Fixture for ${eventName} sets unknown field ${key}`);
    }
  }

  // Soroban serialises an ScMap with keys in sorted order.
  mapEntries.sort((a, b) => {
    const left = a.key().sym().toString();
    const right = b.key().sym().toString();
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return {
    topic: topics.map((topic) => topic.toXDR('base64')),
    value: xdr.ScVal.scvMap(mapEntries).toXDR('base64'),
  };
}

/** Deterministic Testnet addresses for fixtures. Public keys only, never secrets. */
export const ADDRESSES = {
  buyer: 'GCKFEDBA24UY7Q3KTIJC7HDUMCJPBDAJ5NGDLGKMLFMWMSEH47VXEKHW',
  supplier: 'GBBS3FS2CXYQRUHDCGGAYTQCJ6BELVSWZSKXOGMSNWWBYMZ2RGZDYHXQ',
  attestor: 'GDU5EPX7YMT65OJRDNQYFKK7S2MDET6E4KHLFSSZZNZMQUHLRJAKRXDH',
  resolver: 'GD75QRXBDJ7F3P3I4ZLQJISCVA2FHE3ETPY5GFB3IA5UZSDA7ZJP3NBD',
  funder: 'GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M',
  usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
} as const;

export const CONTRACT_ID = networks.testnet.contractId;
export const NETWORK = 'testnet';

let sequence = 0;

/** A raw RPC-shaped event, with plausible ledger/tx metadata. */
export function rawEvent(
  eventName: string,
  fields: Readonly<Record<string, unknown>>,
  overrides: Partial<{
    ledger: number;
    txHash: string;
    eventIndex: number;
    txIndex: number;
    operationIndex: number;
    successful: boolean;
    ledgerClosedAt: string;
    contractId: string;
  }> = {},
) {
  sequence += 1;
  const ledger = overrides.ledger ?? 4_760_000 + sequence;
  const eventIndex = overrides.eventIndex ?? 0;
  // Mirrors the real `<toid>-<index>` id: zero-padded and lexicographically ordered.
  const toid = (BigInt(ledger) << 32n) + BigInt(sequence);
  const built = buildEventXdr(eventName, fields);
  return {
    id: `${toid.toString().padStart(19, '0')}-${String(eventIndex).padStart(10, '0')}`,
    type: 'contract',
    ledger,
    ledgerClosedAt:
      overrides.ledgerClosedAt ?? new Date(1_789_830_000_000 + sequence * 5000).toISOString(),
    contractId: overrides.contractId ?? CONTRACT_ID,
    txHash: overrides.txHash ?? `tx${String(sequence).padStart(62, '0')}`,
    topic: built.topic,
    value: built.value,
    inSuccessfulContractCall: overrides.successful ?? true,
    operationIndex: overrides.operationIndex ?? 0,
    transactionIndex: overrides.txIndex ?? 0,
  };
}

export function resetFixtureSequence(): void {
  sequence = 0;
}
