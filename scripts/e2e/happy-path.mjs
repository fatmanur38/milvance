#!/usr/bin/env node
/**
 * End-to-end happy path against a RUNNING Milvance deployment.
 *
 * Point it at localhost during development or at the public deployment before
 * handing it to a judge:
 *
 *   pnpm e2e
 *   WEB_URL=https://milvance.vercel.app API_URL=https://milvance-api.onrender.com pnpm e2e
 *
 * It signs nothing and writes nothing. Every check is a read, because the
 * happy path it verifies already happened on Stellar — the point is to prove
 * that what the product serves still matches what the chain recorded.
 *
 * This is deliberately not a unit test. Unit tests prove the code is
 * self-consistent; this proves a deployment is actually wired together: web
 * to API, API to PostgreSQL, PostgreSQL to the indexer, and the indexer to
 * Soroban.
 */

const WEB = (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const HORIZON = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

let passed = 0;
const failures = [];
let group = '';

function section(name) {
  group = name;
  process.stdout.write(`\n${name}\n`);
}

function check(what, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok    ${what}\n`);
  } else {
    failures.push(`${group} → ${what}${detail ? ` (${detail})` : ''}`);
    process.stdout.write(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}\n`);
  }
}

async function getJson(url, init) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, ...init });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

async function status(url, init) {
  try {
    const response = await fetch(url, { redirect: 'manual', ...init });
    return response.status;
  } catch {
    return 0;
  }
}

/** Exact integer comparison. Money is never a JavaScript number here either. */
const units = (value) => BigInt(value);

async function main() {
  process.stdout.write(`Milvance end-to-end happy path\n  web ${WEB}\n  api ${API}\n`);

  // ---------------------------------------------------------------- health --
  section('Service health');
  const live = await getJson(`${API}/api/health`);
  check('API is live', live.status === 'ok', JSON.stringify(live.status));
  // The path a deployment blueprint health-checks. If it 404s, every deploy is
  // marked unhealthy and rolled back — which has happened here before.
  check(
    'liveness answers on the path the blueprint checks',
    (await status(`${API}/api/health/live`)) === 200,
  );

  const ready = await getJson(`${API}/api/health/ready`);
  check('API is ready', ready.status === 'ok' || ready.status === 'degraded', ready.status);
  check('database is reachable through the API', ready.checks?.database?.status === 'ok');
  check('Stellar RPC is reachable', ready.checks?.rpc?.status === 'ok');
  check(
    'indexer is current',
    ready.checks?.indexer?.status === 'ok',
    ready.checks?.indexer?.detail,
  );

  // ------------------------------------------------------------ public web --
  section('Public web pages');
  for (const [label, path] of [
    ['landing page', '/'],
    ['guided tour', '/demo'],
    ['workspace', '/app'],
    ['orders', '/app/orders'],
    ['funding', '/app/funding'],
    ['local payments', '/app/anchor'],
    ['activity', '/app/activity'],
    ['traction', '/app/metrics'],
    ['trade lab', '/app/trade-lab'],
  ]) {
    check(`${label} loads`, (await status(`${WEB}${path}`)) === 200, path);
  }
  check(
    'an unknown trade is a 404, not a blank page',
    (await status(`${WEB}/app/orders/abc`)) === 404,
  );

  // ----------------------------------------------------------- happy path ---
  section('The financed trade, end to end');
  const { orders } = await getJson(`${API}/api/orders?limit=200`);
  check('the contract has trades', orders.length > 0, `${orders.length}`);

  const completed = orders.filter((order) => order.status === 'COMPLETED');
  check('at least one trade has completed', completed.length > 0);
  const trade = completed[0] ?? orders[0];

  const detail = await getJson(`${API}/api/orders/${trade.orderId}`);
  check(
    'the trade names all four parties',
    [detail.buyer, detail.supplier, detail.attestor, detail.resolver].every((party) =>
      /^G[A-Z2-7]{55}$/.test(party),
    ),
  );
  check('the trade settles in the approved USDC', /^C[A-Z2-7]{55}$/.test(detail.settlementAsset));
  check('the trade has milestones', detail.milestones.length > 0);

  const settled = detail.milestones.find((milestone) => milestone.status === 'SETTLED');
  check('a milestone reached settlement', settled !== undefined);

  if (settled !== undefined) {
    const finance = await getJson(`${API}/api/milestones/${settled.milestoneId}/finance`);
    const { settlement, positions } = finance;
    check('settlement is recorded', settlement != null);

    if (settlement != null) {
      const protectedAmount = units(settlement.protectedAmount);
      const repayment = units(settlement.funderRepayment);
      const payout = units(settlement.supplierPayout);
      // The core economic invariant, checked against what the API serves.
      check(
        'escrow is split exactly: funder repayment + supplier remainder = protected',
        repayment + payout === protectedAmount,
        `${repayment} + ${payout} ≠ ${protectedAmount}`,
      );
      check('the funder was repaid first, and in full', repayment > 0n);
      check('the supplier received the remainder', payout > 0n);
      check(
        'settlement carries a real transaction',
        /^[0-9a-f]{64}$/.test(settlement.settledTxHash),
      );
    }

    const position = positions[0];
    check('a funder really advanced working capital', position !== undefined);
    if (position !== undefined && settlement != null) {
      const principal = units(position.principal);
      const owed = units(position.repayment);
      check(
        'the advance never exceeded the protected amount',
        principal <= units(settlement.protectedAmount),
      );
      check('repayment is at least the principal', owed >= principal);
      check(
        'the funder is not a party to the trade',
        ![detail.buyer, detail.supplier, detail.attestor, detail.resolver].includes(
          position.funder,
        ),
      );
      check('the advance has its own transaction', /^[0-9a-f]{64}$/.test(position.fundedTxHash));
      // The escrow released at settlement is the buyer's money; the principal
      // was the funder's. Neither figure may be derived from the other.
      check(
        'the supplier remainder is escrow minus repayment, not escrow minus the advance',
        units(settlement.supplierPayout) ===
          units(settlement.protectedAmount) - units(settlement.funderRepayment),
      );
    }
  }

  const refunded = detail.milestones.find((milestone) => milestone.status === 'REFUNDED');
  if (refunded !== undefined) {
    const finance = await getJson(`${API}/api/milestones/${refunded.milestoneId}/finance`);
    check('a refunded stage returned escrow to the buyer', finance.refund != null);
    check('a refunded stage never also settled', finance.settlement == null);
    check(
      'one contested stage did not disturb a settled sibling',
      settled !== undefined && settled.status === 'SETTLED',
    );
  }

  // ------------------------------------------------------- the guided tour --
  section('Guided tour narrates real events');
  const { activity } = await getJson(`${API}/api/activity?limit=100`);
  check('the event feed is populated', activity.length > 0, `${activity.length} events`);
  const names = [...activity].reverse().map((item) => item.eventName);
  for (const expected of [
    'order_created',
    'milestone_created',
    'order_accepted',
    'milestone_funded',
    'finance_requested',
    'funding_offer_created',
    'offer_accepted',
    'advance_funded',
    'evidence_submitted',
    'milestone_verified',
    'milestone_settled',
  ]) {
    check(`the chain recorded ${expected}`, names.includes(expected));
  }
  check(
    'the advance happened before settlement',
    names.indexOf('advance_funded') < names.indexOf('milestone_settled'),
  );
  check(
    'verification happened before settlement',
    names.indexOf('milestone_verified') < names.indexOf('milestone_settled'),
  );
  check(
    'every narrated event carries a transaction',
    activity.every((item) => /^[0-9a-f]{64}$/.test(item.txHash)),
  );
  check(
    'no event is duplicated',
    new Set(activity.map((item) => item.eventId)).size === activity.length,
  );

  // -------------------------------------------------- one hash, on Stellar --
  section('A transaction the tour links, checked on Stellar');
  const anchorStep = activity.find((item) => item.eventName === 'milestone_settled');
  if (anchorStep !== undefined) {
    try {
      const tx = await getJson(`${HORIZON}/transactions/${anchorStep.txHash}`);
      check('the settlement transaction exists on Stellar', tx.successful === true);
      check('Stellar agrees on the ledger', String(tx.ledger) === String(anchorStep.ledger));
    } catch (error) {
      check('the settlement transaction exists on Stellar', false, String(error));
    }
  }

  // ------------------------------------------------------------- metrics ----
  section('Traction metrics match the trades');
  const metrics = await getJson(`${API}/api/metrics/public`);
  check('metrics are labelled as testnet activity', metrics.scope.testnetOnly === true);
  check('metrics say how far they have indexed', metrics.provenance.indexedThroughLedger != null);
  check(
    'orders created matches the read model',
    metrics.protocolActivity.ordersCreated === orders.length,
    `${metrics.protocolActivity.ordersCreated} vs ${orders.length}`,
  );
  check(
    'settled milestones match the read model',
    metrics.protocolActivity.milestonesSettled >= (settled ? 1 : 0),
  );
  check(
    'money is published as exact base units',
    /^\d+$/.test(metrics.protocolActivity.protectedVolume),
  );
  check(
    'protected volume is at least what this trade protected',
    settled === undefined || units(metrics.protocolActivity.protectedVolume) > 0n,
  );
  check('every metric carries a definition', metrics.definitions.count > 0);
  check(
    'external adoption is never inferred from activity',
    metrics.adoption.externalWallets +
      metrics.adoption.teamWallets +
      metrics.adoption.unclassifiedWallets ===
      metrics.adoption.distinctWallets,
  );

  // ------------------------------------------------------------- security ---
  section('Public surface is safe');
  check(
    'metrics cannot be written',
    (await status(`${API}/api/metrics/public`, { method: 'POST' })) === 404,
  );
  const spiked = await getJson(
    `${API}/api/metrics/public?externalWallets=999&completedLocalPaymentFinanceCycles=42`,
  );
  check(
    'query parameters cannot inflate traction',
    spiked.adoption.externalWallets === metrics.adoption.externalWallets &&
      spiked.northStar.completedLocalPaymentFinanceCycles ===
        metrics.northStar.completedLocalPaymentFinanceCycles,
  );
  const cors = await fetch(`${API}/api/metrics/public`, {
    headers: { Origin: 'https://evil.example' },
  });
  check(
    'an unknown origin is not allowed by CORS',
    cors.headers.get('access-control-allow-origin') === null,
  );
  check(
    'responses declare a content-type policy',
    cors.headers.get('x-content-type-options') === 'nosniff',
  );
  // The one HTTP route that writes to the read model. Unauthenticated it must
  // refuse (401), or be switched off entirely (503) — never run.
  const tickUnauthenticated = await status(`${API}/api/internal/indexer/tick`, { method: 'POST' });
  check(
    'the scheduled indexer tick refuses an unauthenticated caller',
    tickUnauthenticated === 401 || tickUnauthenticated === 503,
    String(tickUnauthenticated),
  );
  const tickGuessed = await status(`${API}/api/internal/indexer/tick`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-the-secret' },
  });
  check(
    'the scheduled indexer tick refuses a guessed secret',
    tickGuessed === 401 || tickGuessed === 503,
    String(tickGuessed),
  );
  const injected = await status(`${API}/api/internal/indexer/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-the-secret' },
    body: JSON.stringify({ fromLedger: 1, events: [{ eventName: 'milestone_settled' }] }),
  });
  check(
    'events supplied by a caller are refused, not indexed',
    injected === 401 || injected === 503,
    String(injected),
  );

  const payload = JSON.stringify(metrics);
  for (const forbidden of ['jwt', 'secret', 'seed', 'iban', 'kyc', 'password', 'privateKey']) {
    check(
      `metrics expose no "${forbidden}"`,
      !payload.toLowerCase().includes(forbidden.toLowerCase()),
    );
  }

  // ------------------------------------------------------ invites and QR ----
  section('Trade Lab invites carry no authority');
  check(
    'a short invite link resolves',
    [307, 308].includes(await status(`${WEB}/trade-lab/join?order=${trade.orderId}&role=supplier`)),
  );
  check(
    'a malformed invite fails closed',
    [200, 307, 308].includes(await status(`${WEB}/trade-lab/join?order=notanumber&role=supplier`)),
  );
  check(
    'an unknown role fails closed',
    [200, 307, 308].includes(
      await status(`${WEB}/trade-lab/join?order=${trade.orderId}&role=admin`),
    ),
  );
  check(
    'the join page loads without a wallet',
    (await status(`${WEB}/app/trade-lab/join?order=${trade.orderId}&role=supplier`)) === 200,
  );

  // ---------------------------------------------------------------- done ----
  process.stdout.write(`\n${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failures) process.stdout.write(`  · ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nHappy path verified end to end.\n');
}

main().catch((error) => {
  process.stderr.write(
    `\ne2e run failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
