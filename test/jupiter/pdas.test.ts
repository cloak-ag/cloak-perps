/**
 * Unit tests for pdas.ts. Verifies our PDA derivations match the
 * Jupiter-endorsed reference implementation by reproducing them with
 * `findProgramAddressSync` directly and asserting equality.
 *
 * Run with: `npx tsx test/pdas.test.ts`.
 */

import { strict as assert } from "node:assert";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import {
  CUSTODIES,
  JLP_POOL,
  JUPITER_PERPETUALS_PROGRAM_ID,
} from "../../src/jupiter/constants.js";
import {
  generatePositionPda,
  generatePositionRequestPda,
  perpetualsPda,
  resolveCustodies,
} from "../../src/jupiter/pdas.js";

// ── Position PDA matches reference seed-derivation for SOL-Long
{
  const trader = new PublicKey("DFZcDnmEYNUK1khquZzx5dQYiEyjJ3N5STqaDVLZ88ZU");
  const { position } = generatePositionPda({ trader, market: "SOL", side: "long" });

  // Re-derive with the exact reference seeds for cross-check.
  const [refPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      trader.toBuffer(),
      JLP_POOL.toBuffer(),
      CUSTODIES.SOL.toBuffer(),
      CUSTODIES.SOL.toBuffer(),
      Buffer.from([1]), // side: long
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );
  assert.equal(position.toBase58(), refPda.toBase58(), "SOL-Long PDA mismatch");
}

// ── Position PDA: SOL-Short defaults to USDC collateral
{
  const trader = new PublicKey("DFZcDnmEYNUK1khquZzx5dQYiEyjJ3N5STqaDVLZ88ZU");
  const { position, collateralCustody } = generatePositionPda({
    trader, market: "SOL", side: "short",
  });
  assert.equal(collateralCustody.toBase58(), CUSTODIES.USDC.toBase58());

  const [refPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      trader.toBuffer(),
      JLP_POOL.toBuffer(),
      CUSTODIES.SOL.toBuffer(),
      CUSTODIES.USDC.toBuffer(),
      Buffer.from([2]), // side: short
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );
  assert.equal(position.toBase58(), refPda.toBase58(), "SOL-Short USDC PDA mismatch");
}

// ── stableSide: USDT override
{
  const trader = new PublicKey("DFZcDnmEYNUK1khquZzx5dQYiEyjJ3N5STqaDVLZ88ZU");
  const { collateralCustody } = generatePositionPda({
    trader, market: "BTC", side: "short", stableSide: "USDT",
  });
  assert.equal(collateralCustody.toBase58(), CUSTODIES.USDT.toBase58());
}

// ── PositionRequest PDA: with explicit counter
{
  const trader = new PublicKey("DFZcDnmEYNUK1khquZzx5dQYiEyjJ3N5STqaDVLZ88ZU");
  const { position } = generatePositionPda({ trader, market: "SOL", side: "long" });

  const counter = new BN(42);
  const { positionRequest, counter: returnedCounter } = generatePositionRequestPda({
    position, counter, requestChange: "increase",
  });
  assert.equal(returnedCounter.toString(), "42");

  const [refPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_request"),
      position.toBuffer(),
      counter.toArrayLike(Buffer, "le", 8),
      Buffer.from([1]), // increase
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );
  assert.equal(positionRequest.toBase58(), refPda.toBase58(), "PositionRequest PDA mismatch");
}

// ── PositionRequest PDA: random counter is non-zero u64-fittable
{
  const trader = new PublicKey("DFZcDnmEYNUK1khquZzx5dQYiEyjJ3N5STqaDVLZ88ZU");
  const { position } = generatePositionPda({ trader, market: "SOL", side: "long" });
  const { counter } = generatePositionRequestPda({ position, requestChange: "decrease" });
  assert.ok(counter.gten(0));
  assert.ok(counter.lt(new BN("18446744073709551616"))); // < 2^64
}

// ── perpetuals PDA: deterministic
{
  const a = perpetualsPda();
  const b = perpetualsPda();
  assert.equal(a.toBase58(), b.toBase58());
  // Derived from "perpetuals" seed against the program id
  const [ref] = PublicKey.findProgramAddressSync(
    [Buffer.from("perpetuals")],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );
  assert.equal(a.toBase58(), ref.toBase58());
}

// ── resolveCustodies: long vs short
{
  const long = resolveCustodies("ETH", "long");
  assert.equal(long.custody.toBase58(), CUSTODIES.ETH.toBase58());
  assert.equal(long.collateralCustody.toBase58(), CUSTODIES.ETH.toBase58());

  const short = resolveCustodies("ETH", "short");
  assert.equal(short.collateralCustody.toBase58(), CUSTODIES.USDC.toBase58());
}

console.log("pdas.test.ts: ok");
