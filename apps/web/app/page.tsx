import { testnetDeployment } from '@/lib/wallet/config';

/**
 * Landing page: the product thesis, and the way into the workspace at /app.
 *
 * The page has one job a slide cannot do — prove the thing is real — so every
 * claim on it is checkable. The contract id links to a public explorer, the
 * numbers are the deployment's own, and the only unqualified statement about
 * money is the one the contract enforces.
 */
const EXPLORER = `https://stellar.expert/explorer/testnet/contract/${testnetDeployment.contractId}`;

/** The two pools, stated the way the contract keeps them. */
const POOLS = [
  {
    label: "Buyer's protected payment",
    tone: 'protected',
    body: 'Committed to the milestone and held by the contract. Visible to everyone, spendable by nobody — until an attestor the buyer and supplier both named verifies the work.',
    foot: 'Never reaches the supplier early.',
  },
  {
    label: "Funder's own capital",
    tone: 'capital',
    body: 'A separate advance, paid to the supplier immediately so production can start. It is the funder’s money at risk, not the buyer’s.',
    foot: 'Repaid first, out of escrow, on verification.',
  },
] as const;

const STEPS = [
  ['Buyer protects a milestone', 'Money goes to the contract, not to the supplier.'],
  ['Funder advances working capital', 'Against a milestone that is already protected.'],
  ['Attestor verifies the work', 'A named human decides; the chain records it.'],
  ['The contract settles, atomically', 'Funder repaid first, remainder to the supplier.'],
] as const;

export default function HomePage(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <span className="text-lg font-semibold tracking-tight">Milvance</span>
          <div className="flex items-center gap-4 text-sm">
            <a
              className="hidden text-muted transition hover:text-foreground sm:inline"
              href="/demo"
            >
              Guided tour
            </a>
            <a
              className="rounded-lg border border-border bg-surface px-3.5 py-2 font-medium shadow-card transition hover:border-border-strong"
              href="/app"
            >
              Open workspace
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* ------------------------------------------------------------ hero */}
        <section className="mx-auto max-w-5xl px-6 pt-16 pb-14 sm:pt-24">
          <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-capital" />
            Live on Stellar Testnet
          </p>

          <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
            The buyer funds the work.
            <span className="block text-muted">Not the supplier.</span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg text-muted sm:text-xl">
            Milvance turns a buyer-protected production milestone into working capital a supplier
            can actually spend — in Turkish lira, before the goods exist.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-medium text-accent-foreground shadow-raised transition hover:opacity-90"
              href="/demo"
            >
              Watch a real trade
              <span aria-hidden>→</span>
            </a>
            <a
              className="rounded-lg border border-border bg-surface px-5 py-3 text-sm font-medium shadow-card transition hover:border-border-strong"
              href="/app"
            >
              Open the workspace
            </a>
          </div>
          <p className="mt-3 text-sm text-muted">
            No wallet needed for the tour. Every step links to its transaction on Stellar.
          </p>
        </section>

        {/* ------------------------------------------------- the two pools */}
        <section className="border-y border-border bg-background-deep py-14">
          <div className="mx-auto max-w-5xl px-6">
            <h2 className="text-sm font-medium tracking-wide text-muted uppercase">
              Two kinds of money, never mixed
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {POOLS.map((pool) => (
                <article
                  key={pool.label}
                  className="rounded-xl border border-border bg-surface p-6 shadow-card"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className={
                        pool.tone === 'protected'
                          ? 'h-2.5 w-2.5 rounded-full bg-protected'
                          : 'h-2.5 w-2.5 rounded-full bg-capital'
                      }
                    />
                    <h3 className="font-semibold">{pool.label}</h3>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-muted">{pool.body}</p>
                  <p
                    className={
                      pool.tone === 'protected'
                        ? 'mt-4 rounded-lg bg-protected-soft px-3 py-2 text-xs font-medium text-protected'
                        : 'mt-4 rounded-lg bg-capital-soft px-3 py-2 text-xs font-medium text-capital'
                    }
                  >
                    {pool.foot}
                  </p>
                </article>
              ))}
            </div>
            <p className="mt-5 max-w-2xl text-sm text-muted">
              If those two ever blurred, the buyer would be prepaying after all — just with extra
              steps. The contract keeps them apart, and so does every screen here.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------- how it works */}
        <section className="mx-auto max-w-5xl px-6 py-14">
          <h2 className="text-sm font-medium tracking-wide text-muted uppercase">
            How one milestone runs
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map(([title, detail], index) => (
              <li
                key={title}
                className="rounded-xl border border-border bg-surface p-5 shadow-card"
              >
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-background text-xs font-semibold text-muted">
                  {index + 1}
                </span>
                <h3 className="mt-3.5 text-sm font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{detail}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* -------------------------------------------- local money edge */}
        <section className="border-t border-border bg-background-deep py-14">
          <div className="mx-auto grid max-w-5xl gap-8 px-6 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                A supplier paid in USDC has not been paid
              </h2>
              <p className="mt-4 text-muted">
                Dye houses, landlords and workers are paid in lira. Stellar Anchors are the reason
                this is a product for a factory in Bursa rather than a demo for people who already
                hold crypto.
              </p>
              <a
                className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-protected hover:underline"
                href="/app/anchor"
              >
                Open local payments
                <span aria-hidden>→</span>
              </a>
            </div>
            <div className="rounded-xl border border-border bg-surface p-6 shadow-card">
              <ol className="flex flex-col gap-3 text-sm">
                {[
                  ['Local capital', 'TRY'],
                  ['Anchor', 'on-ramp'],
                  ['Milvance financing', 'USDC'],
                  ['Anchor', 'off-ramp'],
                  ['Materials, wages, energy', 'TRY'],
                ].map(([stage, note], index, all) => (
                  <li key={stage} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className={
                        index === 0 || index === all.length - 1
                          ? 'h-2 w-2 shrink-0 rounded-full bg-capital'
                          : 'h-2 w-2 shrink-0 rounded-full bg-border-strong'
                      }
                    />
                    <span className="font-medium">{stage}</span>
                    <span className="ml-auto font-mono text-xs text-muted">{note}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- proof */}
        <section className="mx-auto max-w-5xl px-6 py-14">
          <div className="rounded-xl border border-border bg-surface p-6 shadow-card sm:p-8">
            <h2 className="text-sm font-medium tracking-wide text-muted uppercase">
              Check it yourself
            </h2>
            <dl className="mt-5 grid gap-6 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-muted">Contract</dt>
                <dd className="mt-1">
                  <a
                    className="font-mono text-xs break-all text-protected hover:underline"
                    href={EXPLORER}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {testnetDeployment.contractId}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted">Deployed in ledger</dt>
                <dd className="mt-1 font-mono text-sm">{testnetDeployment.deploymentLedger}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted">Backend signing keys</dt>
                <dd className="mt-1 text-sm font-medium">
                  None. You sign every action in your own wallet.
                </dd>
              </div>
            </dl>
            <p className="mt-6 border-t border-border pt-5 text-sm text-muted">
              Testnet, so no real money moves. Milvance does not verify the physical world: a named
              attestor decides whether the work was done, and the chain records that decision.{' '}
              <a className="text-protected hover:underline" href="/app/metrics">
                See what we do and do not count
              </a>
              .
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-6 text-center text-xs text-muted">
        Soroban holds the money and enforces the rules. This app only reads it and asks your wallet
        to sign.
      </footer>
    </div>
  );
}
