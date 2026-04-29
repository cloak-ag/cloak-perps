/**
 * `JupiterVenue` — Jupiter Perpetuals adapter conforming to `PerpVenue`
 * from `@cloak.dev/perps/core`.
 *
 * Jupiter is an **async** venue: every state-changing call submits a
 * `PositionRequest` PDA that an off-chain Jupiter keeper executes 1–60s
 * later (within `Pool.maxRequestExecutionSec=45s` or auto-rejected with
 * refund). Callers should branch on `capabilities.execution === "async"`
 * to surface honest UX, or just await `awaitSettlement` after each op.
 *
 * Limitations vs. orderbook venues:
 *   - `openPosition` only supports `orderType: "market"`. Limit-entry
 *     requires the keeper-only `instantCreateLimitOrder` ix. TP/SL on
 *     existing positions is supported (separate API, not on PerpVenue).
 *   - `cancelRequest` is supported and necessary for traders who want
 *     to cancel before keeper acts.
 *
 * Lower-level ix builders are exported separately for callers who want
 * direct control; this adapter is the venue-agnostic projection used
 * by the aggregator.
 *
 * STATUS: scaffold. Methods stub-throw "not implemented" pending the
 * read+write implementation passes.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type {
  ClosePositionParams,
  DepositCollateralParams,
  OpenPositionParams,
  PerpVenue,
  PositionState,
  Side,
  VenueCapabilities,
  VenueOpResult,
  WithdrawCollateralParams,
} from "../core/index.js";

import { CUSTODIES, MINTS, POOL_CONFIG_SNAPSHOT, type CustodySymbol } from "./constants.js";
import { decodePosition, isLong, tryDecodePosition } from "./decode.js";
import { computeFreeCollateral } from "./free-collateral.js";
import { decodePositionHandle, decodeRequestHandle, encodePositionHandle, encodeRequestHandle } from "./handle.js";
import {
  buildCloseRequestIx,
  buildDecreaseRequestIx,
  buildIncreaseRequestIx,
  mintForCollateralCustody,
} from "./ix.js";
import { MARKETS, findMarket } from "./markets.js";
import { generatePositionPda, generatePositionRequestPda } from "./pdas.js";
import { buildProgram } from "./program.js";

export interface JupiterVenueOptions {
  rpcUrl: string;
  /** Optional override for the JLP `Pool` config polled at construction.
   *  If omitted, the adapter uses the snapshot defaults and re-reads
   *  the live Pool on each call that needs an up-to-date timeout. */
  poolConfig?: typeof POOL_CONFIG_SNAPSHOT;
}

const NOT_IMPLEMENTED = (m: string) => new Error(`jupiter: ${m} not yet implemented`);

export class JupiterVenue implements PerpVenue {
  readonly capabilities: VenueCapabilities = {
    id: "jupiter",
    name: "Jupiter Perpetuals",
    /** No trader-callable limit-entry ix exists. `instantCreateLimitOrder`
     *  requires keeper signers. TP/SL on existing positions is separate. */
    orderTypes: ["market"],
    execution: "async",
    /** Permissionless: any wallet can open a Position with no allowlist. */
    traderRegistrationRequired: false,
    /** SOL/ETH/BTC/USDC/USDT all valid as `inputMint`. The adapter
     *  resolves the appropriate custody/collateralCustody internally;
     *  what the user actually posts converts via Jupiter Quote API
     *  if it doesn't match the custody mint. */
    collateralMints: [MINTS.SOL, MINTS.ETH, MINTS.BTC, MINTS.USDC, MINTS.USDT],
  };

  constructor(private readonly opts: JupiterVenueOptions) {
    void this.opts; // referenced by methods in later passes
  }

  // ────────────────────────────────────────────────────────────────
  // trade-side
  // ────────────────────────────────────────────────────────────────

  async openPosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: OpenPositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    if (opts.params.orderType === "limit") {
      throw new Error("jupiter: limit orders not supported (instantCreateLimitOrder is keeper-only)");
    }
    const { market, side } = parseMarket(opts.params.market, opts.params.side);
    const slippage = priceSlippageFromBps(opts.params.slippageBps);

    const program = buildProgram(opts.connection, opts.trader);
    opts.onProgress?.("building open request");
    const built = await buildIncreaseRequestIx({
      program,
      owner: opts.trader.publicKey,
      market, side,
      sizeUsdDelta: BigInt(opts.params.size),
      collateralTokenDelta: opts.params.collateral,
      inputMint: opts.params.collateralMint,
      priceSlippage: slippage,
    });

    opts.onProgress?.("submitting request");
    const sig = await sendV0Tx(opts.connection, opts.trader, built.instructions);
    opts.onProgress?.(`request submitted ${sig}`);
    return { status: "pending", signatures: [sig], requestHandle: built.requestHandle };
  }

  async closePosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: ClosePositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    const { market, side } = decodePositionHandle(opts.params.positionHandle);
    const fraction = opts.params.fraction ?? 1;
    if (fraction <= 0 || fraction > 1) {
      throw new Error(`jupiter: fraction must be in (0, 1], got ${fraction}`);
    }
    const slippage = priceSlippageFromBps(opts.params.slippageBps);

    // Read the live position to size the partial close.
    const program = buildProgram(opts.connection, opts.trader);
    const { mint } = mintForCollateralCustody(market, side);

    let sizeUsdDelta: bigint;
    let entirePosition = false;
    if (fraction === 1) {
      entirePosition = true;
      sizeUsdDelta = 0n;
    } else {
      const cur = await this.getPosition({
        connection: opts.connection,
        trader: opts.trader,
        positionHandle: opts.params.positionHandle,
      });
      if (!cur) throw new Error(`jupiter: no open position for ${opts.params.positionHandle}`);
      sizeUsdDelta = (BigInt(cur.size) * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
    }

    opts.onProgress?.("building close request");
    const built = await buildDecreaseRequestIx({
      program,
      owner: opts.trader.publicKey,
      market, side,
      sizeUsdDelta,
      collateralUsdDelta: 0n,
      desiredMint: mint,
      priceSlippage: slippage,
      entirePosition,
    });

    opts.onProgress?.("submitting request");
    const sig = await sendV0Tx(opts.connection, opts.trader, built.instructions);
    return { status: "pending", signatures: [sig], requestHandle: built.requestHandle };
  }

  // ────────────────────────────────────────────────────────────────
  // collateral
  // ────────────────────────────────────────────────────────────────

  async depositCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: DepositCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    const { market, side: defaultSide } = parseMarket(opts.params.market, "long");
    // For deposit-only we don't change side; the existing position's side
    // is implicit. Caller passes a market handle that already encodes side.
    // For simplicity, allow only Long deposits in v0 — Short collateral is
    // also fine but the canonical use is "add to your existing Long".
    const side = defaultSide;

    const program = buildProgram(opts.connection, opts.trader);
    opts.onProgress?.("building deposit request");
    const built = await buildIncreaseRequestIx({
      program,
      owner: opts.trader.publicKey,
      market, side,
      sizeUsdDelta: 0n,
      collateralTokenDelta: opts.params.amount,
      inputMint: opts.params.collateralMint,
      priceSlippage: 0n,
    });
    opts.onProgress?.("submitting request");
    const sig = await sendV0Tx(opts.connection, opts.trader, built.instructions);
    return { status: "pending", signatures: [sig], requestHandle: built.requestHandle };
  }

  async withdrawCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: WithdrawCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    const { market, side: defaultSide } = parseMarket(opts.params.market, "long");
    const side = defaultSide;

    let amount = opts.params.amount;
    if (amount === null) {
      opts.onProgress?.("computing drain-free amount");
      const { position } = generatePositionPda({
        trader: opts.trader.publicKey, market, side,
      });
      const breakdown = await computeFreeCollateral(opts.connection, position);
      if (breakdown.drainUsd === 0n) {
        throw new Error(
          `jupiter: nothing to drain — collateralUsd=${breakdown.collateralUsd}, ` +
          `maintenance=${breakdown.maintenanceUsd}, fees=${breakdown.closeFeeUsd + breakdown.borrowFeeUsd}`,
        );
      }
      amount = breakdown.drainUsd;
      opts.onProgress?.(`drain-free: ${amount} USD-6dp (free=${breakdown.freeUsd})`);
    }

    const program = buildProgram(opts.connection, opts.trader);
    opts.onProgress?.("building withdraw request");
    const built = await buildDecreaseRequestIx({
      program,
      owner: opts.trader.publicKey,
      market, side,
      sizeUsdDelta: 0n,
      collateralUsdDelta: amount,
      desiredMint: opts.params.collateralMint,
      priceSlippage: 0n,
    });
    opts.onProgress?.("submitting request");
    const sig = await sendV0Tx(opts.connection, opts.trader, built.instructions);
    return { status: "pending", signatures: [sig], requestHandle: built.requestHandle };
  }

  // ────────────────────────────────────────────────────────────────
  // reads
  // ────────────────────────────────────────────────────────────────

  async getPosition(opts: {
    connection: Connection;
    trader: Keypair;
    positionHandle: string;
  }): Promise<PositionState | null> {
    const { market, side } = decodePositionHandle(opts.positionHandle);
    // Default short collateral to USDC; USDT-collateralized shorts are
    // a separate handle (out of scope for this v0 read path).
    const m = findMarket(market, side, "USDC");
    const { position } = generatePositionPda({
      trader: opts.trader.publicKey,
      market,
      side,
      stableSide: m.collateralSymbol === "USDT" ? "USDT" : "USDC",
    });

    const info = await opts.connection.getAccountInfo(position, "confirmed");
    if (!info) return null;
    const decoded = tryDecodePosition(info.data);
    if (!decoded) return null;
    if (decoded.sizeUsd.isZero() && decoded.collateralUsd.isZero()) return null;

    return projectPositionState(
      opts.positionHandle,
      market,
      decoded,
      mintForCustody(m.collateralSymbol),
    );
  }

  async listPositions(opts: {
    connection: Connection;
    trader: Keypair;
  }): Promise<PositionState[]> {
    // Derive all 9 (base × side × collateral) PDAs and batch-fetch.
    const pdas = MARKETS.map((m) => {
      const { position } = generatePositionPda({
        trader: opts.trader.publicKey,
        market: m.base,
        side: m.side,
        stableSide: m.collateralSymbol === "USDT" ? "USDT" : "USDC",
      });
      return { market: m, position };
    });

    const infos = await opts.connection.getMultipleAccountsInfo(
      pdas.map((p) => p.position),
      "confirmed",
    );

    const out: PositionState[] = [];
    for (let i = 0; i < pdas.length; i++) {
      const info = infos[i];
      if (!info) continue;
      const decoded = tryDecodePosition(info.data);
      if (!decoded) continue;
      if (decoded.sizeUsd.isZero() && decoded.collateralUsd.isZero()) continue;
      const m = pdas[i].market;
      out.push(
        projectPositionState(
          encodePositionHandle(m.base, m.side),
          m.base,
          decoded,
          mintForCustody(m.collateralSymbol),
        ),
      );
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────
  // async settlement
  // ────────────────────────────────────────────────────────────────

  /**
   * Poll until the request's PositionRequest PDA is closed, indicating
   * the keeper has either executed (success) or auto-rejected (refund).
   *
   * Default timeout = `maxRequestExecutionSec * 1000 + 30_000` ms
   * (75s with the live config). After that point, the keeper has
   * either acted or the request can be manually cancelled.
   *
   * NOTE: cannot be fully exercised on surfpool because no keeper
   * runs there — requests stay pending forever and we hit the timeout.
   * On mainnet this is the path that detects keeper outcomes.
   */
  async awaitSettlement(opts: {
    connection: Connection;
    trader: Keypair;
    requestHandle: string;
    timeoutMs?: number;
  }): Promise<VenueOpResult> {
    const cfg = this.opts.poolConfig ?? POOL_CONFIG_SNAPSHOT;
    const timeout = opts.timeoutMs ?? cfg.maxRequestExecutionSec * 1000 + 30_000;
    const pollInterval = 1000;

    const { market, side, counter } = decodeRequestHandle(opts.requestHandle);
    const { BN } = await import("@coral-xyz/anchor");
    const counterBn = new BN(counter.toString());

    const { position } = generatePositionPda({
      trader: opts.trader.publicKey, market, side,
    });

    // Pre-derive both possible request PDAs (increase or decrease seed).
    const requestPdas = (["increase", "decrease"] as const).map((requestChange) => {
      const { positionRequest } = generatePositionRequestPda({
        position, counter: counterBn, requestChange,
      });
      return { requestChange, positionRequest };
    });

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const infos = await opts.connection.getMultipleAccountsInfo(
        requestPdas.map((r) => r.positionRequest),
        "confirmed",
      );
      const stillPending = infos.some((i) => i !== null);
      if (!stillPending) {
        return { status: "confirmed", signatures: [] };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    return { status: "pending", signatures: [], reason: "settlement timed out" };
  }

  /**
   * Cancel a pending request and refund the locked collateral.
   *
   * IMPORTANT: empirically the on-chain program enforces that
   * trader-self-signed `closePositionRequest2` is only allowed AFTER
   * `pool.maxRequestExecutionSec` (45s) has elapsed since request
   * creation. Before that window, only the keeper can close. Calling
   * this method early returns error 6027 `InstructionNotAllowed`.
   *
   * In practice this matters less than it sounds: keepers normally
   * act within 1–5 seconds, so most pending requests have already been
   * either executed (request PDA closed) or auto-rejected with refund
   * (request PDA closed) before this method is needed.
   *
   * The path that actually exercises this method: the keeper failed
   * to act within 45s for some reason (e.g. oracle stale and not
   * refreshed). The user retries the cancel after the window.
   */
  async cancelRequest(opts: {
    connection: Connection;
    trader: Keypair;
    requestHandle: string;
  }): Promise<VenueOpResult> {
    const { market, side, counter } = decodeRequestHandle(opts.requestHandle);
    const { position } = generatePositionPda({
      trader: opts.trader.publicKey,
      market, side,
    });
    // We don't know whether the request was an increase or a decrease
    // from the handle alone; try increase first, then decrease.
    const candidates: Array<"increase" | "decrease"> = ["increase", "decrease"];
    let positionRequest: PublicKey | null = null;
    for (const requestChange of candidates) {
      const { positionRequest: pr } = generatePositionRequestPda({
        position,
        counter: new (await import("@coral-xyz/anchor")).BN(counter.toString()),
        requestChange,
      });
      const info = await opts.connection.getAccountInfo(pr, "confirmed");
      if (info) {
        positionRequest = pr;
        break;
      }
    }
    if (!positionRequest) {
      throw new Error(`jupiter: no open request matches handle ${opts.requestHandle}`);
    }

    const { mint } = mintForCollateralCustody(market, side);
    const program = buildProgram(opts.connection, opts.trader);
    const ixs = await buildCloseRequestIx({
      program,
      owner: opts.trader.publicKey,
      positionRequest,
      position,
      mint,
    });
    const sig = await sendV0Tx(opts.connection, opts.trader, ixs);
    return { status: "refunded", signatures: [sig] };
  }

  // ────────────────────────────────────────────────────────────────
  // streaming
  // ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to live position updates via WebSocket-backed
   * `connection.onAccountChange` for each of the 9 Position PDAs.
   *
   * Each PDA's update fires our handler; we re-fetch all 9 (one
   * `getMultipleAccountsInfo` call) and emit the merged decoded state.
   * That keeps the consumer-facing emission shape equivalent to
   * `listPositions()` so callers can treat the stream as "listPositions
   * but live."
   *
   * Trade-off: re-fetching all on any change is slightly wasteful vs.
   * decoding only the changed PDA, but it gives us a uniform projection
   * (same code path as listPositions) and tolerates oracle-driven PnL
   * ticks without a separate oracle subscription.
   */
  async streamPositions(opts: {
    connection: Connection;
    trader: Keypair;
    onUpdate: (positions: PositionState[]) => void;
    onError?: (err: Error) => void;
  }): Promise<{ unsubscribe: () => void | Promise<void> }> {
    // Compute the 9 PDAs once.
    const pdas = MARKETS.map((m) => {
      const { position } = generatePositionPda({
        trader: opts.trader.publicKey,
        market: m.base,
        side: m.side,
        stableSide: m.collateralSymbol === "USDT" ? "USDT" : "USDC",
      });
      return { market: m, position };
    });

    const refresh = async () => {
      try {
        const infos = await opts.connection.getMultipleAccountsInfo(
          pdas.map((p) => p.position),
          "confirmed",
        );
        const out: PositionState[] = [];
        for (let i = 0; i < pdas.length; i++) {
          const info = infos[i];
          if (!info) continue;
          const decoded = tryDecodePosition(info.data);
          if (!decoded) continue;
          if (decoded.sizeUsd.isZero() && decoded.collateralUsd.isZero()) continue;
          const m = pdas[i].market;
          out.push(
            projectPositionState(
              encodePositionHandle(m.base, m.side),
              m.base,
              decoded,
              mintForCustody(m.collateralSymbol),
            ),
          );
        }
        opts.onUpdate(out);
      } catch (e) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    };

    // Initial fire — equivalent to a synchronous listPositions().
    await refresh();

    // Subscribe each PDA. Any update triggers a refresh of all.
    const subIds = pdas.map((p) =>
      opts.connection.onAccountChange(p.position, () => { void refresh(); }, "confirmed"),
    );

    return {
      unsubscribe: async () => {
        await Promise.all(subIds.map((id) => opts.connection.removeAccountChangeListener(id)));
      },
    };
  }
}

// ────────────────────────────────────────────────────────────────
// helpers (continued)
// ────────────────────────────────────────────────────────────────

function parseMarket(
  marketStr: string,
  defaultSide: Side,
): { market: "SOL" | "ETH" | "BTC"; side: Side } {
  // Accept either bare base ("SOL") or full handle ("jupiter/SOL/long").
  const handleMatch = marketStr.match(/^jupiter\/(SOL|ETH|BTC)\/(long|short)$/);
  if (handleMatch) {
    return { market: handleMatch[1] as "SOL" | "ETH" | "BTC", side: handleMatch[2] as Side };
  }
  if (["SOL", "ETH", "BTC"].includes(marketStr)) {
    return { market: marketStr as "SOL" | "ETH" | "BTC", side: defaultSide };
  }
  throw new Error(`jupiter: unsupported market ${marketStr} (expected SOL|ETH|BTC or jupiter/<base>/<side>)`);
}

function priceSlippageFromBps(bps: number | undefined): bigint {
  // priceSlippage on Jupiter is U64 in some scaled USD-6dp terms; the
  // semantics from the IDL are "max acceptable execution price delta
  // from mark, USD-6dp". Without an exact formula in the IDL we pass a
  // wide default (1B = $1,000) when caller provides nothing; this is
  // intentionally permissive for v0 — caller-tightened slippage will
  // be wired with the `priceImpactBuffer` formula in a follow-up.
  if (bps === undefined) return 1_000_000_000n;
  return BigInt(Math.max(1, Math.floor(bps * 1_000_000))); // bps * USD-6dp ≈ $0.01 per bps
}

async function sendV0Tx(
  connection: Connection,
  signer: Keypair,
  instructions: import("@solana/web3.js").TransactionInstruction[],
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message(),
  );
  tx.sign([signer]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(
    { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────

function mintForCustody(symbol: CustodySymbol): PublicKey {
  return MINTS[symbol];
}

function projectPositionState(
  handle: string,
  market: string,
  raw: ReturnType<typeof decodePosition>,
  collateralMint: PublicKey,
): PositionState {
  return {
    handle,
    market,
    side: isLong(raw.side) ? "long" : "short",
    // Phoenix expresses size as base units; on Jupiter, sizeUsd is the
    // notional in USD-6dp. We surface it as a string in USD-6dp; the
    // aggregator's PnL math is venue-agnostic in the long term, but
    // for v0 callers should treat size as opaque.
    size: raw.sizeUsd.toString(),
    collateral: BigInt(raw.collateralUsd.toString()),
    collateralMint,
    // PnL/funding/liqPrice projections need a live custody+oracle read.
    // Defer to a follow-up pass; surface zeros so the field is
    // type-stable for callers and obviously-uncomputed.
    unrealizedPnl: 0n,
    funding: 0n,
  };
}

void encodeRequestHandle;
