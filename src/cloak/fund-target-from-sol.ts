/**
 * Fund a Phoenix trader authority from a SOL-only wallet, using Cloak's
 * shielded swap to convert to USDC inside the privacy boundary.
 *
 * Three pool ops: shield total SOL → split → unshield SOL leg → shielded
 * swap (Jupiter via relay) for the USDC leg. Use this when the user
 * funds in SOL and prefers conversion inside Cloak rather than a public
 * pre-shield swap.
 *
 * Privacy property: T receives both inflows via Cloak pool unshields.
 * No on-chain edge from W to T.
 *
 * Library:
 *   import { fundTargetFromSol } from "../rise/index.js";
 *   await fundTargetFromSol({ connection, W, T, tSol: 0.05, tUsdc: 20 });
 *
 * CLI (env-driven):
 *   W_KEYPAIR_PATH=...  TARGET_KEYPAIR_PATH=...
 *   SOLANA_RPC_URL=https://your-mainnet-rpc
 *   T_SOL=0.05 T_USDC=20
 *   npx tsx src/fund-target-from-sol.ts
 */

import {
  CLOAK_PROGRAM_ID,
  NATIVE_SOL_MINT,
  createUtxo,
  createZeroUtxo,
  fullWithdraw,
  generateUtxoKeypair,
  getNkFromUtxoPrivateKey,
  setCircuitsPath,
  swapWithChange,
  transact,
} from "@cloak.ag/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

import { preCloakFee } from "./lib/fees.js";
import { quoteSolForUsdcOut } from "./lib/jupiter-quote.js";
import { type Signer, signerPublicKey, toSdkSignerOptions } from "./lib/signer.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEFAULT_CIRCUITS = "https://cloak-circuits.s3.us-east-1.amazonaws.com/circuits/0.1.0";
const DEFAULT_SLIPPAGE_BPS = 1500;

export interface FundTargetFromSolOptions {
  connection: Connection;
  /** Funding wallet. Either a Keypair (script) or a wallet adapter (browser). */
  W: Signer;
  /**
   * Target wallet (Keypair). Optional — auto-generated if absent and
   * returned in the result. Caller persists locally; SDK never transmits.
   */
  T?: Keypair;
  /** Exact SOL delivered to T after Cloak fee. */
  tSol: number;
  /** Minimum USDC delivered to T's ATA (Jupiter ExactOut sizes the swap input). */
  tUsdc: number;
  /** Slippage tolerance in bps. Default 1500 (15%) — relay routes through
   *  direct Jupiter routes only, so wider slippage is more permissive. */
  slippageBps?: number;
  /** Optional Jupiter API key for higher rate limits. */
  jupiterApiKey?: string;
  /** Override the Cloak shield-pool program id. Defaults to mainnet. */
  programId?: PublicKey;
  /** Override the Cloak relay URL. Defaults to https://api.cloak.ag. */
  relayUrl?: string;
  circuitsUrl?: string;
  onProgress?: (stage: string, status: string) => void;
}

export interface FundTargetResult {
  W: string;
  T: string;
  TKeypair: Keypair;
  TGenerated: boolean;
  T_usdc_ata: string;
  T_sol_lamports_after: number;
  T_usdc_ui_after: string;
  direct_W_to_T_transfers: 0;
}

export async function fundTargetFromSol(opts: FundTargetFromSolOptions): Promise<FundTargetResult> {
  setCircuitsPath(opts.circuitsUrl ?? DEFAULT_CIRCUITS);
  const {
    connection, W, tSol, tUsdc,
    slippageBps = DEFAULT_SLIPPAGE_BPS, jupiterApiKey, onProgress,
  } = opts;
  const TGenerated = opts.T === undefined;
  const T: Keypair = opts.T ?? Keypair.generate();
  const wPubkey = signerPublicKey(W);
  const sdkSigner = toSdkSignerOptions(W);

  const tSolLamports = BigInt(Math.round(tSol * 1_000_000_000));
  const tUsdcBase = BigInt(Math.round(tUsdc * 1_000_000));

  // Size the legs: Jupiter ExactOut for the swap, gross-up for both Cloak fees.
  const swapPostFeeSol = await quoteSolForUsdcOut(
    tUsdcBase, USDC_MINT, slippageBps, jupiterApiKey ?? process.env.JUPITER_API_KEY,
  );
  const swapPreFeeSol = preCloakFee(swapPostFeeSol);
  const tSolPreFee = preCloakFee(tSolLamports);
  const shieldLamports = tSolPreFee + swapPreFeeSol;

  const tUsdcAta = await getAssociatedTokenAddress(USDC_MINT, T.publicKey);

  // Pre-flight balance check.
  const wSol = await connection.getBalance(wPubkey);
  const minSol = Number(shieldLamports) + 100_000_000; // shield + ~0.1 SOL for tx fees
  if (wSol < minSol) {
    throw new Error(
      `W underfunded: ${wSol} lamports, need ≥ ${minSol} ` +
      `(${shieldLamports} for both shielded legs + ~0.1 SOL for tx fees)`,
    );
  }

  // Shield total.
  const utxoKp = await generateUtxoKeypair();
  const wNk = getNkFromUtxoPrivateKey(utxoKp.privateKey);
  onProgress?.("shield", "starting");
  const dep = await transact(
    {
      inputUtxos: [await createZeroUtxo()],
      outputUtxos: [await createUtxo(shieldLamports, utxoKp, NATIVE_SOL_MINT)],
      externalAmount: shieldLamports,
      depositor: wPubkey,
    },
    {
      connection, programId: opts.programId ?? CLOAK_PROGRAM_ID, ...(opts.relayUrl ? { relayUrl: opts.relayUrl } : {}), ...sdkSigner,
      chainNoteViewingKeyNk: wNk,
      onProgress: (s) => onProgress?.("shield", s),
    },
  );

  // Split into (T-SOL leg, swap leg).
  const feeKp = await generateUtxoKeypair();
  const feeNk = getNkFromUtxoPrivateKey(feeKp.privateKey);
  const split = await transact(
    {
      inputUtxos: [dep.outputUtxos[0]],
      outputUtxos: [
        await createUtxo(tSolPreFee, feeKp, NATIVE_SOL_MINT),
        await createUtxo(dep.outputUtxos[0].amount - tSolPreFee, utxoKp, NATIVE_SOL_MINT),
      ],
      externalAmount: BigInt(0),
    },
    {
      connection, programId: opts.programId ?? CLOAK_PROGRAM_ID, ...(opts.relayUrl ? { relayUrl: opts.relayUrl } : {}), ...sdkSigner,
      chainNoteViewingKeyNk: wNk, cachedMerkleTree: dep.merkleTree,
      onProgress: (s) => onProgress?.("split", s),
    },
  );
  const feeNote = split.outputUtxos.find((u) => u.amount === tSolPreFee)!;
  const swapNote = split.outputUtxos.find((u) => u.amount !== tSolPreFee)!;

  // Unshield T_SOL → T.
  onProgress?.("sol-withdraw", "submitting");
  const wd = await fullWithdraw([feeNote], T.publicKey, {
    connection, programId: opts.programId ?? CLOAK_PROGRAM_ID, ...(opts.relayUrl ? { relayUrl: opts.relayUrl } : {}), ...sdkSigner,
    chainNoteViewingKeyNk: feeNk, cachedMerkleTree: split.merkleTree,
    onProgress: (s) => onProgress?.("sol-withdraw", s),
  });

  // Shielded swap → USDC ATA, with minOut = T_USDC.
  onProgress?.("swap", "submitting");
  await swapWithChange(
    [swapNote], swapNote.amount, USDC_MINT, tUsdcAta, tUsdcBase,
    {
      connection, programId: opts.programId ?? CLOAK_PROGRAM_ID, ...(opts.relayUrl ? { relayUrl: opts.relayUrl } : {}), ...sdkSigner,
      chainNoteViewingKeyNk: wNk, cachedMerkleTree: wd.merkleTree,
      swapSlippageBps: slippageBps,
      onProgress: (s) => onProgress?.("swap", s),
    },
    T.publicKey,
  );

  const tSolAfter = await connection.getBalance(T.publicKey);
  let tUsdcAfter = "0";
  for (let i = 0; i < 30; i++) {
    try {
      tUsdcAfter = (await connection.getTokenAccountBalance(tUsdcAta)).value.uiAmountString ?? "0";
      break;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }

  return {
    W: wPubkey.toBase58(),
    T: T.publicKey.toBase58(),
    TKeypair: T,
    TGenerated,
    T_usdc_ata: tUsdcAta.toBase58(),
    T_sol_lamports_after: tSolAfter,
    T_usdc_ui_after: tUsdcAfter,
    direct_W_to_T_transfers: 0,
  };
}
