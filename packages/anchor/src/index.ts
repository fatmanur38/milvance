/**
 * @milvance/anchor — Stellar Anchor (SEP) adapter boundary.
 *
 * ⚠️ PKG-00 placeholder. Implemented in **PKG-07**.
 *
 * Design constraints fixed by AGENT.md §21 / §4.3, to be honoured when this
 * package is implemented:
 *
 * - Anchor is the local-money edge of the product (TRY ↔ USDC), not a decorative
 *   withdrawal button, and not an optional settings page.
 * - All Anchor access goes through a replaceable `AnchorProvider` interface so the
 *   hackathon mock can be swapped for a production Anchor without touching domain code.
 * - Mock bank-transfer behaviour lives in an isolated `MockAnchorDevDriver`, never
 *   inlined into domain logic.
 * - Relevant SEPs: SEP-1, SEP-10, SEP-12, SEP-38, SEP-6. Do not assume SEP-24.
 * - The SEP-10 challenge is signed by the *user's* wallet. JWTs are never logged,
 *   never committed, and never stored long-lived in plaintext.
 *
 * The `AnchorProvider` interface is deliberately NOT declared here: defining it is
 * part of PKG-07's approved scope.
 */

/** Marker export so the package has a stable, importable surface before PKG-07. */
export const ANCHOR_ADAPTER_IMPLEMENTED = false as const;
