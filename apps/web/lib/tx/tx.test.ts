import type { Client } from '@milvance/contract-bindings';
import { describe, expect, it, vi } from 'vitest';

import { classifyTxError, ContractRejection, tokenFailureIn, TokenFailure } from './errors';
import { IDLE, isBusy, txReducer, waitForIndexer, type TxState } from './lifecycle';
import { runContractCall, type RunnerStage } from './runner';

const ADDRESS = 'GCKFEDBA24UY7Q3KTIJC7HDUMCJPBDAJ5NGDLGKMLFMWMSEH47VXEKHW';

/** A stand-in for the generated Client: every method returns the same fake transaction. */
function fakeClient(tx: {
  simulation?: unknown;
  result: { isErr(): boolean; unwrapErr(): { message: string } };
  sign?: () => Promise<void>;
  send?: (options: {
    onSubmitted: (r: { hash: string }) => void;
    onProgress: () => void;
  }) => Promise<{ getTransactionResponse: unknown }>;
}) {
  const transaction = {
    simulation: tx.simulation,
    result: tx.result,
    sign: vi.fn(tx.sign ?? (async () => undefined)),
    send: vi.fn(
      tx.send ??
        (async (options) => {
          options.onSubmitted({ hash: 'f'.repeat(64) });
          options.onProgress();
          return {
            getTransactionResponse: {
              status: 'SUCCESS',
              txHash: 'f'.repeat(64),
              ledger: 4_770_001,
            },
          };
        }),
    ),
  };
  const client = new Proxy({}, { get: () => async () => transaction }) as unknown as Client;
  return { client, transaction };
}

const ok = { isErr: () => false, unwrapErr: () => ({ message: '' }) };
const err = (message: string) => ({ isErr: () => true, unwrapErr: () => ({ message }) });

describe('running a contract action', () => {
  it('walks preparing → signature → submitted → confirming and returns the ledger', async () => {
    const stages: RunnerStage[] = [];
    const { client } = fakeClient({ result: ok });
    const result = await runContractCall(
      { kind: 'accept-order', orderId: '1' },
      { address: ADDRESS, sign: async () => 'signed', onStage: (stage) => stages.push(stage) },
      client,
    );
    expect(stages).toEqual(['preparing', 'awaiting-signature', 'submitted', 'confirming']);
    expect(result).toEqual({ hash: 'f'.repeat(64), ledger: 4_770_001 });
  });

  it('stops at simulation when the contract says no — nothing is signed or sent', async () => {
    const { client, transaction } = fakeClient({ result: err('MilestoneNotFullyFunded') });
    await expect(
      runContractCall(
        { kind: 'request-finance', milestoneId: '1', principal: 1n, expiresAt: 1n },
        { address: ADDRESS, sign: async () => 'signed', onStage: () => undefined },
        client,
      ),
    ).rejects.toBeInstanceOf(ContractRejection);
    expect(transaction.sign).not.toHaveBeenCalled();
    expect(transaction.send).not.toHaveBeenCalled();
  });

  it('reports a USDC token failure as such, not as a mismatched contract error', async () => {
    // The SDK would map this token #10 to MilvanceCore #10, "OrderNotFound".
    const { client, transaction } = fakeClient({
      simulation: {
        error:
          'HostError: Error(Contract, #10)\n[Diagnostic Event] data:["balance is not sufficient to spend: 0 < 20000000000"]',
        events: [],
        id: '1',
        latestLedger: 1,
        _parsed: true,
      },
      result: err('OrderNotFound'),
    });
    const failure = runContractCall(
      { kind: 'fund-milestone', milestoneId: '1', amount: 20_000_000_000n },
      { address: ADDRESS, sign: async () => 'signed', onStage: () => undefined },
      client,
    );
    await expect(failure).rejects.toBeInstanceOf(TokenFailure);
    await expect(failure).rejects.toMatchObject({ kind: 'insufficient-balance' });
    expect(transaction.sign).not.toHaveBeenCalled();
  });

  it('never submits when the wallet signature is declined', async () => {
    const { client, transaction } = fakeClient({
      result: ok,
      sign: async () => {
        throw new Error('User declined access');
      },
    });
    let stage: RunnerStage = 'preparing';
    const run = runContractCall(
      { kind: 'verify-milestone', milestoneId: '1', evidenceHash: 'a'.repeat(64) },
      { address: ADDRESS, sign: async () => 'x', onStage: (next) => (stage = next) },
      client,
    );
    await expect(run).rejects.toThrow(/declined/);
    expect(transaction.send).not.toHaveBeenCalled();
    expect(classifyTxError(new Error('User declined access'), stage).kind).toBe('rejected');
  });

  it('treats a non-SUCCESS ledger result as a failure, never as done', async () => {
    const { client } = fakeClient({
      result: ok,
      send: async () => ({ getTransactionResponse: { status: 'FAILED' } }),
    });
    await expect(
      runContractCall(
        { kind: 'settle-milestone', milestoneId: '1' },
        { address: ADDRESS, sign: async () => 'signed', onStage: () => undefined },
        client,
      ),
    ).rejects.toThrow(/not confirmed successfully/);
  });

  it('refuses a malformed evidence digest before touching the network', async () => {
    const { client } = fakeClient({ result: ok });
    await expect(
      runContractCall(
        { kind: 'submit-evidence', milestoneId: '1', evidenceHash: 'not-a-digest' },
        { address: ADDRESS, sign: async () => 'signed', onStage: () => undefined },
        client,
      ),
    ).rejects.toThrow(/SHA-256/);
  });
});

describe('classifying failures', () => {
  it.each([
    ['trustline entry is missing for account', 'missing-trustline'],
    ['balance is not sufficient to spend', 'insufficient-balance'],
    ['account entry is missing', 'unfunded-account'],
  ])('recognises token failure %j', (text, kind) => {
    expect(tokenFailureIn(text)?.kind).toBe(kind);
  });

  it('ignores simulation text that is not a token failure', () => {
    expect(tokenFailureIn('HostError: Error(Contract, #54)')).toBeNull();
  });

  it('explains an unfunded signer account instead of echoing the SDK', () => {
    // Thrown while building: Stellar has no account for a Freighter account
    // that was created but never funded on Testnet.
    const failure = classifyTxError(
      new Error('Account not found: GBRQHY4M4AFUTO663KVOOQ4HP3GTW7HSPTH6GFAB5DVOXRGH2TFAMVCT'),
      'preparing',
    );
    expect(failure.kind).toBe('unfunded-account');
    expect(failure.message).toMatch(/Friendbot/);
    expect(failure.message).not.toMatch(/Account not found/);
  });

  it('explains contract rejections in product language', () => {
    const failure = classifyTxError(new ContractRejection('AlreadyFinanced'), 'preparing');
    expect(failure.kind).toBe('contract');
    expect(failure.message).toMatch(/cannot be financed twice/);
  });

  it('never tells a funder their position is guaranteed', () => {
    // A spot check that no rejection copy promises safety.
    for (const code of ['InvalidFunder', 'OfferExpired', 'RepaymentExceedsEscrow']) {
      expect(classifyTxError(new ContractRejection(code), 'preparing').message).not.toMatch(
        /guarantee|risk-free/i,
      );
    }
  });

  it('distinguishes wrong network, timeout and RPC failure', () => {
    expect(
      classifyTxError(new Error('Switch Freighter to Stellar Testnet before signing.'), 'preparing')
        .kind,
    ).toBe('wrong-network');
    expect(
      classifyTxError(new Error('Waited 30s but transaction was not finalized'), 'confirming').kind,
    ).toBe('timeout');
    expect(classifyTxError(new TypeError('Failed to fetch'), 'preparing').kind).toBe('rpc');
  });
});

describe('transaction lifecycle', () => {
  const walk = (events: Parameters<typeof txReducer>[1][]): TxState =>
    events.reduce(txReducer, IDLE);

  it('goes from review to a refreshed workspace', () => {
    const state = walk([
      { type: 'start', label: 'Verify milestone' },
      { type: 'stage', stage: 'awaiting-signature' },
      { type: 'stage', stage: 'submitted', hash: 'h' },
      { type: 'stage', stage: 'confirming' },
      { type: 'confirmed', hash: 'h', ledger: 10 },
    ]);
    expect(state.stage).toBe('syncing');
    expect(isBusy(state)).toBe(true);
    expect(txReducer(state, { type: 'synced' }).stage).toBe('synced');
  });

  it('keeps a confirmed transaction confirmed even if the workspace lags', () => {
    const state = walk([
      { type: 'start', label: 'x' },
      { type: 'confirmed', hash: 'h', ledger: 10 },
      { type: 'sync-delayed' },
    ]);
    expect(state.stage).toBe('sync-delayed');
    expect(state.hash).toBe('h');
    expect(isBusy(state)).toBe(false);
  });

  it('ignores late progress after a failure', () => {
    const failed = walk([
      { type: 'start', label: 'x' },
      { type: 'failed', failure: { kind: 'rejected', message: 'declined' } },
    ]);
    expect(txReducer(failed, { type: 'stage', stage: 'confirming' }).stage).toBe('failed');
  });
});

describe('waiting for the read model', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('returns once the indexer has scanned the transaction ledger', async () => {
    const reads = ['100', '104', '105'];
    const c = clock();
    const outcome = await waitForIndexer(
      105,
      async () => ({ scannedThroughLedger: reads.shift() ?? '105' }),
      c,
    );
    expect(outcome).toBe('synced');
  });

  it('reports delay, not failure, when the indexer does not catch up in time', async () => {
    const c = clock();
    const outcome = await waitForIndexer(200, async () => ({ scannedThroughLedger: '100' }), {
      ...c,
      timeoutMs: 10_000,
    });
    expect(outcome).toBe('delayed');
  });

  it('keeps waiting through API errors', async () => {
    let calls = 0;
    const c = clock();
    const outcome = await waitForIndexer(
      5,
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('API down');
        return { scannedThroughLedger: '5' };
      },
      c,
    );
    expect(outcome).toBe('synced');
  });
});
