/**
 * Integration test: write paths (request creation + cancellation).
 *
 *   RPC_URL=http://127.0.0.1:18899 npx tsx test/integration-writes.test.ts
 *
 * What's tested:
 *   - `openPosition` lands a `createIncreasePositionMarketRequest` tx,
 *     creating a `PositionRequest` PDA on chain. Returns a `requestHandle`.
 *   - `cancelRequest` invokes `closePositionRequest2` signed by the
 *     trader, closing the `PositionRequest` PDA and refunding funds.
 *   - `depositCollateral` (sizeUsdDelta=0 path) lands.
 *
 * What's NOT tested (and can't be on surfpool):
 *   - Keeper execution. Jupiter's keeper is off-chain and mainnet-only.
 *     On surfpool, requests are created but never executed → `Position`
 *     PDA never accumulates state. Real-mainnet smoke is the only way
 *     to validate the full open → execute → close → execute lifecycle.
 *
 * Test wallet: airdropped on the local surfpool. We use SOL collateral
 * for the SOL-Long market; for USDC we'd need a `surfnet_setTokenAccount`
 * cheatcode call to mint USDC into the trader's ATA.
 */

import { strict as assert } from "node:assert";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

import { JupiterVenue } from "../../src/jupiter/venue.js";
import { generatePositionPda, generatePositionRequestPda } from "../../src/jupiter/pdas.js";
import { decodeRequestHandle } from "../../src/jupiter/handle.js";
import { BN } from "@coral-xyz/anchor";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";

async function airdrop(conn: Connection, pubkey: PublicKey, lamports: number) {
  const sig = await conn.requestAirdrop(pubkey, lamports);
  // Surfpool's airdrop is instant; just poll until confirmed.
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const b = await conn.getBalance(pubkey, "confirmed");
    if (b >= lamports) return sig;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`airdrop didn't land for ${pubkey.toBase58()}`);
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const venue = new JupiterVenue({ rpcUrl: RPC_URL });
  const trader = Keypair.generate();
  console.log(`rpc=${RPC_URL}\ntrader=${trader.publicKey.toBase58()}\n`);

  await airdrop(conn, trader.publicKey, 5 * LAMPORTS_PER_SOL);
  const balBefore = await conn.getBalance(trader.publicKey, "confirmed");
  console.log(`  trader funded: ${balBefore / LAMPORTS_PER_SOL} SOL`);

  // ─────────────────────────────────────────────────────────────
  // 1. openPosition: SOL-Long with 0.05 SOL collateral, $50 size.
  //    We expect the request to land but the keeper to not execute
  //    (no keeper on surfpool); cancelRequest will refund.
  // ─────────────────────────────────────────────────────────────
  const openResult = await venue.openPosition({
    connection: conn,
    trader,
    params: {
      market: "SOL",
      side: "long",
      orderType: "market",
      size: "50000000", // $50 USD-6dp
      collateral: BigInt(0.05 * LAMPORTS_PER_SOL),
      collateralMint: NATIVE_MINT,
    },
    onProgress: (s) => console.log(`  [open] ${s}`),
  });
  console.log(`  open result: status=${openResult.status} sig=${openResult.signatures[0]}`);
  assert.equal(openResult.status, "pending");
  assert.ok(openResult.requestHandle, "expected requestHandle on pending result");

  // Verify PositionRequest PDA exists on chain
  const { market, side, counter } = decodeRequestHandle(openResult.requestHandle!);
  const { position } = generatePositionPda({ trader: trader.publicKey, market, side });
  const { positionRequest } = generatePositionRequestPda({
    position,
    counter: new BN(counter.toString()),
    requestChange: "increase",
  });
  const reqInfo = await conn.getAccountInfo(positionRequest, "confirmed");
  assert.ok(reqInfo !== null, "expected PositionRequest PDA to exist on chain");
  console.log(`  ✓ PositionRequest PDA created: ${positionRequest.toBase58()} (${reqInfo!.data.length}b)`);

  // ─────────────────────────────────────────────────────────────
  // 2a. cancelRequest BEFORE 45s → expected to fail with 6027.
  //     This documents the on-chain time-gate constraint.
  // ─────────────────────────────────────────────────────────────
  let earlyCancelFailed = false;
  try {
    await venue.cancelRequest({
      connection: conn,
      trader,
      requestHandle: openResult.requestHandle!,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    earlyCancelFailed = /InstructionNotAllowed|0x178b|6027/.test(msg);
    console.log(`  ✓ early cancel rejected as expected (${earlyCancelFailed ? "matches 6027" : msg.slice(0, 80)})`);
  }
  assert.ok(earlyCancelFailed, "expected early cancel to fail with InstructionNotAllowed (6027)");

  // ─────────────────────────────────────────────────────────────
  // 2b. Wait for the keeper-execution window to expire (45s + buffer).
  //     Surfpool's clock advances in real time, so this is a literal sleep.
  //     After expiry, trader-self-signed close is allowed.
  // ─────────────────────────────────────────────────────────────
  console.log("  waiting 50s for keeper-execution window to expire…");
  await new Promise((r) => setTimeout(r, 50_000));

  const cancelResult = await venue.cancelRequest({
    connection: conn,
    trader,
    requestHandle: openResult.requestHandle!,
  });
  console.log(`  cancel result: status=${cancelResult.status} sig=${cancelResult.signatures[0]}`);
  assert.equal(cancelResult.status, "refunded");

  const reqInfoAfter = await conn.getAccountInfo(positionRequest, "confirmed");
  assert.equal(reqInfoAfter, null, "expected PositionRequest PDA to be closed after cancel");
  console.log(`  ✓ PositionRequest PDA closed`);

  const balAfter = await conn.getBalance(trader.publicKey, "confirmed");
  console.log(`  trader balance after cancel: ${balAfter / LAMPORTS_PER_SOL} SOL`);
  assert.ok(balAfter > 4.9 * LAMPORTS_PER_SOL, `unexpected balance loss: ${(balBefore - balAfter) / LAMPORTS_PER_SOL} SOL`);

  // ─────────────────────────────────────────────────────────────
  // 3. depositCollateral: pure-deposit path (sizeUsdDelta=0).
  // ─────────────────────────────────────────────────────────────
  const depResult = await venue.depositCollateral({
    connection: conn,
    trader,
    params: {
      market: "SOL",
      amount: BigInt(0.01 * LAMPORTS_PER_SOL),
      collateralMint: NATIVE_MINT,
    },
    onProgress: (s) => console.log(`  [deposit] ${s}`),
  });
  console.log(`  deposit result: status=${depResult.status} sig=${depResult.signatures[0]}`);
  assert.equal(depResult.status, "pending");

  const { counter: depCounter } = decodeRequestHandle(depResult.requestHandle!);
  const { positionRequest: depPr } = generatePositionRequestPda({
    position,
    counter: new BN(depCounter.toString()),
    requestChange: "increase",
  });
  const depInfo = await conn.getAccountInfo(depPr, "confirmed");
  assert.ok(depInfo !== null, "expected deposit PositionRequest PDA to exist");
  console.log(`  ✓ deposit PositionRequest PDA created`);

  // Cleanup: cancel the deposit request after another 45s window.
  // (Skipping the wait here keeps the test under 2 minutes; the
  // request will be left dangling in the surfpool's state, which is
  // fine for a one-shot integration test.)
  console.log("  (deposit request left pending; surfpool teardown will clear)");

  console.log("\nintegration-writes.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
