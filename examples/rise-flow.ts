/**
 * cloak-perps · rise — full-flow example
 *
 * Runs the end-to-end story against mainnet:
 *
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  W (funding wallet — holds shielded SOL + USDC liquidity) │
 *     └────────────┬─────────────────────────────────────────────┘
 *                  │  Cloak unshield (Case A — no swap)
 *                  ▼
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  T (trading wallet — fresh; gets SOL for fees + USDC)     │
 *     └────────────┬─────────────────────────────────────────────┘
 *                  │  Phoenix lifecycle:
 *                  │    1. Ember + DepositFunds
 *                  │    2. place_limit_order
 *                  │    3. cancel_all
 *                  │    4. WithdrawFunds + Ember-w
 *                  ▼
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  T's USDC ATA (post-Phoenix)                              │
 *     └────────────┬─────────────────────────────────────────────┘
 *                  │  Cloak re-shield
 *                  ▼
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  Cloak USDC pool (private — anyone-to-anyone again)       │
 *     └──────────────────────────────────────────────────────────┘
 *
 * Each step is run individually here (rather than via `fullPipeline`)
 * so the surface area of each Cloak/Phoenix call is visible.
 *
 * --------------------------------------------------------------------
 * Env (required):
 *   W_KEYPAIR_PATH        path to W's keypair (json byte-array OR base58)
 *   TARGET_KEYPAIR_PATH   path to T's keypair (must be a Phoenix trader)
 *   SOLANA_RPC_URL        mainnet RPC (Helius / Triton / public)
 *
 * Env (optional):
 *   CLOAK_PROGRAM_ID      override Cloak shield-pool program (default: mainnet)
 *   CLOAK_RELAY_URL       override Cloak relay URL (default: https://api.cloak.ag)
 *   T_SOL=0.005           SOL delivered to T (post-Cloak-fee, exact)
 *   T_USDC=0.5            USDC minimum delivered to T (post-fee)
 *   DEPOSIT_USDC=0.3      USDC the Phoenix step deposits as collateral
 *   RESHIELD_USDC=0.3     USDC the exit step re-shields
 *   SYMBOL=SOL            Phoenix market
 *   SIDE=bid              order side
 *   PRICE_USD=50          limit price (set far OTM so the order rests)
 *   BASE_UNITS=0.01       order size in base units
 *
 * Recommended mainnet smoke amounts cost ~$0.50 of real funds (mostly
 * the 0.3% Cloak fee on the moved USDC). The Phoenix part is free
 * unless your order fills — placing far-OTM bids keeps that controlled.
 *
 * --------------------------------------------------------------------
 * Run:
 *   npm run example
 */

import { Connection, PublicKey } from "@solana/web3.js";

import {
  fundTargetFromUsdc,
  phoenixLifecycle,
  reshieldUsdc,
} from "../src/index.js";
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
  const programId = process.env.CLOAK_PROGRAM_ID ? new PublicKey(process.env.CLOAK_PROGRAM_ID) : undefined;
  const relayUrl = process.env.CLOAK_RELAY_URL;
  const W = loadKeypair(required("W_KEYPAIR_PATH"));
  const T = loadKeypair(required("TARGET_KEYPAIR_PATH"));

  const tSol = num("T_SOL", 0.005);
  const tUsdc = num("T_USDC", 0.5);
  const depositUsdc = num("DEPOSIT_USDC", 0.3);
  const reshield = num("RESHIELD_USDC", 0.3);

  const symbol = process.env.SYMBOL ?? "SOL";
  const side = (process.env.SIDE ?? "bid").toLowerCase() === "ask" ? "ask" : "bid";
  const priceUsd = num("PRICE_USD", 50);
  const baseUnits = process.env.BASE_UNITS ?? "0.01";

  console.log("cloak-perps · rise — full-flow example");
  console.log(`  rpc:      ${rpcUrl}`);
  console.log(`  W:        ${W.publicKey.toBase58()}`);
  console.log(`  T:        ${T.publicKey.toBase58()}`);
  console.log(`  fund T:   ${tSol} SOL + ${tUsdc} USDC (Cloak Case A — no swap)`);
  console.log(`  phoenix:  deposit ${depositUsdc} USDC, ${side} ${baseUnits} ${symbol} @ $${priceUsd}`);
  console.log(`  exit:     re-shield ${reshield} USDC into Cloak USDC pool`);

  const connection = new Connection(rpcUrl, "confirmed");

  // ────────────────────────────────────────────────────────────────
  // 1. Cloak — privately fund T from W (Case A: send shielded USDC,
  //    no AMM swap). Two unshields land at T: SOL (for fees) + USDC
  //    (for collateral). W's identity is unlinkable from T's inflows.
  // ────────────────────────────────────────────────────────────────
  banner("1. Cloak fund — W → T (private)");
  const fund = await fundTargetFromUsdc({
    connection,
    W, T,
    tSol, tUsdc,
    programId, relayUrl,
    onProgress: (stage, status) => console.log(`  [${stage}] ${status}`),
  });
  console.log(`  ✓ T now holds ${(fund.T_sol_lamports_after / 1e9).toFixed(4)} SOL + ${fund.T_usdc_ui_after} USDC`);

  // ────────────────────────────────────────────────────────────────
  // 2. Phoenix — full trader lifecycle on T. Ember-w workaround for
  //    the @ellipsis-labs/rise@0.4.8 mint-swap bug is applied inside
  //    `phoenixLifecycle`. T must already be a registered Phoenix
  //    trader (this example does not register).
  // ────────────────────────────────────────────────────────────────
  banner("2. Phoenix — Ember+Deposit → place → cancel → Withdraw+Ember-w");
  const phoenix = await phoenixLifecycle({
    rpcUrl, T,
    depositUsdc,
    symbol, side, priceUsd, baseUnits,
    onProgress: (stage, status) => console.log(`  [${stage}] ${status}`),
  });
  console.log(`  ✓ deposit:  ${phoenix.depositSig}`);
  console.log(`  ✓ place:    ${phoenix.placeSig}`);
  console.log(`  ✓ cancel:   ${phoenix.cancelSig}`);
  console.log(`  ✓ withdraw: ${phoenix.withdrawSig}`);

  // ────────────────────────────────────────────────────────────────
  // 3. Cloak — re-shield T's exited USDC into the Cloak USDC pool.
  //    Closes the privacy loop: T's wallet ends with no on-chain
  //    USDC trace beyond the Phoenix lifecycle itself.
  // ────────────────────────────────────────────────────────────────
  banner("3. Cloak re-shield — T → Cloak USDC pool (private)");
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
  console.log("Privacy boundary intact. T's Phoenix activity is on-chain;");
  console.log("the W↔T relationship and the post-trade USDC flow are not.");
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
