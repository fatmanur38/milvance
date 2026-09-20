import { LocalPaymentsPanel } from '@/components/anchor/local-payments-panel';

/**
 * PKG-07 standalone local-payments page, kept at its original URL. The same
 * panel is embedded in the workspace at /app/anchor.
 */
export default function AnchorPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <LocalPaymentsPanel />
    </main>
  );
}
