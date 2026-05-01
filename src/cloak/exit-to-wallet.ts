/**
 * Exit USDC from a wallet (typically T, the trading wallet) to any
 * destination wallet (X) — privately, via the Cloak USDC pool. This is
 * the second half of the privacy boundary: T's funds are unlinked
 * from the final destination by routing through the shielded pool.
 *
 * Two transactions inside one call:
 *
 *   1. shield: T's USDC ATA → Cloak USDC pool (creates a fresh UTXO
 *      keyed to a one-shot viewing key)
 *   2. unshield: pool → X's USDC ATA (spends that UTXO; the program
 *      verifies the spend proof, no link back to T)
 *
 * Caller (T) signs the deposit. The relay assembles the unshield —
 * no signature from T is needed for that half (it's authorized by
 * the spend-key proof).
 *
 * The destination X's USDC ATA is auto-created if missing (idempotent
 * per the SDK's fullWithdraw path).
 */

import {
  CLOAK_PROGRAM_ID,
  createUtxo,
  createZeroUtxo,
  fullWithdraw,
  generateUtxoKeypair,
  getNkFromUtxoPrivateKey,
  setCircuitsPath,
  transact,
} from "@cloak.ag/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

import { type Signer, signerPublicKey, toSdkSignerOptions } from "./lib/signer.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEFAULT_CIRCUITS = "https://cloak-circuits.s3.us-east-1.amazonaws.com/circuits/0.1.0";

export interface ExitUsdcToWalletOptions {
  connection: Connection;
  /** The wallet whose USDC is being exited. Signs the deposit half. */
  owner: Signer;
  /** Destination wallet — the unshield's recipient. Receives USDC at its ATA. */
  recipient: PublicKey;
  /** Amount of USDC to exit, in USDC units (e.g. 20 = 20 USDC). */
  amount: number;
  programId?: PublicKey;
  relayUrl?: string;
  circuitsUrl?: string;
  onProgress?: (stage: "shield" | "unshield", status: string) => void;
}

export interface ExitUsdcToWalletResult {
  shieldSignature: string;
  unshieldSignature: string;
  ownerUsdcAta: string;
  recipientUsdcAta: string;
  ownerUsdcBefore: string;
  ownerUsdcAfter: string;
  recipientUsdcAfter: string;
}

export async function exitUsdcToWallet(
  opts: ExitUsdcToWalletOptions,
): Promise<ExitUsdcToWalletResult> {
  setCircuitsPath(opts.circuitsUrl ?? DEFAULT_CIRCUITS);
  const { connection, owner, recipient, amount, onProgress } = opts;
  const ownerPubkey = signerPublicKey(owner);
  const sdkSigner = toSdkSignerOptions(owner);
  const baseUnits = BigInt(Math.floor(amount * 1_000_000));

  const ownerAta = await getAssociatedTokenAddress(USDC_MINT, ownerPubkey);
  const recipientAta = await getAssociatedTokenAddress(USDC_MINT, recipient);

  let ownerUsdcBefore = "0";
  try {
    ownerUsdcBefore = (await connection.getTokenAccountBalance(ownerAta))
      .value.uiAmountString ?? "0";
  } catch {
    throw new Error(`USDC ATA ${ownerAta.toBase58()} doesn't exist for owner`);
  }

  // Step 1: shield owner's USDC into the pool.
  const utxoKp = await generateUtxoKeypair();
  const ownerNk = getNkFromUtxoPrivateKey(utxoKp.privateKey);

  onProgress?.("shield", "starting");
  const shielded = await transact(
    {
      inputUtxos: [await createZeroUtxo(USDC_MINT)],
      outputUtxos: [await createUtxo(baseUnits, utxoKp, USDC_MINT)],
      externalAmount: baseUnits,
      depositor: ownerPubkey,
    },
    {
      connection,
      programId: opts.programId ?? CLOAK_PROGRAM_ID,
      ...(opts.relayUrl ? { relayUrl: opts.relayUrl } : {}),
      ...sdkSigner,
      chainNoteViewingKeyNk: ownerNk,
      onProgress: (s) => onProgress?.("shield", s),
    },
  );

  // Step 2: unshield the freshly-created UTXO to the recipient. No
  // edge from owner → recipient on chain — the spend is authorized by
  // the proof, not by an on-chain reference to owner.
  onProgress?.("unshield", "starting");
  const unshielded = await fullWithdraw([shielded.outputUtxos[0]], recipient, {
    connection,
    programId: opts.programId ?? CLOAK_PROGRAM_ID,
    ...(opts.relayUrl ? { relayUrl: opts.relayUrl } : {}),
    ...sdkSigner,
    chainNoteViewingKeyNk: ownerNk,
    cachedMerkleTree: shielded.merkleTree,
    onProgress: (s) => onProgress?.("unshield", s),
  });

  let ownerUsdcAfter = "0";
  try {
    ownerUsdcAfter = (await connection.getTokenAccountBalance(ownerAta))
      .value.uiAmountString ?? "0";
  } catch { /* ATA may have been closed if drained */ }

  let recipientUsdcAfter = "0";
  for (let i = 0; i < 30; i++) {
    try {
      recipientUsdcAfter = (await connection.getTokenAccountBalance(recipientAta))
        .value.uiAmountString ?? "0";
      break;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }

  return {
    shieldSignature: shielded.signature,
    unshieldSignature: unshielded.signature,
    ownerUsdcAta: ownerAta.toBase58(),
    recipientUsdcAta: recipientAta.toBase58(),
    ownerUsdcBefore,
    ownerUsdcAfter,
    recipientUsdcAfter,
  };
}
