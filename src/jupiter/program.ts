/**
 * Anchor Program client wrapped around the vendored Jupiter perps IDL.
 * Used by `venue.ts` for ix construction. The Connection + Wallet are
 * caller-supplied so we don't smuggle keypairs through here.
 */

import { AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import { IDL, type Perpetuals } from "./idl/jupiter-perpetuals-idl.js";
import { JUPITER_PERPETUALS_PROGRAM_ID } from "./constants.js";

export type JupiterProgram = Program<Perpetuals>;

/**
 * Inline Keypair → Anchor wallet shim. Anchor's `Wallet` class is
 * exported but Turbopack tree-shakes it out of the ESM dist
 * inconsistently. The shape Anchor's provider actually needs is just
 * `{ publicKey, signTransaction, signAllTransactions, payer? }`, so
 * we hand-roll it.
 */
function keypairWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    payer: kp,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof VersionedTransaction) { tx.sign([kp]); return tx; }
      (tx as Transaction).partialSign(kp);
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      return Promise.all(txs.map((t) => this.signTransaction(t)));
    },
  };
}

export function buildProgram(connection: Connection, signer: Keypair): JupiterProgram {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = new AnchorProvider(connection, keypairWallet(signer) as any, {
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });
  return new Program<Perpetuals>(IDL, JUPITER_PERPETUALS_PROGRAM_ID, provider);
}
