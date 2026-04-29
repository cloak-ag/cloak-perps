import { SwapMode, createJupiterApiClient } from "@jup-ag/api";
import { PublicKey } from "@solana/web3.js";

const NATIVE_SOL_MINT_STR = "So11111111111111111111111111111111111111112";

/**
 * Ask Jupiter how much SOL (lamports) is required to receive at least
 * `usdcOutBase` USDC out, accounting for the configured slippage. Uses
 * Jupiter's ExactOut mode and returns `otherAmountThreshold` so the
 * caller has the worst-case ceiling (with slippage cushion) to budget.
 */
export async function quoteSolForUsdcOut(
  usdcOutBase: bigint,
  usdcMint: PublicKey,
  slippageBps: number,
  apiKey?: string,
): Promise<bigint> {
  const jup = createJupiterApiClient(apiKey ? { apiKey } : {});
  const q = await jup.quoteGet({
    inputMint: NATIVE_SOL_MINT_STR,
    outputMint: usdcMint.toBase58(),
    amount: Number(usdcOutBase),
    swapMode: SwapMode.ExactOut,
    slippageBps,
  });
  const maxIn = parseInt(q.otherAmountThreshold || q.inAmount || "0", 10);
  if (!maxIn) {
    throw new Error("Jupiter ExactOut returned 0 inAmount");
  }
  return BigInt(maxIn);
}
