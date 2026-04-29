/**
 * Anchor Program client wrapped around the vendored Jupiter perps IDL.
 * Used by `venue.ts` for ix construction. The Connection + Wallet are
 * caller-supplied so we don't smuggle keypairs through here.
 */

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";

import { IDL, type Perpetuals } from "./idl/jupiter-perpetuals-idl.js";
import { JUPITER_PERPETUALS_PROGRAM_ID } from "./constants.js";

export type JupiterProgram = Program<Perpetuals>;

export function buildProgram(connection: Connection, signer: Keypair): JupiterProgram {
  const wallet = new Wallet(signer);
  const provider = new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });
  // Anchor 0.29 typings need the IDL passed as the first arg.
  return new Program<Perpetuals>(IDL, JUPITER_PERPETUALS_PROGRAM_ID, provider);
}
