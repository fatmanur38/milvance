import { LocalPaymentsPanel } from '@/components/anchor/local-payments-panel';

/**
 * Local payments inside the workspace.
 *
 * "Convert to TRY" on a milestone links here with the advance pre-filled. The
 * query values are hints only: they are validated, and the person still reviews
 * the rate and signs every step in their wallet.
 */
export default async function WorkspaceAnchorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const direction = one(query.direction) === 'withdraw' ? 'withdraw' : 'deposit';
  const rawAmount = one(query.amount);
  const amount =
    rawAmount !== undefined && /^\d{1,12}(\.\d{1,7})?$/.test(rawAmount) ? rawAmount : undefined;
  const rawMilestone = one(query.milestone);
  const milestone =
    rawMilestone !== undefined && /^[1-9]\d{0,19}$/.test(rawMilestone) ? rawMilestone : undefined;

  return (
    <LocalPaymentsPanel
      initialDirection={direction}
      {...(amount !== undefined ? { initialAmount: amount } : {})}
      {...(milestone !== undefined
        ? { context: `Working capital received on milestone ${milestone}` }
        : {})}
    />
  );
}
