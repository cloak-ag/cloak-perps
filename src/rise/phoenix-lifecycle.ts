/**
 * Run the Phoenix trader lifecycle on a wallet that already holds SOL
 * (for tx fees) and USDC (for collateral). Pure TypeScript on top of
 * `@ellipsis-labs/rise`.
 *
 *   1. Ember + DepositFunds (USDC → trader collateral)
 *   2. place a limit order on `symbol`
 *   3. cancel all open orders on `symbol`
 *   4. WithdrawFunds + Ember-w (collateral → USDC ATA)
 *
 * Library:
 *   import { phoenixLifecycle } from "../rise/index.js";
 *   await phoenixLifecycle({ rpcUrl, T, depositUsdc: 20, symbol: "SOL", ... });
 *
 * CLI (env-driven):
 *   KEYPAIR_PATH=/path/to/T.json
 *   SOLANA_RPC_URL=https://your-mainnet-rpc
 *   DEPOSIT_USDC=20 SYMBOL=SOL SIDE=bid PRICE_USD=50 BASE_UNITS=0.01
 *   npx tsx src/phoenix-lifecycle.ts
 */

import {
  Side as PhoenixSide,
  buildEmberWithdrawIx,
  createPhoenixClient,
  type Authority,
  type PhoenixClient,
  type Symbol as PhoenixSymbol,
} from "@ellipsis-labs/rise";
import { type IInstruction, type KeyPairSigner } from "@solana/kit";
import { Keypair as Web3Keypair } from "@solana/web3.js";

import { sendIxs } from "./lib/kit-send.js";
import { web3KeypairToKitSigner } from "./lib/kit-signer.js";

const DEFAULT_API_URL = "https://perp-api.phoenix.trade";

export interface PhoenixLifecycleOptions {
  /** Solana mainnet RPC URL. */
  rpcUrl: string;
  /** Phoenix HTTP API. Defaults to mainnet. */
  apiUrl?: string;
  /** Trader authority — either a web3.js Keypair or a kit signer. Must be
   *  a pre-registered Phoenix trader and hold SOL for tx fees + USDC for
   *  collateral in its USDC ATA. */
  T: Web3Keypair | KeyPairSigner;
  /** USDC amount to deposit into the trader (and later withdraw). */
  depositUsdc: number;
  /** Phoenix market symbol (e.g. "SOL", "BTC"). */
  symbol: string;
  /** Order side. */
  side: "bid" | "ask";
  /** Order price in USD (passed to Rise's order-packet builder). */
  priceUsd: number;
  /** Order size in base units (e.g. "0.01" for 0.01 SOL). */
  baseUnits: string;
  /** Optional pre-built Phoenix client. If provided, the lifecycle reuses it
   *  and does NOT dispose it — caller owns the lifetime. Useful for soak
   *  loops where re-fetching exchange metadata every iteration is wasteful
   *  and exposes the run to perp-api transients. */
  client?: PhoenixClient;
  onProgress?: (stage: string, status: string) => void;
}

export interface PhoenixLifecycleResult {
  authority: string;
  symbol: string;
  depositSig: string;
  placeSig: string;
  cancelSig: string;
  withdrawSig: string;
}

async function asKitSigner(T: Web3Keypair | KeyPairSigner): Promise<KeyPairSigner> {
  if ("address" in T) return T;
  return web3KeypairToKitSigner(T);
}

export async function phoenixLifecycle(opts: PhoenixLifecycleOptions): Promise<PhoenixLifecycleResult> {
  const signer = await asKitSigner(opts.T);
  const authority = signer.address as Authority;
  const symbol = opts.symbol as PhoenixSymbol;

  const ownsClient = opts.client === undefined;
  const client = opts.client ?? createPhoenixClient({
    apiUrl: opts.apiUrl ?? DEFAULT_API_URL,
    rpcUrl: opts.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  try {
    if (ownsClient) await client.exchange.ready();

    const amount = BigInt(Math.round(opts.depositUsdc * 1_000_000));
    const send = (instructions: IInstruction[]) =>
      sendIxs({ rpcUrl: opts.rpcUrl, signer, instructions });

    // 1. Ember + DepositFunds
    opts.onProgress?.("deposit", "building");
    const depositIxs = await client.ixs.buildDepositIxs({ authority, amount });
    opts.onProgress?.("deposit", "submitting");
    const depositSig = await send(depositIxs.instructions);
    opts.onProgress?.("deposit", `confirmed ${depositSig}`);

    // 2. place limit order
    opts.onProgress?.("place", "building");
    const orderPacket = await client.orderPackets.buildLimitOrderPacket({
      symbol: opts.symbol,
      side: opts.side === "bid" ? PhoenixSide.Bid : PhoenixSide.Ask,
      priceUsd: opts.priceUsd.toString(),
      baseUnits: opts.baseUnits,
    });
    const placeIx = await client.ixs.buildPlaceLimitOrder({
      authority,
      symbol,
      orderPacket,
    });
    opts.onProgress?.("place", "submitting");
    const placeSig = await send([placeIx]);
    opts.onProgress?.("place", `confirmed ${placeSig}`);

    // 3. cancel all open orders on this market
    opts.onProgress?.("cancel", "building");
    const cancelIx = await client.ixs.buildCancelAll({ authority, symbol });
    opts.onProgress?.("cancel", "submitting");
    const cancelSig = await send([cancelIx]);
    opts.onProgress?.("cancel", `confirmed ${cancelSig}`);

    // 4. WithdrawFunds + Ember-w
    opts.onProgress?.("withdraw", "building");
    const withdrawIxs = await client.ixs.buildWithdrawIxs({ authority, amount });
    // ── workaround for @ellipsis-labs/rise@0.4.8: buildEmberWithdrawIxResolved
    //    swaps input/output mint+ATA. On-chain Ember layout is fixed (see
    //    rise-public Rust SDK ember_withdraw.rs:188): pos 3 = USDC, pos 4 =
    //    canonical, pos 5 = USDC ATA, pos 6 = phoenix ATA — same for deposit
    //    and withdraw. Rebuild the ix with the slots un-swapped.
    const broken = withdrawIxs.named.emberWithdraw as { accounts: ReadonlyArray<{ address: string }> };
    const fixedEmberWithdraw = buildEmberWithdrawIx({
      owner:        broken.accounts[0]!.address as Authority,
      emberState:   broken.accounts[1]!.address as never,
      inputMint:    broken.accounts[3]!.address as never, // un-swap: SDK had outputMint=usdc here
      outputMint:   broken.accounts[2]!.address as never, // un-swap: SDK had inputMint=canonical
      inputTokenAccount:  broken.accounts[5]!.address as never, // un-swap: SDK had outputTokenAccount=usdc-ATA
      outputTokenAccount: broken.accounts[4]!.address as never, // un-swap: SDK had inputTokenAccount=phoenix-ATA
      emberVault:   broken.accounts[6]!.address as never,
      amount,
    });
    const fixedInstructions: IInstruction[] = [...withdrawIxs.instructions];
    fixedInstructions[fixedInstructions.length - 1] = fixedEmberWithdraw;
    opts.onProgress?.("withdraw", "submitting");
    const withdrawSig = await send(fixedInstructions);
    opts.onProgress?.("withdraw", `confirmed ${withdrawSig}`);

    return {
      authority: authority.toString(),
      symbol: opts.symbol,
      depositSig,
      placeSig,
      cancelSig,
      withdrawSig,
    };
  } finally {
    if (ownsClient) client.dispose();
  }
}
