/**
 * PDA derivations for Jupiter Perpetuals. Mirrors the seeds documented
 * in `julianfssen/jupiter-perps-anchor-idl-parsing/src/examples/
 * generate-position-and-position-request-pda.ts`.
 */

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import {
  CUSTODIES,
  JLP_POOL,
  JUPITER_PERPETUALS_PROGRAM_ID,
  type MarketBase,
} from "./constants.js";
import type { Side } from "../core/index.js";

const SIDE_BYTES = (side: Side): number => (side === "long" ? 1 : 2);

/**
 * Resolve the (custody, collateralCustody) pair for a given market+side.
 *
 * Long: collateral mint == base asset (SOL-Long uses SOL custody for
 *       both collateral and exposure).
 * Short: collateral mint == stable; default USDC. Pass `stableSide`
 *        to override to USDT.
 */
export function resolveCustodies(
  market: MarketBase,
  side: Side,
  stableSide: "USDC" | "USDT" = "USDC",
): { custody: PublicKey; collateralCustody: PublicKey } {
  const baseCustody = CUSTODIES[market];
  if (side === "long") {
    return { custody: baseCustody, collateralCustody: baseCustody };
  }
  return { custody: baseCustody, collateralCustody: CUSTODIES[stableSide] };
}

/** Position PDA. Seeds: ["position", trader, pool, custody, collateralCustody, side_byte]. */
export function generatePositionPda(opts: {
  trader: PublicKey;
  market: MarketBase;
  side: Side;
  stableSide?: "USDC" | "USDT";
}): { position: PublicKey; bump: number; custody: PublicKey; collateralCustody: PublicKey } {
  const { custody, collateralCustody } = resolveCustodies(
    opts.market,
    opts.side,
    opts.stableSide,
  );
  const [position, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      opts.trader.toBuffer(),
      JLP_POOL.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      Buffer.from([SIDE_BYTES(opts.side)]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );
  return { position, bump, custody, collateralCustody };
}

/**
 * PositionRequest PDA. Seeds:
 *   ["position_request", position, counter_le_u64, request_change_byte].
 *
 * `counter` randomizes the PDA so multiple in-flight requests on the
 * same Position don't collide. `requestChange` is 1 for increase, 2 for
 * decrease.
 */
export function generatePositionRequestPda(opts: {
  position: PublicKey;
  counter?: BN;
  requestChange: "increase" | "decrease";
}): { positionRequest: PublicKey; counter: BN; bump: number } {
  const counter = opts.counter ?? new BN(Math.floor(Math.random() * 1_000_000_000));
  const [positionRequest, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_request"),
      opts.position.toBuffer(),
      counter.toArrayLike(Buffer, "le", 8),
      Buffer.from([opts.requestChange === "increase" ? 1 : 2]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );
  return { positionRequest, counter, bump };
}

/** The program-wide `Perpetuals` PDA. Seeds: ["perpetuals"]. */
export function perpetualsPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("perpetuals")],
    JUPITER_PERPETUALS_PROGRAM_ID,
  )[0];
}
