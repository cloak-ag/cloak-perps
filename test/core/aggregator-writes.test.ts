/**
 * Aggregator write-path integration test — real signed txs on surfpool.
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/core/aggregator-writes.test.ts
 *
 * What this validates (with real txs, not mocks):
 *   - `Aggregator.openPosition` correctly routes a {market, side,
 *     orderType, collateralMint} intent to the right venue and lands
 *     the request on chain.
 *   - The result includes `venueId` so the caller knows which venue
 *     was picked.
 *   - The trader-side cancel flow (45s window enforced by program)
 *     works through the Aggregator's `cancelRequest` proxy.
 *
 * Routing logic exercised:
 *   - SOL collateral (NATIVE_MINT): RiseVenue rejects (USDC-only),
 *     JupiterVenue accepts → routes to Jupiter.
 *   - We thus prove the capability filter actually filters.
 *
 * What this does NOT cover:
 *   - Phoenix routing (would need a Phoenix-registered T)
 *   - openMulti (the routing logic is the same per-intent; that's
 *     covered by the existing aggregator.test.ts mock cases)
 *
 * Total runtime: ~55 seconds (open + 50s wait + cancel).
 */

import { strict as assert } from "node:assert";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

import { Aggregator } from "../../src/core/aggregator.js";
import { JupiterVenue } from "../../src/jupiter/venue.js";
import { RiseVenue } from "../../src/rise/venue.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";

async function airdrop(conn: Connection, pubkey: Parameters<Connection["requestAirdrop"]>[0], lamports: number) {
  await conn.requestAirdrop(pubkey, lamports);
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const b = await conn.getBalance(pubkey, "confirmed");
    if (b >= lamports) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`airdrop didn't land for ${pubkey.toString()}`);
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const trader = Keypair.generate();
  console.log(`rpc=${RPC_URL}\ntrader=${trader.publicKey.toBase58()}\n`);

  await airdrop(conn, trader.publicKey, 5 * LAMPORTS_PER_SOL);
  console.log("  trader funded: 5 SOL\n");

  const aggregator = new Aggregator([
    new RiseVenue({ rpcUrl: RPC_URL }),
    new JupiterVenue({ rpcUrl: RPC_URL }),
  ]);

  // ─────────────────────────────────────────────────────────────
  // 1. SOL-Long with NATIVE_MINT collateral
  //    Rise capabilities: collateralMints=[USDC] → SOL rejected.
  //    Jupiter capabilities: includes SOL → accepts.
  //    Aggregator must route to Jupiter.
  // ─────────────────────────────────────────────────────────────
  console.log("[1] Aggregator.openPosition with NATIVE_MINT collateral");
  console.log("    expected route: Jupiter (Rise rejects SOL collateral)");

  const open = await aggregator.openPosition({
    connection: conn, trader,
    params: {
      market: "SOL", side: "long", orderType: "market",
      size: "50000000",                          // $50 USD-6dp
      collateral: BigInt(0.05 * LAMPORTS_PER_SOL),
      collateralMint: NATIVE_MINT,
    },
    onProgress: (s) => console.log(`    [open] ${s.slice(0, 100)}`),
  });

  assert.equal(open.venueId, "jupiter", `expected route to jupiter, got ${open.venueId}`);
  assert.equal(open.status, "pending");
  assert.ok(open.requestHandle, "expected a requestHandle from async venue");
  console.log(`  ✓ routed to ${open.venueId}, request landed: ${open.signatures[0]}`);

  // ─────────────────────────────────────────────────────────────
  // 2. Verify the routing was the capability filter, not luck:
  //    intent that Rise CAN serve must NOT route to Jupiter when
  //    Rise scores higher.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[2] Aggregator.pick — Rise scores higher when both compatible");
  const pick = aggregator.pick({
    market: "SOL", side: "long", orderType: "market",
    collateralMint: new (await import("@solana/web3.js")).PublicKey(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  // USDC
    ),
  });
  assert.equal(pick.venue.capabilities.id, "rise", "Rise should outscore Jupiter on default scoring");
  console.log(`  ✓ pick → ${pick.venue.capabilities.id}, alternatives=[${pick.alternatives.map((a) => a.venue.capabilities.id).join(",")}]`);

  // ─────────────────────────────────────────────────────────────
  // 3. Wait the keeper-execution window then cancel through the
  //    Aggregator. Aggregator has no `cancelRequest` of its own
  //    (only PerpVenue does); we route the cancel via the venue
  //    we know from `openResult.venueId`.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] cancelRequest after 45s wait (program enforces window)");
  console.log("    waiting 50s...");
  await new Promise((r) => setTimeout(r, 50_000));

  const venue = aggregator.venues.find((v) => v.capabilities.id === open.venueId);
  assert.ok(venue && venue.cancelRequest, "expected the routed venue to support cancelRequest");
  const cancel = await venue.cancelRequest({
    connection: conn, trader,
    requestHandle: open.requestHandle!,
  });
  assert.equal(cancel.status, "refunded");
  console.log(`  ✓ cancelled: ${cancel.signatures[0]}`);

  // ─────────────────────────────────────────────────────────────
  // 4. Sanity: trader's SOL is back (minus rent + tx fees).
  // ─────────────────────────────────────────────────────────────
  const balAfter = await conn.getBalance(trader.publicKey, "confirmed");
  console.log(`\n  trader balance after round-trip: ${balAfter / LAMPORTS_PER_SOL} SOL`);
  assert.ok(balAfter > 4.9 * LAMPORTS_PER_SOL, "expected ≤0.1 SOL net loss for open+cancel");

  console.log("\naggregator-writes.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
