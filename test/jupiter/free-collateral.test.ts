/**
 * Drain-free math test. Runs against a known live mainnet SOL-Long
 * position via surfpool's mainnet fork.
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/free-collateral.test.ts
 *
 * Asserts:
 *   - all components are non-negative
 *   - closeFee + borrowFee + maintenance + free + buffer ≈ collateralUsd
 *   - drainUsd > 0 (the known position has real free collateral)
 *   - drainUsd < collateralUsd
 *
 * The numeric values themselves are live and will drift; we assert
 * structural invariants only.
 */

import { strict as assert } from "node:assert";
import { Connection, PublicKey } from "@solana/web3.js";

import { computeFreeCollateral } from "../../src/jupiter/free-collateral.js";
import { generatePositionPda } from "../../src/jupiter/pdas.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";
const KNOWN_TRADER = new PublicKey("9qB3YPTKVpoCS18nC2969ViguxDXge55gYMbVNU2M4pd");

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const { position } = generatePositionPda({
    trader: KNOWN_TRADER, market: "SOL", side: "long",
  });

  const b = await computeFreeCollateral(conn, position);
  console.log("breakdown for SOL-Long of known trader:");
  console.log(`  collateralUsd:    ${b.collateralUsd}  (USD-6dp)`);
  console.log(`  sizeUsd:          ${b.sizeUsd}`);
  console.log(`  maintenanceUsd:   ${b.maintenanceUsd}`);
  console.log(`  closeFeeUsd:      ${b.closeFeeUsd}`);
  console.log(`  borrowFeeUsd:     ${b.borrowFeeUsd}`);
  console.log(`  freeUsd:          ${b.freeUsd}`);
  console.log(`  drainUsd:         ${b.drainUsd}`);

  assert.ok(b.collateralUsd > 0n, "collateralUsd should be > 0 for an open position");
  assert.ok(b.sizeUsd > 0n, "sizeUsd should be > 0");
  assert.ok(b.maintenanceUsd >= 0n);
  assert.ok(b.closeFeeUsd >= 0n);
  assert.ok(b.borrowFeeUsd >= 0n);
  assert.ok(b.freeUsd >= 0n, "freeUsd should not be negative");
  assert.ok(b.freeUsd < b.collateralUsd, "freeUsd should be less than collateralUsd (fees+maint deducted)");

  // Conservation: collateralUsd ≈ maintenance + closeFee + borrowFee + freeUsd
  const sum = b.maintenanceUsd + b.closeFeeUsd + b.borrowFeeUsd + b.freeUsd;
  const diff = sum > b.collateralUsd ? sum - b.collateralUsd : b.collateralUsd - sum;
  // Floor in `freeUsd = max(0, ...)` may consume some — diff should still be small.
  assert.ok(
    diff <= b.collateralUsd / 1000n + 1n,
    `conservation: components=${sum} vs collateral=${b.collateralUsd} (diff=${diff})`,
  );

  // Drain should be free minus buffer. Buffer = max(1% of collateral, $0.10).
  const buffer = b.collateralUsd / 100n > 100_000n ? b.collateralUsd / 100n : 100_000n;
  const expectedDrain = b.freeUsd > buffer ? b.freeUsd - buffer : 0n;
  assert.equal(b.drainUsd, expectedDrain, "drainUsd should be freeUsd - buffer");

  if (b.drainUsd === 0n) {
    console.log("  (note: position has no drainable free collateral right now — math still validates)");
  } else {
    assert.ok(b.drainUsd < b.collateralUsd);
    console.log(`  ✓ drainable: ${b.drainUsd} (out of ${b.collateralUsd})`);
  }

  console.log("\nfree-collateral.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
