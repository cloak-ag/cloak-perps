/**
 * Signer abstraction — bridges programmatic (Keypair) and browser
 * (wallet-adapter) signing for the Cloak primitives.
 *
 *   - CLI / scripts: pass a `Keypair`, signs in-process.
 *   - Browser apps:  pass a wallet-adapter object (Phantom / Backpack /
 *     anything compatible with `@solana/wallet-adapter-base`'s shape:
 *     `{ publicKey, signTransaction, signAllTransactions }`).
 *
 * The Cloak SDK's `transact()` already accepts both — this module just
 * provides the discriminator and the params-mapping helper so consumers
 * don't have to know the SDK's option shape.
 */

import {
  Keypair,
  type PublicKey,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

/**
 * Wallet-adapter-shaped signer. Compatible with `@solana/wallet-adapter-base`
 * (Phantom, Backpack, Solflare, etc).
 *
 * `signMessage` is optional but recommended — without it, Cloak's
 * viewing-key registration will fall back to a less convenient flow.
 */
export interface WalletAdapterLike {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  signMessage?(msg: Uint8Array): Promise<Uint8Array>;
}

/** Either a Keypair (script-managed) or a wallet-adapter (browser). */
export type Signer = Keypair | WalletAdapterLike;

/** Type-narrow: is this signer a `Keypair` (i.e. holds the secret key)? */
export function isKeypair(s: Signer): s is Keypair {
  return s instanceof Keypair || (s as { secretKey?: unknown }).secretKey !== undefined;
}

/** Get the public key of a signer regardless of shape. */
export function signerPublicKey(s: Signer): PublicKey {
  return s.publicKey as PublicKey;
}

/**
 * Map a `Signer` onto the Cloak SDK's `TransactOptions` partial:
 *   - Keypair  → `{ depositorKeypair, walletPublicKey }`  (in-process signing)
 *   - Adapter  → `{ signTransaction, signMessage?, depositorPublicKey, walletPublicKey }`
 *
 * Pass the result alongside whatever other `TransactOptions` you set
 * (connection, programId, relayUrl, etc.). The SDK uses `depositorKeypair`
 * if present and falls back to `signTransaction` otherwise.
 */
export interface SdkSignerOptions {
  depositorKeypair?: Keypair;
  signTransaction?: WalletAdapterLike["signTransaction"];
  signMessage?: WalletAdapterLike["signMessage"];
  depositorPublicKey?: PublicKey;
  walletPublicKey: PublicKey;
}

export function toSdkSignerOptions(s: Signer): SdkSignerOptions {
  const pubkey = signerPublicKey(s);
  if (isKeypair(s)) {
    return { depositorKeypair: s, walletPublicKey: pubkey };
  }
  return {
    signTransaction: s.signTransaction.bind(s),
    signMessage: s.signMessage?.bind(s),
    depositorPublicKey: pubkey,
    walletPublicKey: pubkey,
  };
}
