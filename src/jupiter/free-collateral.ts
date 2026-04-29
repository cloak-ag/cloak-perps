/**
 * Drain-free collateral computation for `withdrawCollateral(amount: null)`.
 *
 * Mirrors the formula in `julianfssen/jupiter-perps-anchor-idl-parsing/
 * src/examples/get-liquidation-price.ts` (Jupiter-endorsed reference).
 *
 *   priceImpactFeeBps = ceil(sizeUsd * BPS_POWER / tradeImpactFeeScalar)
 *   closeFeeUsd       = sizeUsd * (decreasePositionBps + priceImpactFeeBps) / BPS_POWER
 *   borrowFeeUsd      = (collateralCustody.cumulativeInterestRate
 *                        - position.cumulativeInterestSnapshot) * sizeUsd / RATE_POWER
 *   maintenanceUsd    = sizeUsd * BPS_POWER / pricing.maxLeverage
 *   freeUsd           = collateralUsd - maintenanceUsd - closeFeeUsd - borrowFeeUsd
 *   drainUsd          = max(0, freeUsd - safety_buffer)
 *
 * Safety buffer = max(1% of collateralUsd, $0.10) so a stale interest
 * snapshot or a tiny price tick can't tip the position into a forced
 * liquidation right after the withdraw confirms.
 */

import { BorshAccountsCoder, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

import { IDL } from "./idl/jupiter-perpetuals-idl.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const coder = new BorshAccountsCoder(IDL as any);

const BPS_POWER = new BN(10_000);
const RATE_POWER = new BN(1_000_000_000);

interface DecodedCustody {
  pricing: {
    tradeImpactFeeScalar: BN;
    maxLeverage: BN;
  };
  fundingRateState: {
    cumulativeInterestRate: BN;
  };
  decreasePositionBps: BN;
}

interface DecodedPosition {
  custody: PublicKey;
  collateralCustody: PublicKey;
  sizeUsd: BN;
  collateralUsd: BN;
  cumulativeInterestSnapshot: BN;
}

function divCeil(a: BN, b: BN): BN {
  const dm = a.divmod(b);
  if (dm.mod.isZero()) return dm.div;
  return dm.div.ltn(0) ? dm.div.isubn(1) : dm.div.iaddn(1);
}

function bnMax(a: BN, b: BN): BN {
  return a.gt(b) ? a : b;
}

export interface FreeCollateralBreakdown {
  collateralUsd: bigint;
  sizeUsd: bigint;
  closeFeeUsd: bigint;
  borrowFeeUsd: bigint;
  maintenanceUsd: bigint;
  freeUsd: bigint;
  /** Recommended drain amount = freeUsd minus safety buffer. */
  drainUsd: bigint;
}

/**
 * Read Position + (custody, collateralCustody) live and compute the
 * drain-free collateral breakdown. Returns all components so callers
 * can introspect (useful for tests).
 */
export async function computeFreeCollateral(
  connection: Connection,
  positionPda: PublicKey,
): Promise<FreeCollateralBreakdown> {
  const positionInfo = await connection.getAccountInfo(positionPda, "confirmed");
  if (!positionInfo) throw new Error(`position ${positionPda.toBase58()} not found`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pos = coder.decode("position", positionInfo.data) as any as DecodedPosition;

  const [custodyInfo, collCustodyInfo] = await connection.getMultipleAccountsInfo(
    [pos.custody, pos.collateralCustody],
    "confirmed",
  );
  if (!custodyInfo) throw new Error(`custody ${pos.custody.toBase58()} not found`);
  if (!collCustodyInfo) throw new Error(`collateralCustody ${pos.collateralCustody.toBase58()} not found`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const custody = coder.decode("custody", custodyInfo.data) as any as DecodedCustody;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collCustody = coder.decode("custody", collCustodyInfo.data) as any as DecodedCustody;

  const priceImpactFeeBps = pos.sizeUsd.isZero()
    ? new BN(0)
    : divCeil(pos.sizeUsd.mul(BPS_POWER), custody.pricing.tradeImpactFeeScalar);

  const closeFeeUsd = pos.sizeUsd
    .mul(custody.decreasePositionBps.add(priceImpactFeeBps))
    .div(BPS_POWER);

  const borrowFeeUsd = collCustody.fundingRateState.cumulativeInterestRate
    .sub(pos.cumulativeInterestSnapshot)
    .mul(pos.sizeUsd)
    .div(RATE_POWER);

  const maintenanceUsd = pos.sizeUsd.isZero()
    ? new BN(0)
    : pos.sizeUsd.mul(BPS_POWER).div(custody.pricing.maxLeverage);

  let freeUsd = pos.collateralUsd
    .sub(maintenanceUsd)
    .sub(closeFeeUsd)
    .sub(borrowFeeUsd);
  if (freeUsd.ltn(0)) freeUsd = new BN(0);

  // Safety buffer: max(1% of collateralUsd, $0.10) — $0.10 = 100_000 in USD-6dp.
  const buffer = bnMax(pos.collateralUsd.divn(100), new BN(100_000));
  let drainUsd = freeUsd.sub(buffer);
  if (drainUsd.ltn(0)) drainUsd = new BN(0);

  return {
    collateralUsd: BigInt(pos.collateralUsd.toString()),
    sizeUsd: BigInt(pos.sizeUsd.toString()),
    closeFeeUsd: BigInt(closeFeeUsd.toString()),
    borrowFeeUsd: BigInt(borrowFeeUsd.toString()),
    maintenanceUsd: BigInt(maintenanceUsd.toString()),
    freeUsd: BigInt(freeUsd.toString()),
    drainUsd: BigInt(drainUsd.toString()),
  };
}
