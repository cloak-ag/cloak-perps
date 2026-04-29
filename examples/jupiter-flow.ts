/**
 * cloak-perps · jupiter — full-flow example
 *
 * Privacy-first end-to-end on Jupiter Perpetuals (USDC-collateralized
 * short, market-order):
 *
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  W (funding wallet — holds shielded USDC)                 │
 *     └────────────┬─────────────────────────────────────────────┘
 *                  │  Cloak unshield (USDC + small SOL for fees)
 *                  ▼
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  T (trading wallet — fresh; gets SOL + USDC)              │
 *     └────────────┬─────────────────────────────────────────────┘
 *                  │  Jupiter Perps lifecycle:
 *                  │    1. createIncreasePositionMarketRequest
 *                  │    2. ⏳ keeper executes (~1–60s)
 *                  │    3. createDecreasePositionMarketRequest
 *                  │    4. ⏳ keeper executes
 *                  ▼
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  T's USDC ATA (post-close — collateral + PnL)             │
 *     └────────────┬─────────────────────────────────────────────┘
 *                  │  Cloak re-shield
 *                  ▼
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  Cloak USDC pool (private — anyone-to-anyone again)       │
 *     └──────────────────────────────────────────────────────────┘
 *
 * Each step is run individually here (rather than via `fullPipeline`)
 * so the surface area of each Cloak/Jupiter call is visible.
 *
 * --------------------------------------------------------------------
 * Env (required):
 *   W_KEYPAIR_PATH        path to W's keypair
 *   TARGET_KEYPAIR_PATH   path to T's keypair (any wallet — Jupiter is
 *                         permissionless, no allowlist needed)
 *   SOLANA_RPC_URL        mainnet RPC
 *
 * Env (optional):
 *   CLOAK_PROGRAM_ID      override Cloak shield-pool program
 *   CLOAK_RELAY_URL       override Cloak relay URL
 *   T_SOL=0.01            SOL to T (post-fee, exact)
 *   T_USDC=15             USDC to T (post-fee)
 *   SIZE_USD=50           position notional in USD
 *   COLLATERAL_USDC=10    collateral posted (must be ≤ T_USDC)
 *   RESHIELD_USDC=8       USDC to re-shield after close
 *   MARKET=SOL            base asset (SOL | ETH | BTC)
 *   SIDE=short            v0 supports short only
 *   SLIPPAGE_BPS=50
 *
 * --------------------------------------------------------------------
 * Mainnet smoke amounts: ~$0.50 of real funds (Cloak fees on $15
 * round-trip + tiny Jupiter open/close fee at 0.06% × $50 = $0.06).
 * Surfpool: pipeline will fail at step 2 because no keeper executes;
 * that's expected.
 *
 * --------------------------------------------------------------------
 * Run:
 *   npm run example
 */

import { Connection, PublicKey } from "@solana/web3.js";

import { fundTargetFromUsdc, reshieldUsdc } from "../src/cloak/index.js";
import { loadKeypair } from "../src/node/index.js";

import { JupiterVenue } from "../src/jupiter/venue.js";
import { MINTS, type MarketBase } from "../src/jupiter/constants.js";

const required = (k: string): string =>
  process.env[k] ?? (() => { throw new Error(`${k} is required`); })();

const num = (k: string, d: number): number => parseFloat(process.env[k] ?? `${d}`);

function banner(title: string) {
  const bar = "─".repeat(72);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const programId = process.env.CLOAK_PROGRAM_ID ? new PublicKey(process.env.CLOAK_PROGRAM_ID) : undefined;
  const relayUrl = process.env.CLOAK_RELAY_URL;
  const W = loadKeypair(required("W_KEYPAIR_PATH"));
  const T = loadKeypair(required("TARGET_KEYPAIR_PATH"));

  const tSol = num("T_SOL", 0.01);
  const tUsdc = num("T_USDC", 15);
  const sizeUsd = num("SIZE_USD", 50);
  const collateralUsdc = num("COLLATERAL_USDC", 10);
  const reshield = num("RESHIELD_USDC", 8);
  const market = (process.env.MARKET ?? "SOL") as MarketBase;
  const slippageBps = parseInt(process.env.SLIPPAGE_BPS ?? "50", 10);

  console.log("cloak-perps · jupiter — full-flow example");
  console.log(`  rpc:      ${rpcUrl}`);
  console.log(`  W:        ${W.publicKey.toBase58()}`);
  console.log(`  T:        ${T.publicKey.toBase58()}`);
  console.log(`  fund T:   ${tSol} SOL + ${tUsdc} USDC (Cloak Case A)`);
  console.log(`  trade:    ${market}-Short, $${sizeUsd} notional, $${collateralUsdc} collateral`);
  console.log(`  exit:     re-shield ${reshield} USDC into Cloak USDC pool`);

  const connection = new Connection(rpcUrl, "confirmed");
  const venue = new JupiterVenue({ rpcUrl });

  // ─────────────────────────────────────────────────────────────
  // 1. Cloak fund — W → T (private)
  // ─────────────────────────────────────────────────────────────
  banner("1. Cloak fund — W → T (private)");
  const fund = await fundTargetFromUsdc({
    connection, W, T, tSol, tUsdc,
    programId, relayUrl,
    onProgress: (stage, status) => console.log(`  [${stage}] ${status}`),
  });
  console.log(`  ✓ T now holds ${(fund.T_sol_lamports_after / 1e9).toFixed(4)} SOL + ${fund.T_usdc_ui_after} USDC`);

  // ─────────────────────────────────────────────────────────────
  // 2. Jupiter open (USDC-collateralized short, market)
  //    Async: keeper executes within ~45s or auto-rejects.
  // ─────────────────────────────────────────────────────────────
  banner("2. Jupiter open — short with USDC collateral");
  const open = await venue.openPosition({
    connection, trader: T,
    params: {
      market, side: "short", orderType: "market",
      size: BigInt(Math.round(sizeUsd * 1_000_000)).toString(),
      collateral: BigInt(Math.round(collateralUsdc * 1_000_000)),
      collateralMint: MINTS.USDC,
      slippageBps,
    },
    onProgress: (s) => console.log(`  [open] ${s}`),
  });
  console.log(`  ✓ open request submitted: ${open.signatures[0]}`);
  console.log(`  ⏳ awaiting keeper execution…`);
  const openSettled = await venue.awaitSettlement({
    connection, trader: T, requestHandle: open.requestHandle!,
  });
  if (openSettled.status !== "confirmed") {
    throw new Error(`open: keeper did not execute (${openSettled.status}: ${openSettled.reason})`);
  }
  console.log(`  ✓ keeper executed open`);

  // ─────────────────────────────────────────────────────────────
  // 3. Jupiter close (full close)
  // ─────────────────────────────────────────────────────────────
  banner("3. Jupiter close — flatten + return USDC");
  const close = await venue.closePosition({
    connection, trader: T,
    params: {
      positionHandle: `jupiter/${market}/short`,
      fraction: 1,
      slippageBps,
    },
    onProgress: (s) => console.log(`  [close] ${s}`),
  });
  console.log(`  ✓ close request submitted: ${close.signatures[0]}`);
  console.log(`  ⏳ awaiting keeper execution…`);
  const closeSettled = await venue.awaitSettlement({
    connection, trader: T, requestHandle: close.requestHandle!,
  });
  if (closeSettled.status !== "confirmed") {
    throw new Error(`close: keeper did not execute (${closeSettled.status}: ${closeSettled.reason})`);
  }
  console.log(`  ✓ keeper executed close — collateral + PnL returned to T's USDC ATA`);

  // ─────────────────────────────────────────────────────────────
  // 4. Cloak re-shield — T → Cloak USDC pool (private)
  // ─────────────────────────────────────────────────────────────
  banner("4. Cloak re-shield — T → Cloak USDC pool (private)");
  const exit = await reshieldUsdc({
    connection,
    owner: T,
    amount: reshield,
    programId, relayUrl,
    onProgress: (status) => console.log(`  [reshield] ${status}`),
  });
  console.log(`  ✓ tx: ${exit.signature}`);
  console.log(`  ✓ T's USDC: ${exit.ownerUsdcBefore} → ${exit.ownerUsdcAfter}`);
  console.log(`  ✓ commitments: [${exit.commitmentIndices.join(", ")}]`);

  banner("done");
  console.log("Privacy boundary intact. T's Jupiter Perps activity is on-chain;");
  console.log("the W↔T relationship and the post-trade USDC flow are not.");
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
