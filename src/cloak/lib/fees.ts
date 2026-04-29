/** Cloak shield-pool on-chain fee schedule (matches transact.rs / swap.rs).
 *  Applies to every `Transact*` op (shield, unshield, swap, transfer). */
export const CLOAK_FIXED_FEE_LAMPORTS = 5_000_000;
export const CLOAK_VARIABLE_BPS = 30; // 0.3 %

/**
 * Gross up a post-fee amount so that, after Cloak's pool fee is applied,
 * exactly `post` is delivered. Used for both SOL and USDC legs (the rate
 * is denominated in the relevant base unit; the formula doesn't care).
 *
 *   post = pre - FIXED - pre * BPS / 10_000
 *   pre  = (post + FIXED) * 10_000 / (10_000 - BPS)
 */
export function preCloakFee(post: bigint): bigint {
  const num = (post + BigInt(CLOAK_FIXED_FEE_LAMPORTS)) * BigInt(10_000);
  return num / BigInt(10_000 - CLOAK_VARIABLE_BPS) + BigInt(1);
}
