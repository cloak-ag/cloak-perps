import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type IInstruction,
  type KeyPairSigner,
} from "@solana/kit";

export interface SendIxsOptions {
  rpcUrl: string;
  signer: KeyPairSigner;
  instructions: IInstruction[];
  /** Confirmation poll budget. Defaults to 60s. */
  confirmTimeoutSecs?: number;
}

/**
 * Build and sign a v0 transaction with the given kit instructions.
 * Returns the transaction signature (base58) and the wire-encoded
 * base64 transaction body, suitable for sending or bundling.
 */
export async function buildSignedTx(opts: {
  rpcUrl: string;
  signer: KeyPairSigner;
  instructions: IInstruction[];
}): Promise<{ signature: string; base64: string }> {
  const rpc = createSolanaRpc(opts.rpcUrl);
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(opts.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(opts.instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return {
    signature: getSignatureFromTransaction(signed),
    base64: getBase64EncodedWireTransaction(signed),
  };
}

/**
 * Build, sign, send, and confirm a v0 transaction with the given kit
 * instructions. Pure `@solana/kit` — no `@solana/web3.js` Connection needed.
 *
 * Returns the transaction signature (base58).
 */
export async function sendIxs(opts: SendIxsOptions): Promise<string> {
  const { rpcUrl, signer, instructions, confirmTimeoutSecs = 60 } = opts;
  const rpc = createSolanaRpc(rpcUrl);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);

  try {
    await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  } catch (e: any) {
    const ctx = e?.context ?? {};
    const logs = ctx.logs ?? ctx?.__serverMessage?.data?.logs;
    if (logs?.length) {
      console.error("--- preflight logs ---");
      for (const l of logs) console.error(l);
      console.error("----------------------");
    }
    throw e;
  }

  for (let i = 0; i < confirmTimeoutSecs; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) {
      throw new Error(`tx ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${signature} not confirmed within ${confirmTimeoutSecs}s`);
}
