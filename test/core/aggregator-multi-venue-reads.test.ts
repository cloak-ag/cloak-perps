/**
 * Multi-venue read fan-out against a known live mainnet trader via
 * surfpool's mainnet fork.
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/core/aggregator-multi-venue-reads.test.ts
 *
 * Scenario:
 *   Trader 9qB3YPT… holds a SOL-Long position on Jupiter Perpetuals
 *   (verified live). They have no Phoenix Eternal trader registered
 *   (typical — Phoenix's invite gate). The Aggregator should return
 *   exactly the Jupiter position, with the Rise venue gracefully
 *   returning empty rather than throwing.
 *
 * What this validates:
 *   - `Aggregator.listPositions` fans out across registered venues
 *     and concatenates results (with per-venue try/catch swallowing
 *     errors so one venue's failure doesn't blank the whole list).
 *   - `Aggregator.getPosition` routes by handle prefix (`jupiter/…`).
 */

import { strict as assert } from "node:assert";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { Aggregator } from "../../src/core/aggregator.js";
import { JupiterVenue } from "../../src/jupiter/venue.js";
import { RiseVenue } from "../../src/rise/venue.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";
const KNOWN_TRADER = "9qB3YPTKVpoCS18nC2969ViguxDXge55gYMbVNU2M4pd";

function fakeKeypair(addr: string): Keypair {
  const dummy = Keypair.generate();
  Object.defineProperty(dummy, "publicKey", { value: new PublicKey(addr) });
  return dummy;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const trader = fakeKeypair(KNOWN_TRADER);

  const aggregator = new Aggregator([
    new RiseVenue({ rpcUrl: RPC_URL }),
    new JupiterVenue({ rpcUrl: RPC_URL }),
  ]);

  console.log(`rpc=${RPC_URL}\ntrader=${KNOWN_TRADER}\n`);

  // listPositions: expect Jupiter SOL-Long + zero from Rise (no trader account)
  const positions = await aggregator.listPositions({ connection: conn, trader });
  console.log(`  listPositions → ${positions.length} position(s):`);
  for (const p of positions) {
    console.log(`     ${p.handle}  size=${p.size}  collateral=${p.collateral}`);
  }
  assert.ok(positions.length >= 1, "expected at least one Jupiter position");
  assert.ok(
    positions.some((p) => p.handle === "jupiter/SOL/long"),
    "Jupiter SOL-Long missing from merged list",
  );
  // No Phoenix position — Rise returned empty, didn't throw.
  assert.ok(
    !positions.some((p) => p.handle.startsWith("rise/")),
    "did not expect any Rise positions for this trader",
  );

  // getPosition: route Jupiter handle → Jupiter
  const jp = await aggregator.getPosition({
    connection: conn, trader, positionHandle: "jupiter/SOL/long",
  });
  assert.ok(jp !== null, "expected aggregator.getPosition('jupiter/SOL/long') non-null");
  assert.equal(jp.handle, "jupiter/SOL/long");
  console.log(`  ✓ getPosition('jupiter/SOL/long') → size=${jp.size}`);

  // getPosition: nonsense handle → null (no venue prefix match)
  const miss = await aggregator.getPosition({
    connection: conn, trader, positionHandle: "unknown/foo/bar",
  });
  assert.equal(miss, null);
  console.log("  ✓ getPosition('unknown/…') → null");

  // getPosition: Rise handle for a non-Phoenix-registered trader →
  // adapter likely throws (no trader state). Aggregator does NOT
  // catch in getPosition — it surfaces the error. We validate this
  // by checking the rejection rather than the value.
  let riseGetThrew = false;
  try {
    await aggregator.getPosition({
      connection: conn, trader, positionHandle: "rise/SOL/long",
    });
  } catch {
    riseGetThrew = true;
  }
  assert.ok(
    riseGetThrew,
    "expected Rise getPosition to throw for an unregistered trader (no listPositions try/catch on this path)",
  );
  console.log("  ✓ getPosition('rise/SOL/long') threw cleanly (unregistered trader)");

  console.log("\naggregator-multi-venue-reads.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
