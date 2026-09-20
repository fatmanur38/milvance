import type { OrderParties } from '../domain/roles';
import { templateById } from './templates';

/**
 * Invite links: navigation and context, never authorization.
 *
 * An invite tells someone WHICH trade to look at and WHAT ROLE they are
 * expected to hold. It cannot grant that role. The role a wallet actually has
 * comes from the addresses MilvanceCore stores on the order, and every action
 * is re-checked by the contract when it is signed. `?role=attestor` changes the
 * words on the page and nothing else.
 *
 * Everything here treats its input as hostile: ids must be plain positive
 * integers within u64, roles must be one of five known words, and unknown
 * parameters are dropped rather than carried along.
 */

export const INVITE_PATH = '/app/trade-lab/join';

const INVITE_ROLES = ['supplier', 'attestor', 'resolver', 'funder', 'buyer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/** u64 ids, as the contract issues them: no leading zeros, no sign, no decimals. */
const CHAIN_ID = /^[1-9]\d{0,19}$/;
const U64_MAX = 18_446_744_073_709_551_615n;

export interface Invite {
  readonly orderId: string;
  /** A hint for wording only. Never grants anything. */
  readonly role: InviteRole;
  /** Optional milestone to open, e.g. a funding opportunity. */
  readonly milestoneId: string | null;
  /** Optional template id, for the explanatory copy. */
  readonly templateId: string | null;
}

export interface InviteInput {
  readonly orderId: string;
  readonly role: InviteRole;
  readonly milestoneId?: string | null;
  readonly templateId?: string | null;
}

function isChainId(value: string): boolean {
  return CHAIN_ID.test(value) && BigInt(value) <= U64_MAX;
}

function isInviteRole(value: string): value is InviteRole {
  return (INVITE_ROLES as readonly string[]).includes(value);
}

/** The query string for an invite. Only known keys, always in a fixed order. */
export function inviteQuery(input: InviteInput): string {
  if (!isChainId(input.orderId)) throw new Error('Invite needs a valid order id.');
  const params = new URLSearchParams();
  params.set('order', input.orderId);
  params.set('role', input.role);
  if (input.milestoneId != null && isChainId(input.milestoneId)) {
    params.set('milestone', input.milestoneId);
  }
  if (input.templateId != null && templateById(input.templateId) !== null) {
    params.set('template', input.templateId);
  }
  return params.toString();
}

/** A relative invite path — what the app links to internally. */
export function invitePath(input: InviteInput): string {
  return `${INVITE_PATH}?${inviteQuery(input)}`;
}

/**
 * The absolute link to share or encode as a QR code.
 *
 * `origin` comes from the browser it is generated in, so a link made on a
 * laptop on a conference network points at that same host. Only http(s)
 * origins are accepted, so a hostile origin cannot turn an invite into a
 * `javascript:` URL.
 */
export function inviteUrl(origin: string, input: InviteInput): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Invite needs a valid origin.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invite links must be http or https.');
  }
  return `${parsed.origin}${invitePath(input)}`;
}

/**
 * Hosts that only ever mean "this device".
 *
 * A link to one of these is correct in the browser that made it and useless
 * anywhere else: a phone resolving `localhost` reaches the phone. Trade Lab
 * says so next to the QR rather than letting someone discover it mid-demo.
 */
const DEVICE_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** Whether an origin can only be opened on the machine that produced it. */
export function isDeviceLocal(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return DEVICE_LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * The origin invite links and QR codes should point at.
 *
 * Normally the browser's own origin, which is right whenever the app is
 * reachable at the address the demo runner is using. When the app is served
 * somewhere attendees can reach but the browser cannot name — a tunnel, a
 * hostname on the venue network — `NEXT_PUBLIC_TRADE_LAB_ORIGIN` overrides it.
 *
 * A configured value that is not a plain http(s) origin is ignored rather than
 * thrown: a mistyped environment variable must not break a live demo, and
 * ignoring it falls back to the origin that is known to work.
 */
export function shareOrigin(configured: string | undefined, browser: string): string {
  if (configured === undefined || configured.trim() === '') return browser;
  try {
    const url = new URL(configured.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return browser;
    return url.origin;
  } catch {
    return browser;
  }
}

export type InviteParams =
  URLSearchParams | Record<string, string | string[] | undefined> | null | undefined;

function read(params: InviteParams, key: string): string | null {
  if (params == null) return null;
  const value = params instanceof URLSearchParams ? params.get(key) : params[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export type InviteParseResult =
  { readonly ok: true; readonly invite: Invite } | { readonly ok: false; readonly reason: string };

/**
 * Parses invite parameters, rejecting anything malformed.
 *
 * A rejected invite is a navigation failure, never a security one: the pages it
 * leads to derive their permissions from the connected wallet and the chain.
 */
export function parseInvite(params: InviteParams): InviteParseResult {
  const order = read(params, 'order');
  if (order === null || order === '') return { ok: false, reason: 'This link has no order.' };
  if (!isChainId(order)) return { ok: false, reason: 'This link has an invalid order id.' };

  const role = read(params, 'role');
  if (role === null || role === '') return { ok: false, reason: 'This link has no role.' };
  if (!isInviteRole(role)) return { ok: false, reason: 'This link names an unknown role.' };

  const milestone = read(params, 'milestone');
  if (milestone !== null && milestone !== '' && !isChainId(milestone)) {
    return { ok: false, reason: 'This link has an invalid milestone id.' };
  }

  const template = read(params, 'template');
  return {
    ok: true,
    invite: {
      orderId: order,
      role,
      milestoneId: milestone === null || milestone === '' ? null : milestone,
      // An unknown template id is ignored rather than fatal: it only picks copy.
      templateId: templateById(template)?.id ?? null,
    },
  };
}

/** Where an invite leads once someone wants the real workspace. */
export function inviteDestination(invite: Invite): string {
  if (invite.role === 'funder') {
    return invite.milestoneId === null
      ? '/app/funding'
      : `/app/orders/${invite.orderId}#milestone-${invite.milestoneId}`;
  }
  return invite.milestoneId === null
    ? `/app/orders/${invite.orderId}`
    : `/app/orders/${invite.orderId}#milestone-${invite.milestoneId}`;
}

/** What an invited person is being asked to do, in their own words. */
export const INVITE_ROLE_BRIEF: Record<InviteRole, string> = {
  buyer: 'You are the buyer: you protect each milestone payment before it is due.',
  supplier:
    'You are the supplier: you accept the order, do the work, and can raise working capital against a protected milestone.',
  attestor:
    'You are the attestor: you check the evidence against what was promised and record your verification on Stellar.',
  resolver:
    'You are the resolver: if the buyer and supplier disagree, you decide whether the protected payment is released or returned.',
  funder:
    'You are a funder: you can advance your own USDC to the supplier now and be repaid first out of the protected milestone when it is verified.',
};

/**
 * Which on-chain address an invited wallet is expected to be.
 *
 * `null` for a funder: the contract has no funder allowlist — `make_offer`
 * accepts any wallet that is not one of the four order parties.
 */
export function expectedAddressFor(role: InviteRole, order: OrderParties): string | null {
  return role === 'funder' ? null : order[role];
}
