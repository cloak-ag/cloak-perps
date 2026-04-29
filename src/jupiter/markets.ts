/**
 * The 9 markets a trader can open on JLP. Long uses same-asset
 * custody (SOL-Long ⇒ collateral=SOL), Short uses a stable as
 * collateral (USDC or USDT — both are supported by the program).
 */

import type { Side } from "../core/index.js";
import { CUSTODIES, type CustodySymbol, type MarketBase } from "./constants.js";
import type { PublicKey } from "@solana/web3.js";

export interface Market {
  base: MarketBase;
  side: Side;
  collateralSymbol: CustodySymbol;
  custody: PublicKey;
  collateralCustody: PublicKey;
}

export const MARKETS: readonly Market[] = (() => {
  const out: Market[] = [];
  for (const base of ["SOL", "ETH", "BTC"] as const) {
    out.push({
      base, side: "long", collateralSymbol: base,
      custody: CUSTODIES[base], collateralCustody: CUSTODIES[base],
    });
    for (const stable of ["USDC", "USDT"] as const) {
      out.push({
        base, side: "short", collateralSymbol: stable,
        custody: CUSTODIES[base], collateralCustody: CUSTODIES[stable],
      });
    }
  }
  return out;
})();

/** Resolve the canonical Market for a (base, side) pair. Defaults
 *  Short to USDC-collateralized; pass `stableSide` to pick USDT. */
export function findMarket(
  base: MarketBase,
  side: Side,
  stableSide: "USDC" | "USDT" = "USDC",
): Market {
  const collateralSymbol: CustodySymbol = side === "long" ? base : stableSide;
  const m = MARKETS.find(
    (x) => x.base === base && x.side === side && x.collateralSymbol === collateralSymbol,
  );
  if (!m) throw new Error(`no market: ${base}/${side}/${collateralSymbol}`);
  return m;
}
