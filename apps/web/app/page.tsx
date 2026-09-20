/**
 * Landing page: the product thesis, and the way into the workspace at /app.
 */
export default function HomePage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Milvance</h1>

      <p className="text-lg">Buyer funds the work, not the supplier.</p>

      <a
        className="w-fit rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background"
        href="/demo"
      >
        See a real trade, step by step →
      </a>
      <p className="-mt-3 text-xs opacity-70">
        No wallet needed. Every step links to the transaction on Stellar Testnet.
      </p>

      <p className="text-sm opacity-80">
        Milvance converts buyer-protected production milestones into financeable working capital and
        connects that capital to the local currency suppliers actually use.
      </p>

      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="font-medium">Buyer money</dt>
          <dd className="opacity-80">
            Protected milestone payment, locked in Soroban. Not supplier working capital.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Funder money</dt>
          <dd className="opacity-80">
            Separate capital advanced to the supplier now, repaid first on verification.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Anchor</dt>
          <dd className="opacity-80">
            The local-money edge: TRY in, TRY out, Stellar in between.{' '}
            <a className="underline" href="/app/anchor">
              Open local money
            </a>
            .
          </dd>
        </div>
      </dl>

      <a
        className="w-fit rounded-lg bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
        href="/app"
      >
        Open the workspace →
      </a>
    </main>
  );
}
