/**
 * One-call composition: fund T from Cloak (Case A or Case B) → run the
 * Phoenix lifecycle → re-shield exited USDC into the Cloak USDC pool.
 *
 * Library:
 *   import { fullPipeline } from "../rise/index.js";
 *   await fullPipeline({ ... });
 *
 * CLI (env-driven):
 *   W_KEYPAIR_PATH=...  TARGET_KEYPAIR_PATH=...
 *   SOLANA_RPC_URL=https://your-mainnet-rpc
 *   T_SOL=0.05  T_USDC=20
 *   DEPOSIT_USDC=20  RESHIELD_USDC=20
 *   SYMBOL=SOL  SIDE=bid  PRICE_USD=50  BASE_UNITS=0.01
 *   USE_SWAP=0  # 1 to use the SOL→USDC shielded swap path (Case B)
 *   npx tsx src/full-pipeline.ts
 */

import {
  fundTargetFromSol,
  fundTargetFromUsdc,
  reshieldUsdc,
  type FundTargetFromSolResult,
  type FundTargetFromUsdcResult,
  type ReshieldUsdcResult,
} from "../cloak/index.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { PhoenixClient } from "@ellipsis-labs/rise";

import { phoenixLifecycle, type PhoenixLifecycleResult } from "./phoenix-lifecycle.js";

export interface FullPipelineOptions {
  rpcUrl: string;
  apiUrl?: string;
  /** Override Cloak shield-pool program id. Defaults to mainnet. */
  cloakProgramId?: PublicKey;
  /** Override Cloak relay URL. Defaults to https://api.cloak.ag. */
  cloakRelayUrl?: string;
  W: Keypair;
  T: Keypair;
  /** Funding mode. "usdc" (Case A) is preferred when W already holds USDC. */
  fundingMode: "usdc" | "sol";
  /** SOL to deliver to T (post-fee, exact). */
  tSol: number;
  /** USDC to deliver to T (≥, post-fee). */
  tUsdc: number;
  /** USDC the Phoenix step deposits into the trader. */
  depositUsdc: number;
  /** USDC the exit step re-shields into the Cloak USDC pool. */
  reshieldUsdc: number;
  /** Limit-order shape. */
  symbol: string;
  side: "bid" | "ask";
  priceUsd: number;
  baseUnits: string;
  /** Optional pre-built Phoenix client (caller owns lifetime). */
  phoenixClient?: PhoenixClient;
  onProgress?: (stage: string, status: string) => void;
}

export interface FullPipelineResult {
  fund: FundTargetFromUsdcResult | FundTargetFromSolResult;
  phoenix: PhoenixLifecycleResult;
  reshield: ReshieldUsdcResult;
}

export async function fullPipeline(opts: FullPipelineOptions): Promise<FullPipelineResult> {
  const connection = new Connection(opts.rpcUrl, "confirmed");

  // 1. Cloak — fund T privately from W.
  opts.onProgress?.("fund", `starting ${opts.fundingMode}`);
  const fund =
    opts.fundingMode === "usdc"
      ? await fundTargetFromUsdc({
          connection, W: opts.W, T: opts.T,
          tSol: opts.tSol, tUsdc: opts.tUsdc,
          programId: opts.cloakProgramId, relayUrl: opts.cloakRelayUrl,
          onProgress: opts.onProgress,
        })
      : await fundTargetFromSol({
          connection, W: opts.W, T: opts.T,
          tSol: opts.tSol, tUsdc: opts.tUsdc,
          programId: opts.cloakProgramId, relayUrl: opts.cloakRelayUrl,
          onProgress: opts.onProgress,
        });

  // 2. Phoenix — Ember+Deposit → place → cancel → Withdraw+Ember-w.
  opts.onProgress?.("phoenix", "starting");
  const phoenix = await phoenixLifecycle({
    rpcUrl: opts.rpcUrl,
    apiUrl: opts.apiUrl,
    T: opts.T,
    depositUsdc: opts.depositUsdc,
    symbol: opts.symbol,
    side: opts.side,
    priceUsd: opts.priceUsd,
    baseUnits: opts.baseUnits,
    client: opts.phoenixClient,
    onProgress: opts.onProgress,
  });

  // 3. Cloak — re-shield exited USDC into the USDC pool.
  opts.onProgress?.("reshield", "starting");
  const reshield = await reshieldUsdc({
    connection,
    owner: opts.T,
    amount: opts.reshieldUsdc,
    programId: opts.cloakProgramId, relayUrl: opts.cloakRelayUrl,
    onProgress: (s) => opts.onProgress?.("reshield", s),
  });

  return { fund, phoenix, reshield };
}
