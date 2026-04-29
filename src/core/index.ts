/**
 * @cloak.dev/perps/core — venue-agnostic interface, types, and the
 * Aggregator that routes intents across registered venues.
 */

export type { PerpVenue } from "./venue.js";

export {
  Aggregator,
  chooseVenue,
  defaultVenueScore,
} from "./aggregator.js";
export type {
  TradeIntent,
  VenueScoreFn,
  VenueSelection,
  OpenMultiOutcome,
} from "./aggregator.js";
export type {
  ClosePositionParams,
  CollateralMint,
  DepositCollateralParams,
  ExecutionMode,
  MarketId,
  OpenPositionParams,
  OrderType,
  PositionState,
  Side,
  VenueCapabilities,
  VenueOpResult,
  WithdrawCollateralParams,
} from "./types.js";
