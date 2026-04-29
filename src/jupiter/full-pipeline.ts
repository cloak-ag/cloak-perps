/**
 * One-call composition of the privacy-first Jupiter Perpetuals flow:
 *
 *     Cloak unshield SOL+USDC → T  (cloak-bridge: fundTargetFromUsdc)
 *           ↓
 *     JupiterVenue.openPosition (USDC-collateralized short, market)
 *           ↓
 *     JupiterVenue.awaitSettlement                    ← keeper executes (mainnet only)
 *           ↓
 *     JupiterVenue.closePosition (full close)
 *           ↓
 *     JupiterVenue.awaitSettlement                    ← keeper executes (mainnet only)
 *           ↓
 *     Cloak re-shield USDC → pool   (cloak-bridge: reshieldUsdc)
 *
 * Library:
 *   import { fullPipeline } from "../jupiter/index.js";
 *   await fullPipeline({ ... });
 *
 * CLI (env-driven):
 *   W_KEYPAIR_PATH=...  TARGET_KEYPAIR_PATH=...
 *   SOLANA_RPC_URL=https://your-mainnet-rpc
 *   T_SOL=0.01  T_USDC=15
 *   COLLATERAL_USDC=10  RESHIELD_USDC=8
 *   MARKET=SOL  SIDE=short  SIZE_USD=50
 *   npx tsx src/full-pipeline.ts
 *
 * NOTE: This pipeline is **mainnet-shaped**. On surfpool the keeper
 * doesn't run, so `awaitSettlement` will time out and the pipeline
 * will fail at the open step. Real-mainnet validation only.
 */

import {
  fundTargetFromUsdc,
  reshieldUsdc,
  type FundTargetFromUsdcResult,
  type ReshieldUsdcResult,
} from "../cloak/index.js";
import type { Side } from "../core/index.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { MINTS, type MarketBase } from "./constants.js";
import { JupiterVenue } from "./venue.js";

export interface JupiterFullPipelineOptions {
  rpcUrl: string;
  /** Override Cloak shield-pool program id. Defaults to mainnet. */
  cloakProgramId?: PublicKey;
  /** Override Cloak relay URL. Defaults to https://api.cloak.ag. */
  cloakRelayUrl?: string;
  W: Keypair;
  T: Keypair;
  /** SOL to deliver to T (post-fee, exact). T needs ~0.01 SOL for tx fees. */
  tSol: number;
  /** USDC to deliver to T (post-fee). Must be ≥ collateralUsdc. */
  tUsdc: number;
  /** Notional position size in USD (e.g. 50 = $50). */
  sizeUsd: number;
  /** USDC the Jupiter step posts as collateral. */
  collateralUsdc: number;
  /** USDC the exit step re-shields into the Cloak USDC pool. */
  reshieldUsdc: number;
  /** Market base asset. */
  market: MarketBase;
  /** Long or short. v0 supports `short` only — see notes. */
  side: Side;
  /** Slippage tolerance in basis points. */
  slippageBps?: number;
  /** awaitSettlement timeout per step. Default 75s (45s window + 30s buffer). */
  awaitTimeoutMs?: number;
  onProgress?: (stage: string, status: string) => void;
}

export interface JupiterFullPipelineResult {
  fund: FundTargetFromUsdcResult;
  open: { sig: string; requestHandle: string };
  close: { sig: string; requestHandle: string };
  reshield: ReshieldUsdcResult;
}

/**
 * v0 NOTE: this pipeline supports `side: "short"` with USDC collateral only.
 *
 * Why: Cloak's exit lane (`reshieldUsdc`) re-shields USDC. For a Short
 * position, collateral is USDC by default — close returns USDC, which
 * we re-shield directly. For Long, collateral is the base asset (SOL
 * for SOL-Long), which would require either a Cloak SOL-pool re-shield
 * (not yet exposed by cloak-bridge) or a USDC swap step. Both are
 * doable extensions.
 */
export async function fullPipeline(
  opts: JupiterFullPipelineOptions,
): Promise<JupiterFullPipelineResult> {
  if (opts.side !== "short") {
    throw new Error(
      "jupiter fullPipeline: only `side: 'short'` is supported in v0 (USDC-collateral round-trips into the Cloak USDC pool)",
    );
  }

  const connection = new Connection(opts.rpcUrl, "confirmed");
  const venue = new JupiterVenue({ rpcUrl: opts.rpcUrl });

  // ───── 1. Cloak — fund T privately from W ─────
  opts.onProgress?.("fund", "starting usdc");
  const fund = await fundTargetFromUsdc({
    connection,
    W: opts.W, T: opts.T,
    tSol: opts.tSol, tUsdc: opts.tUsdc,
    programId: opts.cloakProgramId, relayUrl: opts.cloakRelayUrl,
    onProgress: opts.onProgress,
  });

  // ───── 2. Jupiter — open ─────
  opts.onProgress?.("open", "submitting");
  const collateralUsd6dp = BigInt(Math.round(opts.collateralUsdc * 1_000_000));
  const sizeUsd6dp = BigInt(Math.round(opts.sizeUsd * 1_000_000));
  const openResult = await venue.openPosition({
    connection, trader: opts.T,
    params: {
      market: opts.market,
      side: "short",
      orderType: "market",
      size: sizeUsd6dp.toString(),
      collateral: collateralUsd6dp,
      collateralMint: MINTS.USDC,
      slippageBps: opts.slippageBps ?? 50,
    },
    onProgress: (s) => opts.onProgress?.("open", s),
  });
  if (!openResult.requestHandle) throw new Error("jupiter open: no requestHandle returned");

  opts.onProgress?.("open", "awaiting keeper execution");
  const openSettled = await venue.awaitSettlement({
    connection, trader: opts.T,
    requestHandle: openResult.requestHandle,
    timeoutMs: opts.awaitTimeoutMs,
  });
  if (openSettled.status !== "confirmed") {
    throw new Error(`jupiter open: keeper did not execute (${openSettled.status}: ${openSettled.reason ?? ""})`);
  }
  opts.onProgress?.("open", `executed sig=${openResult.signatures[0]}`);

  // ───── 3. Jupiter — close ─────
  opts.onProgress?.("close", "submitting");
  const closeResult = await venue.closePosition({
    connection, trader: opts.T,
    params: {
      positionHandle: `jupiter/${opts.market}/short`,
      fraction: 1,
      slippageBps: opts.slippageBps ?? 50,
    },
    onProgress: (s) => opts.onProgress?.("close", s),
  });
  if (!closeResult.requestHandle) throw new Error("jupiter close: no requestHandle returned");

  opts.onProgress?.("close", "awaiting keeper execution");
  const closeSettled = await venue.awaitSettlement({
    connection, trader: opts.T,
    requestHandle: closeResult.requestHandle,
    timeoutMs: opts.awaitTimeoutMs,
  });
  if (closeSettled.status !== "confirmed") {
    throw new Error(`jupiter close: keeper did not execute (${closeSettled.status}: ${closeSettled.reason ?? ""})`);
  }
  opts.onProgress?.("close", `executed sig=${closeResult.signatures[0]}`);

  // ───── 4. Cloak — re-shield exited USDC ─────
  opts.onProgress?.("reshield", "starting");
  const reshield = await reshieldUsdc({
    connection,
    owner: opts.T,
    amount: opts.reshieldUsdc,
    programId: opts.cloakProgramId, relayUrl: opts.cloakRelayUrl,
    onProgress: (s) => opts.onProgress?.("reshield", s),
  });

  return {
    fund,
    open: { sig: openResult.signatures[0], requestHandle: openResult.requestHandle },
    close: { sig: closeResult.signatures[0], requestHandle: closeResult.requestHandle },
    reshield,
  };
}

// ─────────────────────────────────────────────────────────────
// CLI entrypoint
// ─────────────────────────────────────────────────────────────
