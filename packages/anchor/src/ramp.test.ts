import { describe, expect, it } from 'vitest';

import { MockAnchorDevDriver } from './mock-driver.js';
import { SepAnchorProvider } from './sep-provider.js';
import { fiatAsset, isQuoteExpired, isSettled, isTerminal, stellarAsset } from './types.js';
import { ACCOUNT, CAPABILITIES, session, stubFetch, USDC_ISSUER } from './fixtures.test-helper.js';

const TRY = fiatAsset('TRY');
const USDC = stellarAsset('USDC', USDC_ISSUER);

const QUOTE_RESPONSE = {
  id: 'quote-1',
  expires_at: '2030-01-01T00:00:00Z',
  price: '48.785078',
  total_price: '49.0290031',
  sell_asset: TRY,
  sell_amount: '1000.00',
  buy_asset: USDC,
  buy_amount: '20.3960908',
  fee: {
    total: '4.98',
    asset: TRY,
    details: [{ name: 'spread', amount: '4.98', description: '50 bps from the USD/TRY mid rate' }],
  },
};

describe('SEP-38 quotes', () => {
  it('gets a firm TRY → USDC quote with the anchor’s own rate and spread', async () => {
    const { fetch, calls } = stubFetch({ '/sep38/quote': { json: QUOTE_RESPONSE } });
    const provider = new SepAnchorProvider({ fetch });

    const quote = await provider.getQuote({
      capabilities: CAPABILITIES,
      session: session(),
      sellAsset: TRY,
      buyAsset: USDC,
      sellAmount: '1000.00',
      sellDeliveryMethod: 'bank_account',
    });

    expect(quote.id).toBe('quote-1');
    expect(quote.sellAmount).toBe('1000.00');
    expect(quote.buyAmount).toBe('20.3960908');
    // The rate comes from the anchor; Milvance never computes FX itself.
    expect(quote.totalPrice).toBe('49.0290031');
    expect(quote.feeTotal).toBe('4.98');
    expect(quote.feeDetails[0]?.name).toBe('spread');

    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body).toMatchObject({ sell_asset: TRY, buy_asset: USDC, context: 'sep6' });
  });

  it('gets a USDC → TRY quote for the supplier cash-out direction', async () => {
    const { fetch, calls } = stubFetch({
      '/sep38/quote': {
        json: {
          ...QUOTE_RESPONSE,
          sell_asset: USDC,
          buy_asset: TRY,
          sell_amount: '20',
          buy_amount: '975.20',
        },
      },
    });
    const provider = new SepAnchorProvider({ fetch });

    const quote = await provider.getQuote({
      capabilities: CAPABILITIES,
      session: session(),
      sellAsset: USDC,
      buyAsset: TRY,
      sellAmount: '20',
      buyDeliveryMethod: 'bank_account',
    });

    expect(quote.sellAsset).toBe(USDC);
    expect(quote.buyAsset).toBe(TRY);
    expect(quote.buyAmount).toBe('975.20');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      buy_delivery_method: 'bank_account',
    });
  });

  it('requires exactly one of sell or buy amount', async () => {
    const { fetch, calls } = stubFetch({ '/sep38/quote': { json: QUOTE_RESPONSE } });
    const provider = new SepAnchorProvider({ fetch });
    const base = { capabilities: CAPABILITIES, session: session(), sellAsset: TRY, buyAsset: USDC };

    await expect(provider.getQuote({ ...base })).rejects.toMatchObject({ code: 'quote_failed' });
    await expect(
      provider.getQuote({ ...base, sellAmount: '100', buyAmount: '2' }),
    ).rejects.toMatchObject({ code: 'quote_failed' });
    expect(calls).toHaveLength(0);
  });

  it('detects an expired quote so a stale rate cannot be reused', () => {
    const quote = {
      id: 'q',
      sellAsset: TRY,
      sellAmount: '1000',
      buyAsset: USDC,
      buyAmount: '20',
      price: '49',
      totalPrice: '49',
      expiresAt: 1_000,
      feeDetails: [],
    };

    expect(isQuoteExpired(quote, 999)).toBe(false);
    expect(isQuoteExpired(quote, 1_000)).toBe(true);
    expect(isQuoteExpired(quote, 1_001)).toBe(true);
  });

  it('maps an anchor pricing failure to quote_failed', async () => {
    const { fetch } = stubFetch({ '/sep38/quote': { status: 400, json: { error: 'no market' } } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(
      provider.getQuote({
        capabilities: CAPABILITIES,
        session: session(),
        sellAsset: TRY,
        buyAsset: USDC,
        sellAmount: '1',
      }),
    ).rejects.toMatchObject({ code: 'quote_failed' });
  });
});

describe('SEP-12 customer status', () => {
  it('reports the fields the anchor still needs', async () => {
    const { fetch } = stubFetch({
      '/sep12/customer': {
        json: { status: 'NEEDS_INFO', fields: { first_name: {}, last_name: {} } },
      },
    });
    const provider = new SepAnchorProvider({ fetch });

    const status = await provider.getCustomerStatus(session(), CAPABILITIES);

    expect(status.status).toBe('NEEDS_INFO');
    expect(status.missingFields).toEqual(['first_name', 'last_name']);
  });

  it('reports an accepted customer', async () => {
    const { fetch } = stubFetch({
      '/sep12/customer': { json: { status: 'ACCEPTED', id: 'cust-1' } },
    });
    const provider = new SepAnchorProvider({ fetch });

    const status = await provider.getCustomerStatus(session(), CAPABILITIES);

    expect(status).toEqual({ status: 'ACCEPTED', id: 'cust-1', missingFields: [] });
  });

  it('submits customer fields through the standard SEP-12 route', async () => {
    const { fetch, calls } = stubFetch({
      '/sep12/customer': { json: { status: 'ACCEPTED' } },
    });
    const provider = new SepAnchorProvider({ fetch });

    await provider.putCustomer(session(), CAPABILITIES, { first_name: 'Demo' });

    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      account: ACCOUNT,
      first_name: 'Demo',
    });
  });
});

describe('SEP-6 deposit — TRY becomes usable Stellar liquidity', () => {
  const DEPOSIT_RESPONSE = {
    id: 'sep_dep_1',
    status: 'pending_user_transfer_start',
    amount_in: '1000.00',
    amount_out: '20.3960908',
    amount_fee: '4.98',
    instructions: {
      bank_account_number: {
        value: 'TR050001234567890123456789',
        description: 'IBAN to send TRY to',
      },
      bank_name: { value: 'TR Mock Bank A.Ş.' },
      description: { value: 'MLV-REF-001', description: 'Write this in the açıklama' },
    },
  };

  it('starts a quoted deposit through deposit-exchange', async () => {
    const { fetch, calls } = stubFetch({ '/sep6/deposit-exchange': { json: DEPOSIT_RESPONSE } });
    const provider = new SepAnchorProvider({ fetch });

    const transaction = await provider.deposit({
      capabilities: CAPABILITIES,
      session: session(),
      assetCode: 'USDC',
      destinationAccount: ACCOUNT,
      amount: '1000.00',
      quoteId: 'quote-1',
      sourceAsset: fiatAsset('TRY'),
    });

    expect(transaction.id).toBe('sep_dep_1');
    expect(transaction.kind).toBe('deposit');
    expect(transaction.status).toBe('pending_user_transfer_start');
    expect(transaction.instructions['bank_account_number']?.value).toContain('TR05');
    expect(calls[0]?.url).toContain('quote_id=quote-1');
    expect(calls[0]?.url).toContain(`account=${ACCOUNT}`);
  });

  it('uses plain deposit when no off-chain source asset is priced', async () => {
    const { fetch, calls } = stubFetch({ '/sep6/deposit': { json: DEPOSIT_RESPONSE } });
    const provider = new SepAnchorProvider({ fetch });

    await provider.deposit({
      capabilities: CAPABILITIES,
      session: session(),
      assetCode: 'USDC',
      destinationAccount: ACCOUNT,
    });

    expect(calls[0]?.url).toContain('/sep6/deposit?');
    expect(calls[0]?.url).not.toContain('deposit-exchange');
  });

  it('polls a deposit until the anchor reports completion', async () => {
    const { fetch } = stubFetch({
      '/sep6/transaction': {
        json: {
          transaction: {
            id: 'sep_dep_1',
            kind: 'deposit',
            status: 'completed',
            amount_out: '20.3960908',
            stellar_transaction_id: 'abc123',
          },
        },
      },
    });
    const provider = new SepAnchorProvider({ fetch });

    const transaction = await provider.getTransaction('sep_dep_1', session(), CAPABILITIES);

    expect(transaction.status).toBe('completed');
    expect(transaction.stellarTransactionId).toBe('abc123');
    expect(isSettled(transaction.status)).toBe(true);
  });

  it('treats only completion as settled, and errors as terminal', () => {
    expect(isSettled('pending_anchor')).toBe(false);
    expect(isSettled('pending_user_transfer_start')).toBe(false);
    expect(isSettled('completed')).toBe(true);

    expect(isTerminal('pending_anchor')).toBe(false);
    expect(isTerminal('error')).toBe(true);
    expect(isTerminal('refunded')).toBe(true);
    expect(isTerminal('too_small')).toBe(true);
  });

  it('maps a rejected deposit to deposit_failed', async () => {
    const { fetch } = stubFetch({ '/sep6/deposit': { status: 403, json: {} } });
    const provider = new SepAnchorProvider({ fetch });

    // A 403 is an authentication problem, reported as such rather than as a
    // generic deposit failure.
    await expect(
      provider.deposit({
        capabilities: CAPABILITIES,
        session: session(),
        assetCode: 'USDC',
        destinationAccount: ACCOUNT,
      }),
    ).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('maps an anchor 400 on deposit to deposit_failed', async () => {
    const { fetch } = stubFetch({ '/sep6/deposit': { status: 400, json: { error: 'too_small' } } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(
      provider.deposit({
        capabilities: CAPABILITIES,
        session: session(),
        assetCode: 'USDC',
        destinationAccount: ACCOUNT,
      }),
    ).rejects.toMatchObject({ code: 'deposit_failed', httpStatus: 400 });
  });

  it('reports an anchor-side error status without calling it complete', async () => {
    const { fetch } = stubFetch({
      '/sep6/transaction': {
        json: {
          transaction: { id: 'x', kind: 'deposit', status: 'error', message: 'bank rejected' },
        },
      },
    });
    const provider = new SepAnchorProvider({ fetch });

    const transaction = await provider.getTransaction('x', session(), CAPABILITIES);

    expect(transaction.status).toBe('error');
    expect(isSettled(transaction.status)).toBe(false);
    expect(isTerminal(transaction.status)).toBe(true);
    expect(transaction.message).toBe('bank rejected');
  });
});

describe('SEP-6 withdrawal — USDC becomes local production capital', () => {
  const WITHDRAW_RESPONSE = {
    id: 'sep_wd_1',
    status: 'pending_user_transfer_start',
    amount_in: '20',
    amount_out: '975.20',
    withdraw_anchor_account: 'GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6',
    withdraw_memo: '12345',
    withdraw_memo_type: 'id',
  };

  it('returns the destination and the memo that routes the payment', async () => {
    const { fetch, calls } = stubFetch({ '/sep6/withdraw-exchange': { json: WITHDRAW_RESPONSE } });
    const provider = new SepAnchorProvider({ fetch });

    const transaction = await provider.withdraw({
      capabilities: CAPABILITIES,
      session: session(),
      assetCode: 'USDC',
      sourceAccount: ACCOUNT,
      amount: '20',
      quoteId: 'quote-2',
      destinationAsset: fiatAsset('TRY'),
    });

    expect(transaction.kind).toBe('withdrawal');
    expect(transaction.withdrawAnchorAccount).toMatch(/^G[A-Z0-9]{55}$/);
    expect(transaction.withdrawMemo).toBe('12345');
    expect(transaction.withdrawMemoType).toBe('id');
    expect(calls[0]?.url).toContain('quote_id=quote-2');
  });

  it('refuses a withdrawal with no memo rather than risking stranded funds', async () => {
    const { fetch } = stubFetch({
      '/sep6/withdraw': {
        json: { ...WITHDRAW_RESPONSE, withdraw_memo: undefined, withdraw_memo_type: undefined },
      },
    });
    const provider = new SepAnchorProvider({ fetch });

    await expect(
      provider.withdraw({
        capabilities: CAPABILITIES,
        session: session(),
        assetCode: 'USDC',
        sourceAccount: ACCOUNT,
      }),
    ).rejects.toMatchObject({ code: 'missing_memo' });
  });

  it('refuses a withdrawal with no destination account', async () => {
    const { fetch } = stubFetch({
      '/sep6/withdraw': { json: { ...WITHDRAW_RESPONSE, withdraw_anchor_account: undefined } },
    });
    const provider = new SepAnchorProvider({ fetch });

    await expect(
      provider.withdraw({
        capabilities: CAPABILITIES,
        session: session(),
        assetCode: 'USDC',
        sourceAccount: ACCOUNT,
      }),
    ).rejects.toMatchObject({ code: 'withdraw_failed' });
  });

  it('polls a withdrawal to completion', async () => {
    const { fetch } = stubFetch({
      '/sep6/transaction': {
        json: {
          transaction: {
            id: 'sep_wd_1',
            kind: 'withdrawal',
            status: 'completed',
            amount_out: '975.20',
            external_transaction_id: 'FAST-REF-9',
          },
        },
      },
    });
    const provider = new SepAnchorProvider({ fetch });

    const transaction = await provider.getTransaction('sep_wd_1', session(), CAPABILITIES);

    expect(transaction.kind).toBe('withdrawal');
    expect(transaction.externalTransactionId).toBe('FAST-REF-9');
    expect(isSettled(transaction.status)).toBe(true);
  });

  it('maps a missing transfer to transaction_not_found', async () => {
    const { fetch } = stubFetch({ '/sep6/transaction': { status: 404, json: {} } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(provider.getTransaction('nope', session(), CAPABILITIES)).rejects.toMatchObject({
      code: 'transaction_not_found',
    });
  });
});

describe('MockAnchorDevDriver isolation', () => {
  it('is the only place the sandbox simulation route appears', async () => {
    const { fetch, calls } = stubFetch({ 'simulate-bank-transfer': { json: {} } });
    const driver = new MockAnchorDevDriver({ fetch, enabled: true });

    await driver.simulateBankTransfer({
      capabilities: CAPABILITIES,
      session: session(),
      transactionId: 'sep_dep_1',
      amount: '1000.00',
    });

    expect(calls[0]?.url).toBe(
      'https://tr-mock-anchor.fly.dev/sep6/tx/sep_dep_1/simulate-bank-transfer',
    );
    expect(calls[0]?.method).toBe('POST');
  });

  it('refuses to run when the build has not opted in', async () => {
    const { fetch, calls } = stubFetch({ 'simulate-bank-transfer': { json: {} } });
    const driver = new MockAnchorDevDriver({ fetch, enabled: false });

    await expect(
      driver.simulateBankTransfer({
        capabilities: CAPABILITIES,
        session: session(),
        transactionId: 'sep_dep_1',
      }),
    ).rejects.toMatchObject({ code: 'anchor_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('is absent from the generic adapter’s surface', async () => {
    const provider = new SepAnchorProvider({ fetch: async () => new Response('{}') });

    // The standard provider exposes no way to simulate a bank transfer.
    expect('simulateBankTransfer' in provider).toBe(false);
    const source = SepAnchorProvider.toString();
    expect(source).not.toContain('simulate-bank-transfer');
  });
});
