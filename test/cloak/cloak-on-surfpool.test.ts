/**
 * Cloak primitives end-to-end on the local surfpool stack.
 *
 *   RPC_URL=http://127.0.0.1:18899 \
 *   CLOAK_RELAY_URL=http://127.0.0.1:15500 \
 *   CLOAK_PROGRAM_ID=CSdp6R5H4ko9y4vd5tTN6HNWqMnPuVVH7feXgiB8PSCg \
 *   W_KEYPAIR_PATH=/tmp/cloak-perps-test-W.json \
 *   npx tsx test/cloak/cloak-on-surfpool.test.ts
 *
 * Stack required (this test does NOT bring it up):
 *   - surfpool listening on RPC_URL (mainnet fork)
 *   - shield-pool fork program deployed at CLOAK_PROGRAM_ID
 *   - Cloak SOL + USDC pools initialized on the fork
 *   - Risk ALT created and registered with the relay
 *   - Relay running at CLOAK_RELAY_URL with matching ADMIN_KEYPAIR
 *
 * What this validates with REAL signed transactions:
 *   1. `fundTargetFromUsdc({ T: undefined, ... })` auto-generates T
 *      and returns the Keypair. Both Cloak legs (SOL + USDC) land on
 *      chain. T receives the requested amounts.
 *   2. `reshieldUsdc({ owner: T_from_step_1 })` re-shields part of
 *      T's USDC back into the pool. Cloak deposit tx lands.
 *   3. **WalletAdapter signer path**: wrap W in a wallet-adapter
 *      shape, run `fundTargetFromUsdc` again — proves the browser
 *      signing code path works against a real chain (not just the
 *      discriminator unit test).
 *
 * Total runtime: ~4-6 minutes (Cloak ZK proof generation per leg is
 * the slow part).
 */

import { strict as assert } from "node:assert";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

import nacl from "tweetnacl";

import { fundTargetFromUsdc, reshieldUsdc } from "../../src/cloak/index.js";
import { type WalletAdapterLike } from "../../src/cloak/lib/signer.js";
import { loadKeypair } from "../../src/node/index.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18899";
const CLOAK_RELAY_URL = process.env.CLOAK_RELAY_URL ?? "http://127.0.0.1:15500";
const CLOAK_PROGRAM_ID = process.env.CLOAK_PROGRAM_ID
  ? new PublicKey(process.env.CLOAK_PROGRAM_ID)
  : new PublicKey("CSdp6R5H4ko9y4vd5tTN6HNWqMnPuVVH7feXgiB8PSCg");
const W_PATH = process.env.W_KEYPAIR_PATH ?? "/tmp/cloak-perps-test-W.json";

const T_SOL = 0.05;
const T_USDC = 4;
const RESHIELD_USDC = 1;

function keypairToAdapter(kp: Keypair): WalletAdapterLike {
  return {
    publicKey: kp.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if ("signatures" in tx && "message" in tx) {
        (tx as VersionedTransaction).sign([kp]);
        return tx;
      }
      (tx as Transaction).partialSign(kp);
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      return Promise.all(txs.map((t) => this.signTransaction!(t)));
    },
    async signMessage(msg: Uint8Array): Promise<Uint8Array> {
      // Real ed25519 signing — what every wallet adapter does.
      return nacl.sign.detached(msg, kp.secretKey);
    },
  };
}

async function balances(conn: Connection, pubkey: PublicKey) {
  const sol = await conn.getBalance(pubkey, "confirmed");
  return { sol };
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const W = loadKeypair(W_PATH);

  console.log(`rpc=${RPC_URL}`);
  console.log(`relay=${CLOAK_RELAY_URL}`);
  console.log(`programId=${CLOAK_PROGRAM_ID.toBase58()}`);
  console.log(`W=${W.publicKey.toBase58()}\n`);

  // Sanity: relay is healthy.
  const health = await fetch(`${CLOAK_RELAY_URL}/health`).then((r) => r.json()) as { status: string };
  assert.equal(health.status, "ok", `relay unhealthy: ${JSON.stringify(health)}`);
  console.log("  ✓ relay healthy");

  const wBefore = await balances(conn, W.publicKey);
  console.log(`  W balance before: ${(wBefore.sol / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // ─────────────────────────────────────────────────────────────
  // 1. fundTargetFromUsdc with T auto-generated
  // ─────────────────────────────────────────────────────────────
  console.log(`\n[1] fundTargetFromUsdc — T auto-generated (W as Keypair signer)`);
  const fund1 = await fundTargetFromUsdc({
    connection: conn,
    W,
    // T omitted → auto-generated
    tSol: T_SOL,
    tUsdc: T_USDC,
    programId: CLOAK_PROGRAM_ID,
    relayUrl: CLOAK_RELAY_URL,
    onProgress: (stage, status) => {
      if (status.includes("confirmed") || stage.endsWith("-shield") || stage.endsWith("-withdraw")) {
        console.log(`    [${stage}] ${status.slice(0, 80)}`);
      }
    },
  });

  assert.equal(fund1.TGenerated, true, "expected T to be auto-generated");
  assert.ok(fund1.TKeypair instanceof Keypair, "expected TKeypair to be a Keypair");
  console.log(`  ✓ T auto-generated: ${fund1.T}`);
  console.log(`  ✓ T's SOL: ${(fund1.T_sol_lamports_after / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`  ✓ T's USDC: ${fund1.T_usdc_ui_after}`);
  assert.ok(fund1.T_sol_lamports_after >= T_SOL * LAMPORTS_PER_SOL * 0.99, "T didn't receive SOL");
  assert.ok(parseFloat(fund1.T_usdc_ui_after) >= T_USDC * 0.99, "T didn't receive USDC");

  const T = fund1.TKeypair;

  // ─────────────────────────────────────────────────────────────
  // 2. reshieldUsdc — T re-shields part of its USDC
  // ─────────────────────────────────────────────────────────────
  console.log(`\n[2] reshieldUsdc — T re-shields ${RESHIELD_USDC} USDC`);
  const reshield = await reshieldUsdc({
    connection: conn,
    owner: T,
    amount: RESHIELD_USDC,
    programId: CLOAK_PROGRAM_ID,
    relayUrl: CLOAK_RELAY_URL,
    onProgress: (status) => {
      if (status.includes("confirmed") || status.includes("Submit") || status.includes("Fetch")) {
        console.log(`    [reshield] ${status.slice(0, 80)}`);
      }
    },
  });
  console.log(`  ✓ tx: ${reshield.signature}`);
  console.log(`  ✓ T's USDC: ${reshield.ownerUsdcBefore} → ${reshield.ownerUsdcAfter}`);
  assert.ok(parseFloat(reshield.ownerUsdcAfter) < parseFloat(reshield.ownerUsdcBefore));

  // ─────────────────────────────────────────────────────────────
  // 3. fundTargetFromUsdc with W as a WalletAdapterLike
  //    Proves the browser-shaped signer path works through a real
  //    Cloak deposit, not just the discriminator unit test.
  // ─────────────────────────────────────────────────────────────
  console.log(`\n[3] fundTargetFromUsdc — W via WalletAdapterLike (browser path)`);
  const adapter = keypairToAdapter(W);

  const fund2 = await fundTargetFromUsdc({
    connection: conn,
    W: adapter,
    // Reuse the T we already have so we don't need fresh on-chain ATA setup
    T,
    tSol: 0.01,
    tUsdc: 0.5,
    programId: CLOAK_PROGRAM_ID,
    relayUrl: CLOAK_RELAY_URL,
    onProgress: (stage, status) => {
      if (status.includes("confirmed") || stage.endsWith("-shield") || stage.endsWith("-withdraw")) {
        console.log(`    [${stage}] ${status.slice(0, 80)}`);
      }
    },
  });
  assert.equal(fund2.TGenerated, false, "T was provided, should not be marked generated");
  console.log(`  ✓ adapter-driven fund landed: T at ${fund2.T_usdc_ui_after} USDC`);

  console.log("\ncloak-on-surfpool.test.ts: ok");
  // Cloak SDK keeps a relay subscription alive; force-exit so CI can move on.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
