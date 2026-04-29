/**
 * Anchor account decoders for Jupiter Perpetuals.
 *
 * We construct a single `BorshAccountsCoder` from the vendored IDL and
 * use it for all account decoding. Field shapes match
 * `idl/jupiter-perpetuals-idl.ts`.
 */

import { BorshAccountsCoder, BN } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

import { IDL } from "./idl/jupiter-perpetuals-idl.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const coder = new BorshAccountsCoder(IDL as any);

/** Raw decoded `Position` account (field shape from IDL). */
export interface RawPosition {
  owner: PublicKey;
  pool: PublicKey;
  custody: PublicKey;
  collateralCustody: PublicKey;
  openTime: BN;
  updateTime: BN;
  side: { none?: object } | { long?: object } | { short?: object };
  price: BN;
  sizeUsd: BN;
  collateralUsd: BN;
  realisedPnlUsd: BN;
  cumulativeInterestSnapshot: BN;
  lockedAmount: BN;
  bump: number;
}

export function decodePosition(data: Buffer | Uint8Array): RawPosition {
  return coder.decode("position", Buffer.from(data)) as RawPosition;
}

export function tryDecodePosition(data: Buffer | Uint8Array): RawPosition | null {
  try {
    return decodePosition(data);
  } catch {
    return null;
  }
}

/** True if the side enum encodes `long`. */
export function isLong(rawSide: RawPosition["side"]): boolean {
  return "long" in rawSide;
}
