/**
 * @cloak.dev/perps/jupiter — venue adapter for Jupiter Perpetuals.
 *
 * Implements `PerpVenue` from `@cloak.dev/perps/core` with `execution: "async"`.
 */

export { JupiterVenue } from "./venue.js";
export type { JupiterVenueOptions } from "./venue.js";

export { fullPipeline } from "./full-pipeline.js";
export type {
  JupiterFullPipelineOptions,
  JupiterFullPipelineResult,
} from "./full-pipeline.js";

export { computeFreeCollateral } from "./free-collateral.js";
export type { FreeCollateralBreakdown } from "./free-collateral.js";

export {
  JLP_POOL,
  JUPITER_PERPETUALS_PROGRAM_ID,
  JUPITER_PERPETUALS_EVENT_AUTHORITY,
  DOVES_PROGRAM_ID,
  CUSTODIES,
  MINTS,
  POOL_CONFIG_SNAPSHOT,
} from "./constants.js";
export type { CustodySymbol, MarketBase } from "./constants.js";

export {
  encodePositionHandle,
  decodePositionHandle,
  encodeRequestHandle,
  decodeRequestHandle,
  isRequestHandle,
} from "./handle.js";

export {
  generatePositionPda,
  generatePositionRequestPda,
  perpetualsPda,
  resolveCustodies,
} from "./pdas.js";
