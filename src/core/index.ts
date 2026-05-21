/**
 * @cloak.dev/perps/core — venue interface, types, and the
 * `PhoenixTrader` that wraps Phoenix Eternal (`RiseVenue`) under
 * Cloak's shielded-trader (T) flow. `Aggregator` remains as a
 * deprecated alias.
 */

export type { PerpVenue } from "./venue.js";

export {
  PhoenixTrader,
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
