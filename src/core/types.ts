/**
 * Venue-agnostic types for the privacy-first perps aggregator.
 *
 * These types describe what every venue adapter must speak, not how
 * any individual venue (Phoenix orderbook, Jupiter Perps oracle/JLP,
 * Zeta CLOB, …) implements it under the hood.
 */

import type { PublicKey } from "@solana/web3.js";

/** Long or short. */
export type Side = "long" | "short";

/** Order type. Venues that only support one type (e.g. Jupiter Perps =
 *  market-only with priceSlippage) reject `"limit"` at adapter level. */
export type OrderType = "market" | "limit";

/**
 * Whether the venue settles a trade atomically (single tx, immediate
 * fill confirmation) or asynchronously (request → keeper executes →
 * outcome polled). Callers can branch on this to surface UX accordingly
 * — there's no honest way to hide the difference from the user, since
 * async venues can stall or be rejected.
 */
export type ExecutionMode = "atomic" | "async";

/** A market identifier on a given venue. Opaque to the aggregator;
 *  the adapter knows how to translate it (e.g. "SOL-PERP" → Phoenix
 *  symbol vs. Jupiter Perps custody pubkey). */
export type MarketId = string;

/** Mint of the asset T uses as collateral on this venue. */
export type CollateralMint = PublicKey;

export interface VenueCapabilities {
  /** Identifier ("rise" | "jupiter" | "zeta" | …). */
  readonly id: string;
  /** Human-readable name for UI. */
  readonly name: string;
  /** Supported order types. */
  readonly orderTypes: readonly OrderType[];
  /** Atomic vs async settlement. Drives the lifecycle UX. */
  readonly execution: ExecutionMode;
  /** Whether the venue requires the trader to be pre-registered /
   *  allowlisted (e.g. Phoenix invite gate). */
  readonly traderRegistrationRequired: boolean;
  /** Mints accepted as collateral. */
  readonly collateralMints: readonly CollateralMint[];
}

export interface OpenPositionParams {
  market: MarketId;
  side: Side;
  /** Notional size in base units (venue-specific; e.g. SOL for SOL-PERP). */
  size: string;
  /** Collateral to post in this op, in collateral-mint base units. For
   *  oracle/JLP venues, leverage = size × markPrice / collateral; for
   *  orderbook cross-margin venues, this is the deposit amount. Pass 0n
   *  to open against pre-existing collateral (after `depositCollateral`). */
  collateral: bigint;
  /** Collateral mint to post (must be in `capabilities.collateralMints`). */
  collateralMint: CollateralMint;
  /** Limit price in USD; required when orderType=="limit". */
  priceUsd?: number;
  /** Slippage tolerance in basis points (market orders). */
  slippageBps?: number;
  orderType: OrderType;
  /** Only allowed to reduce / close existing position; never increase. */
  reduceOnly?: boolean;
  /** Post-only — order rejected if it would cross the book.
   *  Limit-only; ignored for market orders. */
  postOnly?: boolean;
  /** Optional take-profit trigger price (USD). Submitted as a
   *  conditional attached to the position. */
  takeProfitPrice?: number;
  /** Optional stop-loss trigger price (USD). Submitted as a
   *  conditional attached to the position. */
  stopLossPrice?: number;
}

export interface ClosePositionParams {
  /** Handle returned by `openPosition`. */
  positionHandle: string;
  /** Optional partial close. If omitted, closes fully. Does NOT withdraw
   *  collateral — call `withdrawCollateral` separately to do that. */
  fraction?: number;
  slippageBps?: number;
}

export interface DepositCollateralParams {
  market: MarketId;
  /** Amount to deposit in collateral-mint base units. */
  amount: bigint;
  collateralMint: CollateralMint;
}

export interface WithdrawCollateralParams {
  market: MarketId;
  /** Amount to withdraw in collateral-mint base units. Pass `null` to
   *  withdraw the entire free (non-locked) balance. */
  amount: bigint | null;
  collateralMint: CollateralMint;
}

export interface PositionState {
  handle: string;
  market: MarketId;
  side: Side;
  /** Signed base-unit size as string. Negative for shorts. */
  size: string;
  /** Absolute size in base units (e.g. SOL) as a number, convenience. */
  sizeBase?: number;
  collateral: bigint;
  collateralMint: CollateralMint;
  /** Unrealized PnL in collateral mint base units. May be approximate
   *  on oracle venues if the mark moved between read and quote. */
  unrealizedPnl: bigint;
  /** Unrealized PnL in USDC as a decimal number, convenience. */
  upnlUsd?: number;
  /** Entry price in USD, if the venue exposes one. */
  entryPriceUsd?: number;
  /** Liquidation price in USD, if the venue exposes one. */
  liquidationPriceUsd?: number;
  /** Computed leverage (sizeNotional / collateralUsd) if both known. */
  leverage?: number;
  /** Funding paid/earned since open, in collateral mint base units. */
  funding: bigint;
  /** Configured take-profit triggers attached to this position. */
  takeProfitTriggers?: Array<{ id: string; triggerPriceUsd: number; executionPriceUsd?: number }>;
  /** Configured stop-loss triggers attached to this position. */
  stopLossTriggers?: Array<{ id: string; triggerPriceUsd: number; executionPriceUsd?: number }>;
}

/** Result of an async lifecycle operation. For atomic venues, `status`
 *  is always `"confirmed"` and `signatures` contains the single tx;
 *  for async venues, `status` may be `"pending"` until the keeper
 *  executes — pollable via `awaitSettlement`. */
export interface VenueOpResult {
  status: "confirmed" | "pending" | "failed" | "refunded";
  signatures: string[];
  /** Adapter-specific request handle for polling (async venues). */
  requestHandle?: string;
  /** When status==="failed" or "refunded": reason. */
  reason?: string;
}
