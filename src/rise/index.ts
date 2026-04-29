/**
 * cloak-perps · rise — TypeScript integration of Cloak's privacy boundary
 * with Phoenix perpetuals via Ellipsis Labs' `@ellipsis-labs/rise` SDK.
 *
 * Two layers:
 *   - phoenixLifecycle — Phoenix-only (Ember+Deposit → place → cancel →
 *                       Withdraw+Ember-w) on a wallet that already holds
 *                       SOL + USDC.
 *   - fullPipeline     — composes Cloak fund (Case A or B) + phoenixLifecycle
 *                       + Cloak re-shield. The end-to-end story.
 */

export { phoenixLifecycle } from "./phoenix-lifecycle.js";
export type {
  PhoenixLifecycleOptions,
  PhoenixLifecycleResult,
} from "./phoenix-lifecycle.js";

export { fullPipeline } from "./full-pipeline.js";
export type { FullPipelineOptions, FullPipelineResult } from "./full-pipeline.js";

// Re-export the cloak primitives for convenience so consumers can pick
// just `@cloak.dev/perps/rise` and get the Cloak boundary transitively.
// `loadKeypair` is Node-only and lives at `@cloak.dev/perps/node`.
export {
  fundTargetFromUsdc,
  fundTargetFromSol,
  reshieldUsdc,
  preCloakFee,
} from "../cloak/index.js";
export type {
  FundTargetFromUsdcOptions,
  FundTargetFromUsdcResult,
  FundTargetFromSolOptions,
  FundTargetFromSolResult,
  ReshieldUsdcOptions,
  ReshieldUsdcResult,
} from "../cloak/index.js";

export { sendIxs } from "./lib/kit-send.js";
export { web3KeypairToKitSigner } from "./lib/kit-signer.js";

export { registerFlightBuilder, placeFlightWrappedOrder } from "./flight.js";
export type {
  RegisterFlightBuilderOptions,
  PlaceFlightWrappedOrderOptions,
  PlaceFlightWrappedOrderResult,
} from "./flight.js";

export { bundlePhoenixEntry, bundlePhoenixExit } from "./jito-bundles.js";
export type {
  BundlePhoenixEntryOptions,
  BundlePhoenixExitOptions,
  JitoBundleResult,
} from "./jito-bundles.js";
export {
  JITO_BLOCK_ENGINE_DEFAULT,
  JITO_TIP_ACCOUNTS,
  buildJitoTipIx,
  pickRandomJitoTipAccount,
  sendJitoBundle,
  waitForJitoBundle,
} from "./lib/jito.js";

// Aggregator-shaped adapter (implements `PerpVenue` from @cloak.dev/perps/core).
export { RiseVenue } from "./venue.js";
export type { RiseVenueOptions } from "./venue.js";
