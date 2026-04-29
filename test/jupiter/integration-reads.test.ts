/**
 * Integration test: read paths against a surfpool mainnet-fork.
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/integration-reads.test.ts
 *
 * What's tested:
 *   - `getPosition` returns a non-null PositionState for a real
 *     mainnet position fetched on-demand by surfpool from mainnet.
 *   - `listPositions` enumerates the trader's open positions across
 *     the 9 (base × side × collateral) PDAs.
 *   - `getPosition` returns `null` for a wallet with no position.
 *
 * Why this is meaningful: surfpool transparently mirrors mainnet
 * accounts on first access, so we exercise the same decoding/PDA
 * paths the production adapter will hit, without paying mainnet
 * fees or needing a real trader keypair.
 */

import { strict as assert } from "node:assert";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { JupiterVenue } from "../../src/jupiter/venue.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";

// A real mainnet wallet with an open SOL-Long position (verified live
// via getMultipleAccountsInfo against mainnet on 2026-04-29).
const KNOWN_TRADER = "9qB3YPTKVpoCS18nC2969ViguxDXge55gYMbVNU2M4pd";
const EMPTY_TRADER = "DFZcDnmEYNUK1khquZzx5dQYiEyjJ3N5STqaDVLZ88ZU";

/** Build a fake Keypair whose `publicKey` is `addr` so we can pass it
 *  into the read-only adapter methods without holding the actual key. */
function fakeKeypair(addr: string): Keypair {
  const dummy = Keypair.generate();
  Object.defineProperty(dummy, "publicKey", { value: new PublicKey(addr) });
  return dummy;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const venue = new JupiterVenue({ rpcUrl: RPC_URL });

  const trader = fakeKeypair(KNOWN_TRADER);
  const empty = fakeKeypair(EMPTY_TRADER);

  console.log(`rpc=${RPC_URL}`);
  console.log(`trader=${KNOWN_TRADER}\nempty=${EMPTY_TRADER}\n`);

  // 1. getPosition for the known SOL-Long position
  {
    const p = await venue.getPosition({
      connection: conn,
      trader,
      positionHandle: "jupiter/SOL/long",
    });
    assert.ok(p !== null, "expected non-null SOL-Long position for known trader");
    assert.equal(p.handle, "jupiter/SOL/long");
    assert.equal(p.market, "SOL");
    assert.equal(p.side, "long");
    assert.ok(BigInt(p.size) > 0n, `expected size>0, got ${p.size}`);
    console.log(`  ✓ getPosition(SOL/long): size=${p.size} collateral=${p.collateral}`);
  }

  // 2. getPosition for a side the known trader doesn't hold
  {
    const p = await venue.getPosition({
      connection: conn,
      trader,
      positionHandle: "jupiter/BTC/short",
    });
    // PDA may exist with sizeUsd=0 (closed) or not exist; we treat both as null.
    assert.equal(p, null, "expected null for unowned BTC-short");
    console.log("  ✓ getPosition(BTC/short): null");
  }

  // 3. listPositions enumerates the open ones
  {
    const positions = await venue.listPositions({ connection: conn, trader });
    assert.ok(positions.length >= 1, `expected ≥1 position, got ${positions.length}`);
    const solLong = positions.find((p) => p.handle === "jupiter/SOL/long");
    assert.ok(solLong, "SOL-Long missing from listPositions");
    console.log(`  ✓ listPositions: ${positions.length} open`);
    for (const p of positions) {
      console.log(`     ${p.handle}  size=${p.size}  collateral=${p.collateral}`);
    }
  }

  // 4. listPositions for an empty wallet returns []
  {
    const positions = await venue.listPositions({ connection: conn, trader: empty });
    assert.deepEqual(positions, []);
    console.log("  ✓ listPositions(empty): []");
  }

  console.log("\nintegration-reads.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
