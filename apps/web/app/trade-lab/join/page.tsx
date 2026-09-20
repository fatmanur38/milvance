import { redirect } from 'next/navigation';

import { INVITE_PATH, parseInvite } from '@/lib/demo/invite';

/**
 * Short invite link from AGENT.md §PKG-10 (`/trade-lab/join?order=42&role=supplier`).
 *
 * Kept because printed codes and shared links outlive route layouts. It only
 * forwards into the workspace, and only after the parameters have been
 * validated — a malformed link lands on the join page's own explanation rather
 * than being reflected onwards.
 */
export default async function ShortJoinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = parseInvite(await searchParams);
  if (!parsed.ok) redirect(INVITE_PATH);
  const { orderId, role, milestoneId, templateId } = parsed.invite;
  const query = new URLSearchParams({ order: orderId, role });
  if (milestoneId !== null) query.set('milestone', milestoneId);
  if (templateId !== null) query.set('template', templateId);
  redirect(`${INVITE_PATH}?${query.toString()}`);
}
