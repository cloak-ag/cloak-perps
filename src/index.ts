/**
 * @cloak.dev/perps — privacy-first perpetuals on Phoenix.
 *
 * Cloak Perp is built on top of Phoenix Eternal. The shielded-trader
 * flow (W → Cloak USDC pool → T → Phoenix → exit → X) lives in the
 * `/cloak` subpath; the Phoenix adapter lives in `/rise`. For
 * tree-shaking, prefer namespace imports over this barrel.
 */

// Core (venue interface, types, PhoenixTrader)
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
