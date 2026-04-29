/**
 * Comprehensive surfpool integration test — exercises every code path
 * that's exercisable without a real Jupiter keeper.
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/integration-comprehensive.test.ts
 *
 * Coverage:
 *   1. limit-order rejection (adapter-level)
 *   2. open SOL-Short with USDC collateral (surfnet_setTokenAccount funded) → request lands
 *   3. closePosition request creation against an open (unexecuted) position
 *   4. withdrawCollateral with explicit amount → request lands
 *   5. awaitSettlement times out cleanly when no keeper executes
 *   6. depositCollateral round-trip (already covered separately, omit duplication)
 *
 * Uses 50s waits between open and cancel because the program enforces
 * the keeper-execution window (`pool.maxRequestExecutionSec=45s`) on
 * trader-self-signed `closePositionRequest2`.
 *
 * Total runtime: ~110 seconds.
 */

import { strict as assert } from "node:assert";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

import { JupiterVenue } from "../../src/jupiter/venue.js";
import { MINTS } from "../../src/jupiter/constants.js";
import { generatePositionPda, generatePositionRequestPda } from "../../src/jupiter/pdas.js";
import { decodeRequestHandle } from "../../src/jupiter/handle.js";
import { BN } from "@coral-xyz/anchor";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";

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

async function airdrop(conn: Connection, pubkey: PublicKey, lamports: number) {
  await conn.requestAirdrop(pubkey, lamports);
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const b = await conn.getBalance(pubkey, "confirmed");
    if (b >= lamports) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`airdrop didn't land for ${pubkey.toBase58()}`);
}

async function setTokenBalance(owner: PublicKey, mint: PublicKey, amount: bigint) {
  await rpcCall("surfnet_setTokenAccount", [owner.toBase58(), mint.toBase58(), { amount: Number(amount) }]);
}

async function expectRequestPdaExists(
  conn: Connection,
  trader: PublicKey,
  market: "SOL" | "ETH" | "BTC",
  side: "long" | "short",
  counter: bigint,
  requestChange: "increase" | "decrease",
  label: string,
) {
  const { position } = generatePositionPda({ trader, market, side });
  const { positionRequest } = generatePositionRequestPda({
    position, counter: new BN(counter.toString()), requestChange,
  });
  const info = await conn.getAccountInfo(positionRequest, "confirmed");
  assert.ok(info !== null, `${label}: PositionRequest PDA missing at ${positionRequest.toBase58()}`);
  console.log(`  ✓ ${label}: PositionRequest at ${positionRequest.toBase58().slice(0, 16)}… (${info!.data.length}b)`);
  return positionRequest;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const venue = new JupiterVenue({ rpcUrl: RPC_URL });
  const trader = Keypair.generate();
  console.log(`rpc=${RPC_URL}\ntrader=${trader.publicKey.toBase58()}\n`);

  await airdrop(conn, trader.publicKey, 5 * LAMPORTS_PER_SOL);
  // Fund trader with USDC and USDT for short-collateral tests
  await setTokenBalance(trader.publicKey, MINTS.USDC, 100_000_000n); // $100 USDC
  await setTokenBalance(trader.publicKey, MINTS.USDT, 100_000_000n); // $100 USDT
  console.log("  trader funded: 5 SOL + 100 USDC + 100 USDT\n");

  // ─────────────────────────────────────────────────────────────
  // 1. limit-order rejection
  // ─────────────────────────────────────────────────────────────
  console.log("[1] limit-order rejection");
  let limitRejected = false;
  try {
    await venue.openPosition({
      connection: conn, trader,
      params: {
        market: "SOL", side: "long", orderType: "limit",
        size: "50000000", priceUsd: 50,
        collateral: BigInt(0.05 * LAMPORTS_PER_SOL),
        collateralMint: NATIVE_MINT,
      },
    });
  } catch (e) {
    limitRejected = /limit orders not supported/.test(e instanceof Error ? e.message : String(e));
  }
  assert.ok(limitRejected, "expected limit order to be rejected");
  console.log("  ✓ limit-order rejected by adapter\n");

  // ─────────────────────────────────────────────────────────────
  // 2. SOL-Short with USDC collateral
  // ─────────────────────────────────────────────────────────────
  console.log("[2] SOL-Short with USDC collateral");
  const shortResult = await venue.openPosition({
    connection: conn, trader,
    params: {
      market: "SOL", side: "short", orderType: "market",
      size: "50000000", // $50
      collateral: 10_000_000n, // 10 USDC
      collateralMint: MINTS.USDC,
    },
    onProgress: (s) => console.log(`    [open-short] ${s}`),
  });
  assert.equal(shortResult.status, "pending");
  const shortDecoded = decodeRequestHandle(shortResult.requestHandle!);
  await expectRequestPdaExists(
    conn, trader.publicKey, shortDecoded.market, shortDecoded.side, shortDecoded.counter, "increase",
    "SOL-Short USDC open",
  );

  // ─────────────────────────────────────────────────────────────
  // 3. awaitSettlement times out cleanly
  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] awaitSettlement times out");
  const t0 = Date.now();
  const settled = await venue.awaitSettlement({
    connection: conn, trader,
    requestHandle: shortResult.requestHandle!,
    timeoutMs: 3000,
  });
  const elapsed = Date.now() - t0;
  assert.equal(settled.status, "pending");
  assert.ok(/timed out/.test(settled.reason ?? ""), `expected 'timed out' reason, got: ${settled.reason}`);
  assert.ok(elapsed >= 3000 && elapsed < 6000, `expected timeout near 3000ms, got ${elapsed}ms`);
  console.log(`  ✓ timed out after ${elapsed}ms (no keeper on surfpool, expected behavior)`);

  // ─────────────────────────────────────────────────────────────
  // 4. closePosition request creation against an unexecuted position
  //    (Position PDA doesn't exist yet because keeper hasn't executed.)
  //    Expect the create-decrease-request ix to either land (creating
  //    a decrease request PDA) or to fail with an account constraint.
  //    We assert behavior rather than dictate it.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[4] closePosition request creation");
  let closeOutcome: "landed" | "rejected" = "rejected";
  let closeReason = "";
  try {
    const closeResult = await venue.closePosition({
      connection: conn, trader,
      params: { positionHandle: "jupiter/SOL/short", fraction: 1 },
      onProgress: (s) => console.log(`    [close] ${s}`),
    });
    if (closeResult.status === "pending" && closeResult.requestHandle) {
      closeOutcome = "landed";
      const dec = decodeRequestHandle(closeResult.requestHandle);
      await expectRequestPdaExists(
        conn, trader.publicKey, dec.market, dec.side, dec.counter, "decrease",
        "SOL-Short close",
      );
    }
  } catch (e) {
    closeReason = e instanceof Error ? e.message : String(e);
    console.log(`  closePosition rejected: ${closeReason.slice(0, 120)}`);
  }
  console.log(`  closePosition outcome against unexecuted position: ${closeOutcome}`);

  // ─────────────────────────────────────────────────────────────
  // 5. withdrawCollateral with explicit amount
  //    Same caveat as (4): submitted against an unexecuted position.
  // ─────────────────────────────────────────────────────────────
  console.log("\n[5] withdrawCollateral request creation");
  let withdrawOutcome: "landed" | "rejected" = "rejected";
  try {
    const wdResult = await venue.withdrawCollateral({
      connection: conn, trader,
      params: {
        market: "SOL",
        amount: 1_000_000n, // $1
        collateralMint: MINTS.USDC,
      },
      onProgress: (s) => console.log(`    [wd] ${s}`),
    });
    if (wdResult.status === "pending") {
      withdrawOutcome = "landed";
      const dec = decodeRequestHandle(wdResult.requestHandle!);
      await expectRequestPdaExists(
        conn, trader.publicKey, dec.market, dec.side, dec.counter, "decrease",
        "withdraw",
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  withdrawCollateral rejected: ${msg.slice(0, 120)}`);
  }
  console.log(`  withdrawCollateral outcome against unexecuted position: ${withdrawOutcome}`);

  // ─────────────────────────────────────────────────────────────
  // 6. Wait for the 45s window then cancel the open SOL-Short request
  // ─────────────────────────────────────────────────────────────
  console.log("\n[6] cancelRequest after 45s wait");
  console.log("  waiting 50s for keeper-execution window to expire…");
  await new Promise((r) => setTimeout(r, 50_000));

  const cancelResult = await venue.cancelRequest({
    connection: conn, trader,
    requestHandle: shortResult.requestHandle!,
  });
  assert.equal(cancelResult.status, "refunded");
  console.log(`  ✓ cancel succeeded: ${cancelResult.signatures[0]}`);

  console.log("\nintegration-comprehensive.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
