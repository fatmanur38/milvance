/**
 * @milvance/shared — framework-agnostic primitives.
 *
 * PKG-00 scope: identity and non-financial helpers only.
 * Domain types (Order, Milestone, FinancePosition, ...) are defined by the
 * Soroban contract in PKG-01 and mirrored here only once that surface is stable.
 */

export const MILVANCE_PROTOCOL_VERSION = 0 as const;

/**
 * Application roles as they appear in the product UI (AGENT.md §8).
 *
 * These are presentation/routing labels. Authorization is enforced on-chain by
 * `Address.require_auth()`, never by this union.
 */
export const APP_ROLES = ['buyer', 'supplier', 'funder', 'attestor', 'resolver'] as const;

export type AppRole = (typeof APP_ROLES)[number];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Nominal typing helper, so that an OrderId can never be passed where a
 * MilestoneId is expected once PKG-01 introduces those identifiers.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };
