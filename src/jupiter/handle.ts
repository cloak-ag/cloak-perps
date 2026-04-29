/**
 * Position handle encoding for Jupiter venue.
 *
 * Format: `jupiter/<marketBase>/<side>` where `marketBase` is the asset
 * (SOL, ETH, BTC) and `side` is `long` or `short`. Example: `jupiter/SOL/long`.
 *
 * On Jupiter, each `(trader, custody, collateralCustody, side)` tuple
 * has exactly one Position PDA, and the trader can have at most 9
 * concurrent positions (3 base assets × 3 collateral choices, with
 * Long always using same-asset custody and Short using USDC or USDT).
 *
 * For our handle we only encode `(market, side)` because:
 *   - For Long, collateralCustody = same as custody (always).
 *   - For Short, collateralCustody is USDC by default; if the user
 *     wants USDT collateral, it's a separate handle (we'll extend the
 *     handle format to `jupiter/SOL/short/USDT` if/when we support it).
 *
 * RequestHandle (returned by openPosition for the async settlement
 * polling) extends this with the request counter:
 * `jupiter/<marketBase>/<side>:<counter>`.
 */

import type { Side } from "../core/index.js";
import type { MarketBase } from "./constants.js";

const VENUE = "jupiter";
const VALID_BASES: readonly string[] = ["SOL", "ETH", "BTC"];

export function encodePositionHandle(market: MarketBase, side: Side): string {
  return `${VENUE}/${market}/${side}`;
}

export function decodePositionHandle(h: string): { market: MarketBase; side: Side } {
  const m = h.match(/^jupiter\/(SOL|ETH|BTC)\/(long|short)$/);
  if (!m) throw new Error(`invalid jupiter position handle: ${h}`);
  return { market: m[1] as MarketBase, side: m[2] as Side };
}

export function encodeRequestHandle(
  market: MarketBase,
  side: Side,
  counter: bigint,
): string {
  return `${encodePositionHandle(market, side)}:${counter.toString()}`;
}

export function decodeRequestHandle(h: string): {
  market: MarketBase;
  side: Side;
  counter: bigint;
} {
  const m = h.match(/^jupiter\/(SOL|ETH|BTC)\/(long|short):(\d+)$/);
  if (!m) throw new Error(`invalid jupiter request handle: ${h}`);
  return {
    market: m[1] as MarketBase,
    side: m[2] as Side,
    counter: BigInt(m[3]),
  };
}

/** True if `h` is a request handle (encodes a counter), false if it's
 *  a plain position handle. Used by `awaitSettlement` to decide whether
 *  it has enough info to poll. */
export function isRequestHandle(h: string): boolean {
  return /^jupiter\/(SOL|ETH|BTC)\/(long|short):\d+$/.test(h);
}

void VALID_BASES; // exported via type system
