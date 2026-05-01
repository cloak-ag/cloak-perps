/**
 * Cloak privacy primitives — venue-agnostic funding boundary.
 *
 *   - fundTargetFromUsdc — Case A: W has USDC, no Jupiter swap.
 *   - fundTargetFromSol  — Case B: W has SOL, Cloak shielded-swaps to USDC.
 *   - reshieldUsdc       — re-shield USDC into the Cloak USDC pool after
 *                          the perp exit.
 *
 * Each is a typed async function. Browser-friendly: no Node-only imports
 * in this subpath. (`loadKeypair` for reading a keypair JSON from disk
 * lives in `@cloak.dev/perps/node`.)
 */

export { fundTargetFromUsdc } from "./fund-target-from-usdc.js";
export type {
  FundTargetFromUsdcOptions,
  FundTargetResult as FundTargetFromUsdcResult,
} from "./fund-target-from-usdc.js";

export { fundTargetFromSol } from "./fund-target-from-sol.js";
export type {
  FundTargetFromSolOptions,
  FundTargetResult as FundTargetFromSolResult,
} from "./fund-target-from-sol.js";

export { reshieldUsdc } from "./reshield-usdc.js";
export type {
  ReshieldUsdcOptions,
  ReshieldUsdcResult,
} from "./reshield-usdc.js";

export { exitUsdcToWallet } from "./exit-to-wallet.js";
export type {
  ExitUsdcToWalletOptions,
  ExitUsdcToWalletResult,
} from "./exit-to-wallet.js";

export { preCloakFee, CLOAK_FIXED_FEE_LAMPORTS, CLOAK_VARIABLE_BPS } from "./lib/fees.js";
export { quoteSolForUsdcOut } from "./lib/jupiter-quote.js";

// Signer abstraction — for wiring browser wallets (Phantom/Backpack/etc.)
export { isKeypair, signerPublicKey, toSdkSignerOptions } from "./lib/signer.js";
export type { Signer, WalletAdapterLike, SdkSignerOptions } from "./lib/signer.js";
