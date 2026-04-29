/**
 * Live multi-venue streaming portfolio against surfpool's mainnet fork.
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/core/aggregator-streaming.test.ts
 *
 * What this validates:
 *   - `Aggregator.streamPositions` calls back at least once with the
 *     current merged state (initial fetch).
 *   - Venues that don't implement `streamPositions` are reported via
 *     `unsupported` rather than silently dropped.
 *   - Jupiter's `streamPositions` impl correctly fires the first
 *     emission with the trader's existing positions.
 *   - `unsubscribe()` cleanly tears down listeners.
 *
 * We don't try to validate "fires on subsequent change" here — that
 * would need a real position update during the test, which we can't
 * trigger without an actual mainnet trade. The subscription lifecycle
 * itself is what we lock down.
 */

import { strict as assert } from "node:assert";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { Aggregator } from "../../src/core/aggregator.js";
import type { PositionState } from "../../src/core/types.js";
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
  // For account subscriptions we need the WebSocket endpoint. Surfpool
  // runs WS on RPC port + 1 by default (8900 for 8899, 18900 for 18899).
  const wsUrl = RPC_URL.replace(/^http/, "ws").replace(/:(\d+)$/, (_, p) =>
    `:${parseInt(p, 10) + 1}`,
  );
  const conn = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: wsUrl });
  const trader = fakeKeypair(KNOWN_TRADER);

  const aggregator = new Aggregator([
    new RiseVenue({ rpcUrl: RPC_URL }),
    new JupiterVenue({ rpcUrl: RPC_URL }),
  ]);

  console.log(`rpc=${RPC_URL}\nws=${wsUrl}\ntrader=${KNOWN_TRADER}\n`);

  let updates = 0;
  let lastMerged: PositionState[] = [];
  const sub = await aggregator.streamPositions({
    connection: conn,
    trader,
    onUpdate: (positions) => {
      updates++;
      lastMerged = positions;
      console.log(`  ⟳ update #${updates}: ${positions.length} position(s)`);
      for (const p of positions) {
        console.log(`     ${p.handle}  size=${p.size}  collateral=${p.collateral}`);
      }
    },
    onError: (venueId, err) => {
      console.log(`  [${venueId}] error: ${err.message.slice(0, 80)}`);
    },
  });

  console.log(`  unsupported venues (no streamPositions impl): [${sub.unsupported.join(", ") || "none"}]`);
  // Rise hasn't implemented streamPositions; should be in unsupported.
  assert.deepEqual(sub.unsupported, ["rise"], "expected Rise in unsupported");

  // The Jupiter stream's initial emission is awaited inside `streamPositions`,
  // so by the time we get the subscription handle, `onUpdate` has fired once.
  assert.ok(updates >= 1, `expected ≥1 update from initial fetch, got ${updates}`);

  // The trader has a known SOL-Long Jupiter position.
  const solLong = lastMerged.find((p) => p.handle === "jupiter/SOL/long");
  assert.ok(solLong, "expected jupiter/SOL/long in initial emission");
  console.log(`  ✓ initial emission included jupiter/SOL/long`);

  // Tear down. Subsequent listener removal should not throw.
  await sub.unsubscribe();
  console.log("  ✓ unsubscribe() completed");

  // After unsubscribe, the connection's listener count should not grow
  // even if we wait briefly. (Hard to assert directly; just confirm no
  // errors thrown.)
  await new Promise((r) => setTimeout(r, 500));

  console.log("\naggregator-streaming.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
