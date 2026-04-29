/**
 * streamPositions re-emit test — proves the WebSocket subscription
 * actually fires `onUpdate` on subsequent state changes (not just the
 * initial emission).
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/core/aggregator-streaming-reemit.test.ts
 *
 * Approach:
 *   1. Subscribe to the known mainnet trader (who has a Jupiter
 *      SOL-Long position). Initial emission fires with that position.
 *   2. Use surfpool's `surfnet_setAccount` cheatcode to bump the
 *      lamports on the trader's Position PDA. Any write to a
 *      subscribed account triggers the WS `onAccountChange` callback,
 *      which our adapter routes through to a re-fetch + re-emit.
 *   3. Wait briefly, verify `onUpdate` fired ≥ 2 times total.
 *
 * Why this is meaningful: it proves that beyond the initial fetch,
 * the streaming layer is actually reactive to on-chain changes — the
 * exact property a frontend depends on for live PnL ticks, fills,
 * liquidation alerts.
 *
 * Why we use a cheatcode rather than a real position change: surfpool
 * runs no Jupiter keeper, so the only way to mutate a Position PDA
 * locally is to inject the change via cheat. This is structurally
 * equivalent to a keeper update — same WS notification path.
 */

import { strict as assert } from "node:assert";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { Aggregator } from "../../src/core/aggregator.js";
import type { PositionState } from "../../src/core/types.js";
import { JupiterVenue } from "../../src/jupiter/venue.js";
import { generatePositionPda } from "../../src/jupiter/pdas.js";
import { RiseVenue } from "../../src/rise/venue.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";
const KNOWN_TRADER = "9qB3YPTKVpoCS18nC2969ViguxDXge55gYMbVNU2M4pd";

function fakeKeypair(addr: string): Keypair {
  const dummy = Keypair.generate();
  Object.defineProperty(dummy, "publicKey", { value: new PublicKey(addr) });
  return dummy;
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method} failed: ${j.error.message}`);
  return j.result;
}

async function main() {
  const wsUrl = RPC_URL.replace(/^http/, "ws").replace(/:(\d+)$/, (_, p) =>
    `:${parseInt(p, 10) + 1}`,
  );
  const conn = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: wsUrl });
  const trader = fakeKeypair(KNOWN_TRADER);

  console.log(`rpc=${RPC_URL}\nws=${wsUrl}\ntrader=${KNOWN_TRADER}\n`);

  const aggregator = new Aggregator([
    new RiseVenue({ rpcUrl: RPC_URL }),
    new JupiterVenue({ rpcUrl: RPC_URL }),
  ]);

  // Resolve the known trader's SOL-Long Position PDA (the one we'll mutate).
  const { position: solLongPda } = generatePositionPda({
    trader: trader.publicKey, market: "SOL", side: "long",
  });
  console.log(`  SOL-Long PDA: ${solLongPda.toBase58()}\n`);

  const updates: { count: number; lastSize: string } = { count: 0, lastSize: "" };
  const sub = await aggregator.streamPositions({
    connection: conn, trader,
    onUpdate: (positions: PositionState[]) => {
      updates.count++;
      const solLong = positions.find((p) => p.handle === "jupiter/SOL/long");
      updates.lastSize = solLong?.size ?? "";
      console.log(`  ⟳ onUpdate #${updates.count}: ${positions.length} position(s), SOL-Long size=${updates.lastSize}`);
    },
  });

  // Verify initial emission fired.
  assert.ok(updates.count >= 1, "expected initial emission");
  console.log(`  ✓ initial emission: ${updates.count} update(s) so far`);

  // Read the current account state so we can bump it predictably.
  const before = await conn.getAccountInfo(solLongPda, "confirmed");
  assert.ok(before, "expected SOL-Long PDA to exist on the fork");
  const newLamports = before.lamports + 1; // any change triggers WS
  console.log(`  bumping PDA lamports ${before.lamports} → ${newLamports} via surfnet_setAccount…`);

  // Sleep briefly to ensure the WS sub is fully established before mutation.
  await new Promise((r) => setTimeout(r, 1500));

  await rpcCall("surfnet_setAccount", [
    solLongPda.toBase58(),
    { lamports: newLamports },
  ]);

  // Wait for the WS callback to propagate. Solana RPC ws push latency
  // is usually <1s on a healthy validator; surfpool runs blocks every
  // 400ms. Give it a generous window.
  const startUpdates = updates.count;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && updates.count <= startUpdates) {
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n  total emissions: ${updates.count} (${updates.count > startUpdates ? "re-emit fired" : "did NOT re-emit"})`);
  assert.ok(
    updates.count > startUpdates,
    `expected re-emit after surfnet_setAccount, but updates stayed at ${updates.count}`,
  );
  console.log(`  ✓ stream re-emitted on PDA mutation (proof: WS callback path is reactive)`);

  // Verify the re-emitted size still matches what we expect (the
  // account data didn't change, only the lamports — so size should
  // remain whatever it was).
  assert.ok(updates.lastSize.length > 0, "expected SOL-Long size on re-emission");
  console.log(`  ✓ re-emitted state still includes jupiter/SOL/long (size=${updates.lastSize})`);

  await sub.unsubscribe();
  console.log(`  ✓ unsubscribe() clean`);

  console.log("\naggregator-streaming-reemit.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
