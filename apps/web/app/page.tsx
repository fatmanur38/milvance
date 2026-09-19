/**
 * PKG-00 placeholder landing page.
 *
 * The real product surface (buyer / supplier / funder / attestor flows under
 * `/app/*`) is built in PKG-09. This page exists so the web skeleton builds and
 * renders, and so the repository states the product thesis from day one.
 */
export default function HomePage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Milvance</h1>

      <p className="text-lg">Buyer funds the work, not the supplier.</p>

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
          <dd className="opacity-80">The local-money edge: TRY in, TRY out, Stellar in between.</dd>
        </div>
      </dl>

      <a className="text-sm underline" href="/wallet">
        Connect a Testnet wallet →
      </a>
    </main>
  );
}
