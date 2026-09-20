import { JoinView } from '@/components/demo/join-view';

/**
 * The page an invite link or a scanned QR code opens.
 *
 * Query parameters arrive as a Promise in Next.js 16. They are untrusted input
 * and are validated in `parseInvite`; nothing here grants any permission.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <JoinView params={params} />;
}
