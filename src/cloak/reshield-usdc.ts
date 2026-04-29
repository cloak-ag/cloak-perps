/**
 * Re-shield USDC sitting in a wallet's USDC ATA back into the Cloak USDC
 * pool. Same `transact` primitive as a SOL shield, routed at the USDC pool
 * by passing the USDC mint to `createZeroUtxo` and `createUtxo`.
 *
 * Library:
 *   import { reshieldUsdc } from "../rise/index.js";
 *   await reshieldUsdc({ connection, owner, amount: 20 });
 *
 * CLI (env-driven):
 *   KEYPAIR_PATH=/path/to/T.json
 *   SOLANA_RPC_URL=https://your-mainnet-rpc
 *   RESHIELD_USDC=20
 *   npx tsx src/reshield-usdc.ts
 */

import {
  CLOAK_PROGRAM_ID,
  createUtxo,
  createZeroUtxo,
  generateUtxoKeypair,
  getNkFromUtxoPrivateKey,
  setCircuitsPath,
  transact,
} from "@cloak.ag/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

import { type Signer, signerPublicKey, toSdkSignerOptions } from "./lib/signer.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEFAULT_CIRCUITS = "https://cloak-circuits.s3.us-east-1.amazonaws.com/circuits/0.1.0";

export interface ReshieldUsdcOptions {
  connection: Connection;
  /** Wallet whose USDC is being re-shielded; signs the deposit tx.
   *  Either a Keypair (script) or a wallet adapter (browser). */
  owner: Signer;
  /** Amount of USDC to re-shield, in USDC units (e.g. 20 = 20 USDC). */
  amount: number;
  circuitsUrl?: string;
  /** Override the Cloak shield-pool program id. Defaults to mainnet. */
  programId?: PublicKey;
  /** Override the Cloak relay URL. Defaults to https://api.cloak.ag. */
  relayUrl?: string;
  onProgress?: (status: string) => void;
}

export interface ReshieldUsdcResult {
  signature: string;
  commitmentIndices: [number, number];
  utxoIndex?: number;
  ownerUsdcAta: string;
  ownerUsdcBefore: string;
  ownerUsdcAfter: string;
}

export async function reshieldUsdc(opts: ReshieldUsdcOptions): Promise<ReshieldUsdcResult> {
  setCircuitsPath(opts.circuitsUrl ?? DEFAULT_CIRCUITS);
  const { connection, owner, amount, onProgress } = opts;
  const ownerPubkey = signerPublicKey(owner);
  const sdkSigner = toSdkSignerOptions(owner);

  const ownerAta = await getAssociatedTokenAddress(USDC_MINT, ownerPubkey);
  const baseUnits = BigInt(Math.floor(amount * 1_000_000));

  let ownerUsdcBefore: string;
  try {
    ownerUsdcBefore = (await connection.getTokenAccountBalance(ownerAta))
      .value.uiAmountString ?? "0";
  } catch {
    throw new Error(`USDC ATA ${ownerAta.toBase58()} doesn't exist`);
  }

  const utxoKp = await generateUtxoKeypair();
  const ownerNk = getNkFromUtxoPrivateKey(utxoKp.privateKey);

  const result = await transact(
    {
      inputUtxos: [await createZeroUtxo(USDC_MINT)],
      outputUtxos: [await createUtxo(baseUnits, utxoKp, USDC_MINT)],
      externalAmount: baseUnits,
      depositor: ownerPubkey,
    },
    {
      connection, programId: opts.programId ?? CLOAK_PROGRAM_ID, ...(opts.relayUrl ? { relayUrl: opts.relayUrl } : {}), ...sdkSigner,
      chainNoteViewingKeyNk: ownerNk,
      onProgress,
    },
  );

  let ownerUsdcAfter = "0";
  try {
    ownerUsdcAfter = (await connection.getTokenAccountBalance(ownerAta))
      .value.uiAmountString ?? "0";
  } catch { /* ATA may have closed if drained */ }

  return {
    signature: result.signature,
    commitmentIndices: result.commitmentIndices,
    utxoIndex: result.outputUtxos[0].index,
    ownerUsdcAta: ownerAta.toBase58(),
    ownerUsdcBefore,
    ownerUsdcAfter,
  };
}
