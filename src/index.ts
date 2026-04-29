/**
 * @cloak.dev/perps — privacy-first perpetuals integration kit.
 *
 * Single-package re-export. For tree-shaking, prefer the namespace
 * sub-paths (`@cloak.dev/perps/core`, `/cloak`, `/rise`, `/jupiter`,
 * `/node`).
 */

// Core (venue-agnostic types + interface)
export * from "./core/index.js";

// Cloak privacy primitives
export * from "./cloak/index.js";

// Phoenix Eternal adapter (Rise)
export {
  RiseVenue,
  type RiseVenueOptions,
  phoenixLifecycle,
  type PhoenixLifecycleOptions,
  type PhoenixLifecycleResult,
  fullPipeline as risePipeline,
  type FullPipelineOptions as RisePipelineOptions,
  type FullPipelineResult as RisePipelineResult,
  registerFlightBuilder,
  placeFlightWrappedOrder,
  bundlePhoenixEntry,
  bundlePhoenixExit,
  type BundlePhoenixEntryOptions,
  type BundlePhoenixExitOptions,
  type JitoBundleResult,
  JITO_BLOCK_ENGINE_DEFAULT,
  JITO_TIP_ACCOUNTS,
  buildJitoTipIx,
  pickRandomJitoTipAccount,
  sendJitoBundle,
  waitForJitoBundle,
  sendIxs,
  web3KeypairToKitSigner,
} from "./rise/index.js";

// Jupiter Perpetuals adapter
export {
  JupiterVenue,
  type JupiterVenueOptions,
  fullPipeline as jupiterPipeline,
  type JupiterFullPipelineOptions,
  type JupiterFullPipelineResult,
  computeFreeCollateral,
  type FreeCollateralBreakdown,
  // namespaced constants live on the `/jupiter` subpath; not re-exported
  // at top level to avoid name clashes with rise's same-named primitives.
} from "./jupiter/index.js";
