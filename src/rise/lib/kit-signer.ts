import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import type { Keypair as Web3Keypair } from "@solana/web3.js";

/**
 * Convert a `@solana/web3.js` Keypair (used by `@cloak.dev/sdk`) into a
 * `@solana/kit` KeyPairSigner (used by `@ellipsis-labs/rise`). Lets one
 * keypair sign on both sides of the integration.
 */
export async function web3KeypairToKitSigner(kp: Web3Keypair): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(kp.secretKey);
}
