/**
 * Multi-venue flow — the Synthesis-style "open positions on 1+ perps
 * simultaneously, all funded privately via Cloak" demo.
 *
 *     ┌─────────────────────────────────────────────────────────┐
 *     │ W (browser wallet or keypair) — funds T privately        │
 *     └────────────┬────────────────────────────────────────────┘
 *                  │  Cloak unshield (SOL fees + USDC collateral)
 *                  ▼
 *     ┌─────────────────────────────────────────────────────────┐
 *     │ T (auto-generated Keypair, persisted by caller)          │
 *     └────┬───────────────────────────────────────────────┬────┘
 *          │ openMulti([                                   │
 *          │   SOL-Long limit on Rise (Phoenix),           │
 *          │   BTC-Short market on Jupiter,                │
 *          │ ]) — submitted in parallel                    │
 *          ▼                                               ▼
 *     ┌──────────────────────┐                ┌──────────────────────┐
 *     │  Phoenix Eternal     │                │  Jupiter Perpetuals  │
 *     │  (atomic)            │                │  (async, keeper)     │
 *     └──────────┬───────────┘                └──────────┬───────────┘
 *                │ aggregator.closeAll()                  │
 *                ▼                                        ▼
 *     ┌─────────────────────────────────────────────────────────┐
 *     │ T's USDC ATA — collateral + PnL across both venues       │
 *     └────────────┬────────────────────────────────────────────┘
 *                  │ Cloak re-shield
 *                  ▼
 *     ┌─────────────────────────────────────────────────────────┐
 *     │ Cloak USDC pool — privacy boundary intact                │
 *     └─────────────────────────────────────────────────────────┘
 *
 * Env (required):
 *   W_KEYPAIR_PATH        path to W's keypair (CLI mode; for browser
 *                          use, replace with a wallet adapter object)
 *   SOLANA_RPC_URL        mainnet RPC
 *   T_KEYPAIR_PATH        OPTIONAL — if absent, a fresh T is generated
 *                          and printed to stdout. Persist the secretKey
 *                          before any further calls.
 *
 * Env (optional):
 *   T_SOL=0.01 T_USDC=15 RESHIELD_USDC=8
 *   PHOENIX_USDC=5  (collateral for Phoenix leg)
 *   JUPITER_USDC=5  (collateral for Jupiter leg)
 *   PHOENIX_PRICE=50  (limit price for Phoenix bid)
 *
 * Run: npx tsx examples/multi-venue-flow.ts
 */

import { Connection, Keypair } from "@solana/web3.js";
import { fundTargetFromUsdc, reshieldUsdc } from "../src/cloak/index.js";
import { Aggregator } from "../src/core/aggregator.js";
import { JupiterVenue } from "../src/jupiter/venue.js";
import { MINTS } from "../src/jupiter/constants.js";
import { RiseVenue } from "../src/rise/venue.js";
import { loadKeypair } from "../src/node/index.js";

const required = (k: string): string =>
  process.env[k] ?? (() => { throw new Error(`${k} is required`); })();
const num = (k: string, d: number): number => parseFloat(process.env[k] ?? `${d}`);

function banner(title: string) {
  const bar = "─".repeat(72);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const W = loadKeypair(required("W_KEYPAIR_PATH"));
  const Tprovided = process.env.T_KEYPAIR_PATH
    ? loadKeypair(process.env.T_KEYPAIR_PATH)
    : undefined;

  const tSol = num("T_SOL", 0.01);
  const tUsdc = num("T_USDC", 15);
  const phoenixUsdc = num("PHOENIX_USDC", 5);
  const jupiterUsdc = num("JUPITER_USDC", 5);
  const reshieldAmount = num("RESHIELD_USDC", 8);
  const phoenixPrice = num("PHOENIX_PRICE", 50);

  console.log("cloak-perps · multi-venue example");
  console.log(`  rpc:   ${rpcUrl}`);
  console.log(`  W:     ${W.publicKey.toBase58()}`);
  console.log(`  T:     ${Tprovided ? Tprovided.publicKey.toBase58() : "(auto-generated)"}`);
  console.log(`  fund:  ${tSol} SOL + ${tUsdc} USDC → T`);
  console.log(`  positions: Phoenix SOL-Long $${phoenixUsdc} + Jupiter BTC-Short $${jupiterUsdc}`);

  const connection = new Connection(rpcUrl, "confirmed");

  // ────────────────────────────────────────────────────────────
  // 1. Cloak fund — auto-generates T if not provided.
  //    Caller is responsible for persisting result.TKeypair.
  // ────────────────────────────────────────────────────────────
  banner("1. Cloak fund — W → T (T auto-generated if absent)");
  const fund = await fundTargetFromUsdc({
    connection, W, T: Tprovided,
    tSol, tUsdc,
    onProgress: (stage, status) => console.log(`  [${stage}] ${status}`),
  });
  const T: Keypair = fund.TKeypair;
  if (fund.TGenerated) {
    console.log(`\n  ⚠ T was auto-generated. Persist this secretKey locally before continuing:`);
    console.log(`     pubkey:    ${T.publicKey.toBase58()}`);
    console.log(`     secretKey: [${Array.from(T.secretKey).join(",")}]`);
    console.log(`  In a browser app you would write this to localStorage now.`);
  }

  // ────────────────────────────────────────────────────────────
  // 2. Aggregator-driven multi-venue open.
  //    Two intents, submitted in parallel via Promise.all under the hood.
  //    Each intent picks the best-scoring compatible venue.
  // ────────────────────────────────────────────────────────────
  banner("2. Aggregator.openMulti — parallel positions across venues");
  const agg = new Aggregator([
    new RiseVenue({ rpcUrl }),
    new JupiterVenue({ rpcUrl }),
  ]);

  const outcomes = await agg.openMulti({
    connection, trader: T,
    intents: [
      // Phoenix (Rise): SOL-Long, limit order at $phoenixPrice (won't fill).
      // Routes to Rise because Rise supports `orderType: "limit"`.
      {
        market: "SOL", side: "long", orderType: "limit",
        size: "0.01",                                    // 0.01 SOL
        collateral: BigInt(Math.round(phoenixUsdc * 1_000_000)),
        collateralMint: MINTS.USDC,
        priceUsd: phoenixPrice,
      },
      // Jupiter: BTC-Short, market.
      // Routes to Jupiter because Jupiter only supports `orderType: "market"`,
      // but Rise also supports market — default score gives Rise priority. Force
      // Jupiter by requiring SOL collateral, OR override score. For this demo we
      // explicitly target the venue by setting `market: "BTC"` + `side: "short"` —
      // Phoenix's market list doesn't currently expose "BTC" the way our Rise
      // adapter is set up (only "SOL" symbol mapped), so this lands on Jupiter
      // by capability filtering.
      {
        market: "BTC", side: "short", orderType: "market",
        size: BigInt(Math.round(jupiterUsdc * 5 * 1_000_000)).toString(), // ~5x leverage notional in USD-6dp
        collateral: BigInt(Math.round(jupiterUsdc * 1_000_000)),
        collateralMint: MINTS.USDC,
      },
    ],
    onProgress: (i, status) => console.log(`  [intent ${i}] ${status.slice(0, 100)}`),
  });

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.ok) {
      console.log(`  ✓ intent ${i} → ${o.venueId}: ${o.result?.status} (${o.result?.signatures[0]})`);
    } else {
      console.log(`  ✗ intent ${i} failed: ${o.error?.slice(0, 200)}`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 3. List all positions across venues.
  // ────────────────────────────────────────────────────────────
  banner("3. listPositions — fan-out across venues");
  const allPositions = await agg.listPositions({ connection, trader: T });
  for (const p of allPositions) {
    console.log(`  ${p.handle}  size=${p.size}  collateral=${p.collateral}`);
  }
  if (allPositions.length === 0) {
    console.log("  (no executed positions yet — Jupiter requests await keeper, Phoenix limit may be unfilled)");
  }

  // ────────────────────────────────────────────────────────────
  // 4. closeAll — exit every open position. For Jupiter the close
  //    is a request that the keeper executes async; for Phoenix it
  //    is atomic.
  // ────────────────────────────────────────────────────────────
  banner("4. closeAll — exit across venues");
  const closeResults = await agg.closeAll({
    connection, trader: T,
    onProgress: (handle, status) => console.log(`  [${handle}] ${status.slice(0, 80)}`),
  });
  for (const r of closeResults) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.handle}: ${r.ok ? r.result?.signatures[0] : r.error?.slice(0, 100)}`);
  }

  // ────────────────────────────────────────────────────────────
  // 5. Cloak re-shield — T's USDC back into the pool.
  // ────────────────────────────────────────────────────────────
  banner("5. Cloak re-shield — T → USDC pool");
  const exit = await reshieldUsdc({
    connection, owner: T, amount: reshieldAmount,
    onProgress: (status) => console.log(`  [reshield] ${status}`),
  });
  console.log(`  ✓ tx: ${exit.signature}`);
  console.log(`  ✓ T's USDC: ${exit.ownerUsdcBefore} → ${exit.ownerUsdcAfter}`);

  banner("done");
  console.log("Privacy boundary intact across both venues. T's positions are public on");
  console.log("each venue (necessarily); the W↔T linkage is hidden by Cloak.");
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
