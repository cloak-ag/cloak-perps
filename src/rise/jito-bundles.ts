/**
 * Jito-bundle helpers for the Phoenix half of the integration.
 *
 * Two bundles are useful here:
 *
 *   1. **Entry bundle** — Phoenix Ember+DepositFunds + Phoenix
 *      place_limit_order, atomic. Either both transactions land in the
 *      same slot or neither does. Eliminates the (small but real) window
 *      where the trader has fresh collateral but no order on the book.
 *
 *   2. **Exit bundle** — Phoenix cancel_all + Phoenix
 *      WithdrawFunds+Ember-w, atomic. Either you cancel and exit
 *      together, or the cancel doesn't land. Useful when you want to
 *      guarantee no orders rest on the book after you've already
 *      decided to drain collateral.
 *
 * Both bundle helpers attach a Jito tip to the LAST tx of the bundle as
 * a SystemProgram.transfer ix.
 *
 * The Cloak<->Phoenix boundary itself (Cloak unshield + Phoenix entry)
 * cannot be bundled from the client because Cloak's relay assembles and
 * submits the unshield tx server-side; we never see the signed wire
 * bytes. Lifting that constraint is a relay-side change.
 */

import {
  Side as PhoenixSide,
  buildEmberWithdrawIx as buildEmberWithdrawIxRaw,
  createPhoenixClient,
  type Authority,
  type Symbol as PhoenixSymbol,
} from "@ellipsis-labs/rise";
// `buildEmberWithdrawIx` is namespaced under `flight`-style runtime export
// indirections in some versions of @ellipsis-labs/rise. Typed import above
// works against the .d.ts; ignore lint here if the runtime symbol moves.
import { type IInstruction, type KeyPairSigner } from "@solana/kit";
import { Keypair as Web3Keypair } from "@solana/web3.js";

import { buildSignedTx } from "./lib/kit-send.js";
import { web3KeypairToKitSigner } from "./lib/kit-signer.js";
import {
  JITO_BLOCK_ENGINE_DEFAULT,
  buildJitoTipIx,
  sendJitoBundle,
  waitForJitoBundle,
} from "./lib/jito.js";

const DEFAULT_API_URL = "https://perp-api.phoenix.trade";
const DEFAULT_TIP_LAMPORTS = 1_000_000; // 0.001 SOL — busy-market floor

async function asKitSigner(T: Web3Keypair | KeyPairSigner): Promise<KeyPairSigner> {
  if ("address" in T) return T;
  return web3KeypairToKitSigner(T);
}

// ─────────────────────────────────────────────────────────────────────────
// ENTRY bundle: Ember+DepositFunds + place_limit_order
// ─────────────────────────────────────────────────────────────────────────

export interface BundlePhoenixEntryOptions {
  rpcUrl: string;
  apiUrl?: string;
  jitoEndpoint?: string;
  /** Trader authority. */
  T: Web3Keypair | KeyPairSigner;
  /** USDC to deposit before placing. */
  depositUsdc: number;
  /** Limit-order shape. */
  symbol: string;
  side: "bid" | "ask";
  priceUsd: number;
  baseUnits: string;
  /** Jito tip in lamports (default 1_000_000 = 0.001 SOL). */
  tipLamports?: number;
  onProgress?: (status: string) => void;
}

export interface JitoBundleResult {
  bundleId: string;
  txSignatures: string[];
  /** Status from polling the Block Engine. */
  status: "Landed" | "Pending" | "Failed" | "Invalid" | "unknown";
  slot?: number;
}

export async function bundlePhoenixEntry(opts: BundlePhoenixEntryOptions): Promise<JitoBundleResult> {
  const signer = await asKitSigner(opts.T);
  const authority = signer.address as Authority;
  const symbol = opts.symbol as PhoenixSymbol;
  const tip = opts.tipLamports ?? DEFAULT_TIP_LAMPORTS;

  const client = createPhoenixClient({
    apiUrl: opts.apiUrl ?? DEFAULT_API_URL,
    rpcUrl: opts.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  try {
    await client.exchange.ready();

    opts.onProgress?.("building deposit");
    const dep = await client.ixs.buildDepositIxs({
      authority,
      amount: BigInt(Math.round(opts.depositUsdc * 1_000_000)),
    });

    opts.onProgress?.("building place");
    const orderPacket = await client.orderPackets.buildLimitOrderPacket({
      symbol: opts.symbol,
      side: opts.side === "bid" ? PhoenixSide.Bid : PhoenixSide.Ask,
      priceUsd: opts.priceUsd.toString(),
      baseUnits: opts.baseUnits,
    });
    const placeIx = await client.ixs.buildPlaceLimitOrder({ authority, symbol, orderPacket });

    opts.onProgress?.("signing");
    const tx1 = await buildSignedTx({
      rpcUrl: opts.rpcUrl, signer,
      instructions: [...dep.instructions],
    });
    const tx2 = await buildSignedTx({
      rpcUrl: opts.rpcUrl, signer,
      // Append the Jito tip to the LAST tx in the bundle.
      instructions: [placeIx, buildJitoTipIx(signer.address, tip)],
    });

    opts.onProgress?.("submitting bundle");
    const bundleId = await sendJitoBundle({
      endpoint: opts.jitoEndpoint,
      base64SignedTxs: [tx1.base64, tx2.base64],
    });
    opts.onProgress?.(`bundle ${bundleId} submitted; waiting for landing`);
    const final = await waitForJitoBundle(bundleId, { endpoint: opts.jitoEndpoint });
    return {
      bundleId,
      txSignatures: [tx1.signature, tx2.signature],
      status: final.status,
      slot: final.slot,
    };
  } finally {
    client.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EXIT bundle: cancel_all + WithdrawFunds + Ember-w
// ─────────────────────────────────────────────────────────────────────────

export interface BundlePhoenixExitOptions {
  rpcUrl: string;
  apiUrl?: string;
  jitoEndpoint?: string;
  T: Web3Keypair | KeyPairSigner;
  /** Symbol to cancel orders on. */
  symbol: string;
  /** USDC amount to withdraw. */
  withdrawUsdc: number;
  tipLamports?: number;
  onProgress?: (status: string) => void;
}

export async function bundlePhoenixExit(opts: BundlePhoenixExitOptions): Promise<JitoBundleResult> {
  const signer = await asKitSigner(opts.T);
  const authority = signer.address as Authority;
  const symbol = opts.symbol as PhoenixSymbol;
  const amount = BigInt(Math.round(opts.withdrawUsdc * 1_000_000));
  const tip = opts.tipLamports ?? DEFAULT_TIP_LAMPORTS;

  const client = createPhoenixClient({
    apiUrl: opts.apiUrl ?? DEFAULT_API_URL,
    rpcUrl: opts.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  try {
    await client.exchange.ready();

    opts.onProgress?.("building cancel");
    const cancelIx = await client.ixs.buildCancelAll({ authority, symbol });

    opts.onProgress?.("building withdraw");
    const wd = await client.ixs.buildWithdrawIxs({ authority, amount });
    // Apply the same Ember-w workaround as phoenix-lifecycle.ts.
    const broken = wd.named.emberWithdraw as unknown as {
      accounts: ReadonlyArray<{ address: string }>;
    };
    const fixedEmberWithdraw = buildEmberWithdrawIxRaw({
      owner:        broken.accounts[0]!.address as never,
      emberState:   broken.accounts[1]!.address as never,
      inputMint:    broken.accounts[3]!.address as never,
      outputMint:   broken.accounts[2]!.address as never,
      inputTokenAccount:  broken.accounts[5]!.address as never,
      outputTokenAccount: broken.accounts[4]!.address as never,
      emberVault:   broken.accounts[6]!.address as never,
      amount,
    });
    const fixedWithdrawInstructions: IInstruction[] = [...wd.instructions];
    fixedWithdrawInstructions[fixedWithdrawInstructions.length - 1] = fixedEmberWithdraw;

    opts.onProgress?.("signing");
    const tx1 = await buildSignedTx({
      rpcUrl: opts.rpcUrl, signer,
      instructions: [cancelIx],
    });
    const tx2 = await buildSignedTx({
      rpcUrl: opts.rpcUrl, signer,
      instructions: [...fixedWithdrawInstructions, buildJitoTipIx(signer.address, tip)],
    });

    opts.onProgress?.("submitting bundle");
    const bundleId = await sendJitoBundle({
      endpoint: opts.jitoEndpoint,
      base64SignedTxs: [tx1.base64, tx2.base64],
    });
    opts.onProgress?.(`bundle ${bundleId} submitted; waiting for landing`);
    const final = await waitForJitoBundle(bundleId, { endpoint: opts.jitoEndpoint });
    return {
      bundleId,
      txSignatures: [tx1.signature, tx2.signature],
      status: final.status,
      slot: final.slot,
    };
  } finally {
    client.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────
