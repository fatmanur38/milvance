'use client';

import { useCallback, useEffect, useState } from 'react';

import type {
  AnchorCapabilities,
  AnchorQuote,
  AnchorTransaction,
  CustomerStatus,
} from '@milvance/anchor';
import { AnchorError } from '@milvance/anchor';

import { anchorProvider, mockAnchorDriver } from '@/lib/anchor/client';
import {
  anchorConfig,
  explorerTransaction,
  mockAnchorEnabled,
  TRY_ASSET,
  USDC_ASSET,
} from '@/lib/anchor/config';
import {
  assertQuoteUsable,
  describeStatus,
  formatLocal,
  formatUsdc,
  isFinished,
  pollTransfer,
  quoteSecondsLeft,
  validateDepositAmount,
  validateWithdrawAmount,
} from '@/lib/anchor/flow';
import {
  buildWithdrawalPaymentXdr,
  planWithdrawalPayment,
  submitSignedPayment,
} from '@/lib/anchor/payment';
import { buildLocalPaymentLeg } from '@/lib/anchor/record';
import { activeSession, clearSession, storeSession } from '@/lib/anchor/session';
import { api } from '@/lib/api/queries';
import { canSign } from '@/lib/wallet/controller';
import { useWallet } from '@/lib/wallet/provider';

type Direction = 'deposit' | 'withdraw';

function messageOf(error: unknown): string {
  if (error instanceof AnchorError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/**
 * The PKG-07 local-payment flow, reusable in context.
 *
 * The SEP protocol logic is unchanged from PKG-07: the browser talks to the
 * Anchor directly, the wallet signs every step, and the SEP-10 session never
 * leaves this tab. The only additions are optional starting values, so that a
 * supplier who just received an advance lands here ready to convert it.
 */
export interface LocalPaymentsPanelProps {
  readonly initialDirection?: Direction;
  readonly initialAmount?: string;
  /** Where the person came from, e.g. "Working capital from Order #3, Milestone 1". */
  readonly context?: string;
}

export function LocalPaymentsPanel({
  initialDirection = 'deposit',
  initialAmount,
  context,
}: LocalPaymentsPanelProps): React.ReactElement {
  const { controller, state } = useWallet();
  // Connected on Testnet is enough to show the flow; the trustline notice
  // below explains what is still needed before USDC can move.
  const address = canSign(state) ? (state.address ?? null) : null;
  const trustline = address !== null ? (state.trustline ?? null) : null;

  const [capabilities, setCapabilities] = useState<AnchorCapabilities | null>(null);
  const [customer, setCustomer] = useState<CustomerStatus | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [direction, setDirection] = useState<Direction>(initialDirection);
  const [amount, setAmount] = useState(
    initialAmount ?? (initialDirection === 'deposit' ? '1000' : '20'),
  );
  const [quote, setQuote] = useState<AnchorQuote | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [transfer, setTransfer] = useState<AnchorTransaction | null>(null);
  const [simulationSubmitted, setSimulationSubmitted] = useState(false);
  const [paymentHash, setPaymentHash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<'saved' | 'skipped' | null>(null);

  // Discovery needs no wallet: it is how we learn what this provider offers.
  useEffect(() => {
    anchorProvider
      .discover(anchorConfig.homeDomain)
      .then(setCapabilities)
      .catch((cause: unknown) => setError(messageOf(cause)));
  }, []);

  useEffect(() => {
    if (!quote) return;
    const tick = () => setSecondsLeft(quoteSecondsLeft(quote, Math.floor(Date.now() / 1000)));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [quote]);

  /**
   * Records a finished leg so traction can connect local money to chain money.
   *
   * Deliberately best-effort: the conversion already happened on Stellar and at
   * the Anchor, and failing to write an analytics row must never be presented
   * as a failed payment. What it records is a claim — the API checks the hash
   * against Horizon before it counts for anything.
   */
  const recordLeg = useCallback(
    async (
      finished: AnchorTransaction,
      kind: Direction,
      wallet: string,
      submittedPaymentHash: string | null,
      sentAmount: string | null,
    ) => {
      const built = buildLocalPaymentLeg({
        transfer: finished,
        direction: kind,
        walletAddress: wallet,
        submittedPaymentHash,
        sentAmount,
      });
      if (!built.ok) {
        setRecorded('skipped');
        return;
      }
      try {
        await api.recordLocalPayment(built.leg);
        setRecorded('saved');
      } catch {
        setRecorded('skipped');
      }
    },
    [],
  );

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await task();
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const signIn = () =>
    run('Signing in', async () => {
      if (!capabilities || !address) throw new Error('Connect your wallet first.');
      const challenge = await anchorProvider.beginAuth({ capabilities, account: address });
      // The user's wallet signs. No key ever reaches Milvance.
      const signed = await controller.signRaw(challenge.transactionXdr);
      const session = await anchorProvider.completeAuth({
        capabilities,
        signedTransactionXdr: signed,
      });
      storeSession(session);
      setSignedIn(true);
      setCustomer(await anchorProvider.getCustomerStatus(session, capabilities));
    });

  const verifyCustomer = () =>
    run('Verifying', async () => {
      const session = activeSession();
      if (!capabilities || !session) throw new Error('Sign in to the provider first.');
      setCustomer(await anchorProvider.putCustomer(session, capabilities, {}));
    });

  const getRate = () =>
    run('Getting rate', async () => {
      const session = activeSession();
      if (!capabilities || !session) throw new Error('Sign in to the provider first.');

      const invalid =
        direction === 'deposit' ? validateDepositAmount(amount) : validateWithdrawAmount(amount);
      if (invalid) throw new Error(invalid);

      setQuote(
        await anchorProvider.getQuote({
          capabilities,
          session,
          sellAsset: direction === 'deposit' ? TRY_ASSET : USDC_ASSET,
          buyAsset: direction === 'deposit' ? USDC_ASSET : TRY_ASSET,
          sellAmount: amount,
          context: 'sep6',
          ...(direction === 'deposit'
            ? { sellDeliveryMethod: 'bank_account' }
            : { buyDeliveryMethod: 'bank_account' }),
        }),
      );
      setTransfer(null);
      setSimulationSubmitted(false);
      setPaymentHash(null);
    });

  const startDeposit = () =>
    run('Starting deposit', async () => {
      const session = activeSession();
      if (!capabilities || !session || !address || !quote) {
        throw new Error('Get a rate first.');
      }
      assertQuoteUsable(quote, Math.floor(Date.now() / 1000));
      setTransfer(
        await anchorProvider.deposit({
          capabilities,
          session,
          assetCode: anchorConfig.assetCode,
          destinationAccount: address,
          amount,
          quoteId: quote.id,
          sourceAsset: TRY_ASSET,
        }),
      );
      setSimulationSubmitted(false);
    });

  const simulateBank = () =>
    run('Simulating bank transfer', async () => {
      const session = activeSession();
      if (!capabilities || !session || !transfer) throw new Error('Start a deposit first.');
      // A network failure can occur after the provider accepts the POST. Treat
      // an uncertain response as submitted until its transaction is checked.
      setSimulationSubmitted(true);
      await mockAnchorDriver.simulateBankTransfer({
        capabilities,
        session,
        transactionId: transfer.id,
        amount,
      });
      setBusy('Checking provider status');
      const finished = await pollTransfer(
        (id, s, c) => anchorProvider.getTransaction(id, s, c),
        transfer.id,
        session,
        capabilities,
        { onUpdate: setTransfer, maxAttempts: 10 },
      );
      setTransfer(finished);
      if (finished.status === 'completed') {
        if (address !== null) await recordLeg(finished, 'deposit', address, null, null);
        await controller.refresh();
      }
    });

  const refreshDeposit = () =>
    run('Checking provider status', async () => {
      const session = activeSession();
      if (!capabilities || !session || !transfer || transfer.kind !== 'deposit') {
        throw new Error('Start a deposit first.');
      }
      const latest = await anchorProvider.getTransaction(transfer.id, session, capabilities);
      setTransfer(latest);
      if (latest.status === 'completed') {
        if (address !== null) await recordLeg(latest, 'deposit', address, null, null);
        await controller.refresh();
      }
    });

  const startWithdraw = () =>
    run('Starting cash-out', async () => {
      const session = activeSession();
      if (!capabilities || !session || !address || !quote) throw new Error('Get a rate first.');
      assertQuoteUsable(quote, Math.floor(Date.now() / 1000));

      const created = await anchorProvider.withdraw({
        capabilities,
        session,
        assetCode: anchorConfig.assetCode,
        sourceAccount: address,
        amount,
        quoteId: quote.id,
        destinationAsset: TRY_ASSET,
      });
      setTransfer(created);

      // The memo is what ties this payment to the withdrawal. Refuse to build
      // a payment without it rather than let the user strand their USDC.
      const plan = planWithdrawalPayment(created, amount);
      const xdr = await buildWithdrawalPaymentXdr(address, plan);
      const signed = await controller.signRaw(xdr);
      const hash = await submitSignedPayment(signed);
      setPaymentHash(hash);

      const finished = await pollTransfer(
        (id, s, c) => anchorProvider.getTransaction(id, s, c),
        created.id,
        session,
        capabilities,
        { onUpdate: setTransfer },
      );
      setTransfer(finished);
      // The hash we submitted ourselves is the strongest evidence available:
      // we know exactly which payment settled this withdrawal.
      await recordLeg(finished, 'withdraw', address, hash, plan.amount);
      await controller.refresh();
    });

  const signOut = () => {
    clearSession();
    setSignedIn(false);
    setCustomer(null);
    setQuote(null);
    setTransfer(null);
    setSimulationSubmitted(false);
    setPaymentHash(null);
    setRecorded(null);
  };

  const sessionLive = signedIn && activeSession() !== null;
  const quoteExpired = quote !== null && secondsLeft === 0;
  const customerReady = customer?.status === 'ACCEPTED';

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Local money</h1>
        <p className="text-sm opacity-80">
          Milvance settles in USDC, but production is paid for in {anchorConfig.localCurrency}. This
          is the edge where the two meet.
        </p>
      </header>

      {/* Economic meaning first, mechanics second. */}
      <section className="grid gap-3 rounded-lg border border-current/15 p-4 text-sm">
        <div>
          <span className="font-medium">Bring money in</span>
          <p className="opacity-75">
            {anchorConfig.localCurrency} → USDC you can commit to a protected milestone.
          </p>
        </div>
        <div>
          <span className="font-medium">Turn an advance into production capital</span>
          <p className="opacity-75">
            Funder advance in USDC → {anchorConfig.localCurrency} for materials, workers and local
            logistics. This is the point of the advance: the supplier can start work now.
          </p>
        </div>
      </section>

      {context && (
        <p className="rounded-lg border border-current/15 p-4 text-sm" role="status">
          {context}. This converts working capital a funder sent you — never the buyer’s protected
          milestone payment, which stays locked on Stellar.
        </p>
      )}

      {!address && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-current/15 p-4 text-sm">
          <p>Connect your wallet first. You sign every action yourself.</p>
          <button
            type="button"
            onClick={() => void controller.connect()}
            className="rounded border border-current/30 px-4 py-2"
          >
            Connect wallet
          </button>
        </div>
      )}

      {address && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="opacity-70">Wallet</span>
            <code className="rounded bg-current/10 px-2 py-1 text-xs">{address}</code>
            {trustline === 'missing' && (
              <span className="rounded bg-current/10 px-2 py-1 text-xs">
                No USDC trustline — add it in your wallet before receiving USDC.
              </span>
            )}
            {trustline === 'unfunded' && (
              <span className="rounded bg-current/10 px-2 py-1 text-xs">
                Account not funded on Testnet.
              </span>
            )}
          </div>

          {!sessionLive ? (
            <button
              type="button"
              onClick={signIn}
              disabled={!capabilities || busy !== null}
              className="w-fit rounded border border-current/30 px-4 py-2 text-sm disabled:opacity-50"
            >
              {busy ?? 'Sign in to the local-payment provider'}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="opacity-70">
                Signed in{customer ? ` · verification ${customer.status.toLowerCase()}` : ''}
              </span>
              {!customerReady && (
                <button
                  type="button"
                  onClick={verifyCustomer}
                  disabled={busy !== null}
                  className="rounded border border-current/30 px-3 py-1 text-xs disabled:opacity-50"
                >
                  Complete verification
                </button>
              )}
              <button type="button" onClick={signOut} className="text-xs underline opacity-70">
                Sign out
              </button>
            </div>
          )}
        </section>
      )}

      {sessionLive && (
        <section className="flex flex-col gap-4 rounded-lg border border-current/15 p-4">
          <div className="flex gap-2 text-sm">
            {(['deposit', 'withdraw'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setDirection(value);
                  setQuote(null);
                  setTransfer(null);
                  setPaymentHash(null);
                  setAmount(value === 'deposit' ? '1000' : '20');
                }}
                className={`rounded px-3 py-1 ${direction === value ? 'bg-current/15' : 'opacity-60'}`}
              >
                {value === 'deposit'
                  ? `${anchorConfig.localCurrency} → USDC`
                  : `USDC → ${anchorConfig.localCurrency}`}
              </button>
            ))}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="opacity-70">
              {direction === 'deposit'
                ? `Amount to deposit (${anchorConfig.localCurrency})`
                : 'Advance to convert (USDC)'}
            </span>
            <input
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setQuote(null);
              }}
              inputMode="decimal"
              className="w-48 rounded border border-current/25 bg-transparent px-3 py-2"
            />
          </label>

          <button
            type="button"
            onClick={getRate}
            disabled={busy !== null || !customerReady}
            className="w-fit rounded border border-current/30 px-4 py-2 text-sm disabled:opacity-50"
          >
            Get rate
          </button>
          {!customerReady && (
            <p className="text-xs opacity-70">Complete verification to request a rate.</p>
          )}

          {quote && (
            <div className="grid gap-1 rounded border border-current/15 p-3 text-sm">
              <div className="font-medium">
                {direction === 'deposit'
                  ? `${formatLocal(quote.sellAmount)} → ${formatUsdc(quote.buyAmount)}`
                  : `${formatUsdc(quote.sellAmount)} → ${formatLocal(quote.buyAmount)}`}
              </div>
              <div className="opacity-70">
                Rate {quote.totalPrice} (provider’s rate, including spread)
              </div>
              {quote.feeTotal && <div className="opacity-70">Fee {quote.feeTotal}</div>}
              <div className={quoteExpired ? 'text-xs' : 'text-xs opacity-70'}>
                {quoteExpired
                  ? 'Rate expired — get a new one.'
                  : `Rate valid for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} more — continue now.`}
              </div>
            </div>
          )}

          {quote && !quoteExpired && direction === 'deposit' && !transfer && (
            <button
              type="button"
              onClick={startDeposit}
              disabled={busy !== null}
              className="w-fit rounded border border-current/30 px-4 py-2 text-sm disabled:opacity-50"
            >
              Start deposit
            </button>
          )}

          {quote && !quoteExpired && direction === 'withdraw' && (
            <button
              type="button"
              onClick={startWithdraw}
              disabled={busy !== null}
              className="w-fit rounded border border-current/30 px-4 py-2 text-sm disabled:opacity-50"
            >
              {busy ?? `Convert to ${anchorConfig.localCurrency}`}
            </button>
          )}
        </section>
      )}

      {transfer && (
        <section className="flex flex-col gap-3 rounded-lg border border-current/15 p-4 text-sm">
          <div className="font-medium">{describeStatus(transfer)}</div>
          <div className="opacity-70">
            {transfer.amountIn && <>In {transfer.amountIn} · </>}
            {transfer.amountOut && <>Out {transfer.amountOut} · </>}
            Reference <code className="text-xs">{transfer.id}</code>
          </div>

          {Object.keys(transfer.instructions).length > 0 && (
            <div className="grid gap-1 rounded border border-current/15 p-3">
              <div className="font-medium">Send your {anchorConfig.localCurrency} here</div>
              {Object.entries(transfer.instructions).map(([key, field]) => (
                <div key={key} className="flex flex-wrap gap-2">
                  <span className="opacity-60">{field.description ?? key}</span>
                  <code className="text-xs">{field.value}</code>
                </div>
              ))}
            </div>
          )}

          {paymentHash && (
            <a
              className="underline"
              href={explorerTransaction(paymentHash)}
              target="_blank"
              rel="noreferrer"
            >
              View your USDC payment on the explorer
            </a>
          )}
          {transfer.stellarTransactionId && (
            <a
              className="underline"
              href={explorerTransaction(transfer.stellarTransactionId)}
              target="_blank"
              rel="noreferrer"
            >
              View the Stellar settlement
            </a>
          )}
          {recorded !== null && (
            <div className="text-xs opacity-70">
              {recorded === 'saved' ? (
                <>
                  Recorded as a local-payment leg. The {anchorConfig.localCurrency} side stays the
                  provider&rsquo;s word; the Stellar side is checked against Horizon before it
                  counts towards any metric.
                </>
              ) : (
                <>
                  Not recorded for metrics — nothing was missing from your conversion, only the
                  bookkeeping entry. The money moved exactly as shown above.
                </>
              )}
            </div>
          )}

          {transfer.externalTransactionId && (
            <div className="opacity-70">
              Payout reference <code className="text-xs">{transfer.externalTransactionId}</code>
            </div>
          )}

          {/* Development infrastructure, clearly fenced off from the product. */}
          {mockAnchorEnabled &&
            transfer.kind === 'deposit' &&
            transfer.status === 'pending_user_transfer_start' &&
            !simulationSubmitted && (
              <div className="rounded border border-dashed border-current/40 p-3">
                <div className="text-xs font-medium uppercase tracking-wide opacity-70">
                  Sandbox tool — not a real bank transfer
                </div>
                <p className="mt-1 text-xs opacity-70">
                  A production provider learns the {anchorConfig.localCurrency} arrived from its
                  bank integration. This sandbox needs someone to say so. No real money moves; the
                  Stellar leg it triggers is real Testnet USDC.
                </p>
                <button
                  type="button"
                  onClick={simulateBank}
                  disabled={busy !== null}
                  className="mt-2 rounded border border-current/30 px-3 py-1 text-xs disabled:opacity-50"
                >
                  {busy ?? 'Simulate the bank transfer'}
                </button>
              </div>
            )}
          {transfer.kind === 'deposit' && !isFinished(transfer) && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span>
                {transfer.status !== 'pending_user_transfer_start'
                  ? 'The provider is processing this transfer. Check its status; do not simulate the same bank transfer again.'
                  : simulationSubmitted
                    ? 'The simulation request may have reached the provider. Check its status before starting another transfer.'
                    : 'After sending the bank transfer, check its status here.'}
              </span>
              <button
                type="button"
                onClick={refreshDeposit}
                disabled={busy !== null}
                className="rounded border border-current/30 px-3 py-1 disabled:opacity-50"
              >
                Check transfer status
              </button>
            </div>
          )}
        </section>
      )}

      {error && (
        <p className="rounded-lg border border-current/30 p-4 text-sm" role="alert">
          {error}
        </p>
      )}

      <footer className="text-xs opacity-60">
        <p>
          Provider {anchorConfig.homeDomain} on Stellar Testnet. Simulated verification and
          simulated bank rails; Stellar movement is real Testnet USDC. Your wallet signs every
          action — no Milvance server holds your keys or your provider session.
        </p>
      </footer>
    </div>
  );
}
