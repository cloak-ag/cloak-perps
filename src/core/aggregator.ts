/**
 * Privacy-first perps aggregator core.
 *
 * Given a trade intent + a set of venue adapters, pick the venue that:
 *   1. supports the requested orderType,
 *   2. accepts the requested collateral mint,
 * and rank compatible venues by a configurable score function.
 *
 * Default scoring prefers atomic settlement (no keeper dependency) and
 * permissionless venues (no allowlist gate). Override `score` to change.
 *
 * `openMulti(intents[])` is the Synthesis-style multi-position primitive:
 * one trader, multiple intents, parallel submission across venues.
 *
 * What this module does NOT do (yet):
 *   - quote-aware routing (best execution price, depth)
 *   - funding-rate-aware routing (which venue's funding is cheapest)
 *   - splitting a single intent across venues
 *
 * Those need a `quoteOpen` extension on `PerpVenue`. Out of scope here.
 */

import type { Connection, Keypair, PublicKey } from "@solana/web3.js";

import type { PerpVenue } from "./venue.js";
import type {
  ClosePositionParams,
  DepositCollateralParams,
  OpenPositionParams,
  PositionState,
  VenueOpResult,
  WithdrawCollateralParams,
} from "./types.js";

export interface TradeIntent {
  market: string;
  side: "long" | "short";
  orderType: "market" | "limit";
  collateralMint: PublicKey;
}

export interface VenueSelection {
  venue: PerpVenue;
  /** Score this venue earned. Higher = better. */
  score: number;
  /** Human-readable reason this venue was picked. */
  reason: string;
  /** Other compatible venues, in descending score order. */
  alternatives: Array<{ venue: PerpVenue; score: number; reason: string }>;
}

export type VenueScoreFn = (venue: PerpVenue, intent: TradeIntent) => number;

/**
 * Default scoring:
 *   +100 if execution mode is "atomic" (no keeper dependency)
 *   +20  if no trader registration required
 *   +10  per supported orderType (rewards versatility)
 */
export const defaultVenueScore: VenueScoreFn = (venue) => {
  let s = 0;
  if (venue.capabilities.execution === "atomic") s += 100;
  if (!venue.capabilities.traderRegistrationRequired) s += 20;
  s += venue.capabilities.orderTypes.length * 10;
  return s;
};

/**
 * Find venues that can serve `intent` and rank them. Throws if no
 * compatible venue exists.
 */
export function chooseVenue(
  intent: TradeIntent,
  venues: readonly PerpVenue[],
  score: VenueScoreFn = defaultVenueScore,
): VenueSelection {
  if (venues.length === 0) throw new Error("aggregator: no venues registered");

  const compatible: Array<{ venue: PerpVenue; score: number; reason: string }> = [];
  const rejected: string[] = [];

  for (const venue of venues) {
    const cap = venue.capabilities;
    if (!cap.orderTypes.includes(intent.orderType)) {
      rejected.push(`${cap.id}: orderType=${intent.orderType} not supported`);
      continue;
    }
    if (!cap.collateralMints.some((m) => m.equals(intent.collateralMint))) {
      rejected.push(`${cap.id}: collateralMint=${intent.collateralMint.toBase58().slice(0, 8)}… not in capabilities`);
      continue;
    }
    const s = score(venue, intent);
    compatible.push({
      venue, score: s,
      reason: `${cap.id}: ${cap.execution} settlement, ${cap.orderTypes.join("|")} orders, score=${s}`,
    });
  }

  if (compatible.length === 0) {
    const why = rejected.join("; ") || "no venues registered";
    throw new Error(`aggregator: no compatible venue for intent (${why})`);
  }

  compatible.sort((a, b) => b.score - a.score);
  const [best, ...rest] = compatible;
  return { venue: best.venue, score: best.score, reason: best.reason, alternatives: rest };
}

/** Result of a single intent inside `openMulti`. */
export interface OpenMultiOutcome {
  intent: OpenPositionParams;
  venueId: string;
  ok: boolean;
  result?: VenueOpResult;
  error?: string;
}

/**
 * Wrapper that exposes the same surface as `PerpVenue` but routes each
 * call through `chooseVenue`. Useful when the caller doesn't want to
 * manage venue selection themselves.
 *
 * Reads (`getPosition`, `listPositions`) fan out across all venues and
 * merge results — a position can live on any venue, so we ask all.
 */
export class Aggregator {
  constructor(
    public readonly venues: readonly PerpVenue[],
    private readonly score: VenueScoreFn = defaultVenueScore,
  ) {
    if (venues.length === 0) throw new Error("Aggregator: at least one venue required");
  }

  pick(intent: TradeIntent): VenueSelection {
    return chooseVenue(intent, this.venues, this.score);
  }

  async openPosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: OpenPositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult & { venueId: string }> {
    const { venue, reason } = this.pick({
      market: opts.params.market,
      side: opts.params.side,
      orderType: opts.params.orderType,
      collateralMint: opts.params.collateralMint,
    });
    opts.onProgress?.(`routed: ${reason}`);
    const result = await venue.openPosition(opts);
    return { ...result, venueId: venue.capabilities.id };
  }

  /**
   * Open multiple positions across venues in parallel — the Synthesis
   * primitive. Each intent picks its own venue (or you can hint via
   * a custom score). Submits concurrently via `Promise.allSettled`,
   * collects per-intent outcomes.
   *
   * Failures on one intent do not abort the others. The caller
   * inspects each `OpenMultiOutcome.ok` to decide what to do.
   */
  async openMulti(opts: {
    connection: Connection;
    trader: Keypair;
    intents: OpenPositionParams[];
    onProgress?: (intentIndex: number, status: string) => void;
  }): Promise<OpenMultiOutcome[]> {
    const tasks = opts.intents.map(async (params, i): Promise<OpenMultiOutcome> => {
      try {
        const { venue, reason } = this.pick({
          market: params.market,
          side: params.side,
          orderType: params.orderType,
          collateralMint: params.collateralMint,
        });
        opts.onProgress?.(i, `routed: ${reason}`);
        const result = await venue.openPosition({
          connection: opts.connection,
          trader: opts.trader,
          params,
          onProgress: (s) => opts.onProgress?.(i, s),
        });
        return { intent: params, venueId: venue.capabilities.id, ok: true, result };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { intent: params, venueId: "?", ok: false, error: msg };
      }
    });
    return Promise.all(tasks);
  }

  async closePosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: ClosePositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult & { venueId: string }> {
    // Decode handle prefix to find the originating venue (handles are
    // formatted `<venueId>/<rest...>`).
    const venueId = opts.params.positionHandle.split("/")[0];
    const venue = this.venues.find((v) => v.capabilities.id === venueId);
    if (!venue) throw new Error(`aggregator: no venue matches handle prefix '${venueId}'`);
    const result = await venue.closePosition(opts);
    return { ...result, venueId: venue.capabilities.id };
  }

  /** Close every open position across all venues. Useful for
   *  "exit-all" buttons in a portfolio UI. Best-effort — failures on
   *  individual venues are returned but don't abort. */
  async closeAll(opts: {
    connection: Connection;
    trader: Keypair;
    onProgress?: (handle: string, status: string) => void;
  }): Promise<Array<{ handle: string; ok: boolean; result?: VenueOpResult; error?: string }>> {
    const positions = await this.listPositions(opts);
    const tasks = positions.map(async (p) => {
      try {
        const r = await this.closePosition({
          connection: opts.connection,
          trader: opts.trader,
          params: { positionHandle: p.handle, fraction: 1 },
          onProgress: (s) => opts.onProgress?.(p.handle, s),
        });
        return { handle: p.handle, ok: true as const, result: r };
      } catch (e) {
        return { handle: p.handle, ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return Promise.all(tasks);
  }

  async depositCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: DepositCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult & { venueId: string }> {
    const { venue } = this.pick({
      market: opts.params.market,
      side: "long",
      orderType: "market",
      collateralMint: opts.params.collateralMint,
    });
    const result = await venue.depositCollateral(opts);
    return { ...result, venueId: venue.capabilities.id };
  }

  async withdrawCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: WithdrawCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult & { venueId: string }> {
    const { venue } = this.pick({
      market: opts.params.market,
      side: "long",
      orderType: "market",
      collateralMint: opts.params.collateralMint,
    });
    const result = await venue.withdrawCollateral(opts);
    return { ...result, venueId: venue.capabilities.id };
  }

  /** Fan-out read: every venue's positions, merged. */
  async listPositions(opts: {
    connection: Connection;
    trader: Keypair;
  }): Promise<PositionState[]> {
    const all = await Promise.all(
      this.venues.map(async (v) => {
        try { return await v.listPositions(opts); }
        catch { return []; }
      }),
    );
    return all.flat();
  }

  /** Read by handle: routes to the venue whose id prefixes the handle. */
  async getPosition(opts: {
    connection: Connection;
    trader: Keypair;
    positionHandle: string;
  }): Promise<PositionState | null> {
    const venueId = opts.positionHandle.split("/")[0];
    const venue = this.venues.find((v) => v.capabilities.id === venueId);
    if (!venue) return null;
    return venue.getPosition(opts);
  }

  /**
   * Subscribe to live position updates across every venue that
   * implements `streamPositions` (it's optional on `PerpVenue`).
   * Venues without an impl are skipped and surfaced via `unsupported`
   * in the result so callers know which ones still need polling.
   *
   * The aggregator keeps a per-venue "last known state" map and emits
   * the merged `PositionState[]` on every update. The first emission
   * fires once each subscribed venue has published its initial state.
   */
  async streamPositions(opts: {
    connection: Connection;
    trader: Keypair;
    onUpdate: (positions: PositionState[]) => void;
    onError?: (venueId: string, err: Error) => void;
  }): Promise<{
    unsubscribe: () => Promise<void>;
    unsupported: string[];
  }> {
    const lastByVenue = new Map<string, PositionState[]>();
    const unsupported: string[] = [];
    const subs: Array<{ unsubscribe: () => void | Promise<void> }> = [];

    const emit = () => {
      const merged: PositionState[] = [];
      for (const list of lastByVenue.values()) merged.push(...list);
      opts.onUpdate(merged);
    };

    for (const venue of this.venues) {
      if (!venue.streamPositions) {
        unsupported.push(venue.capabilities.id);
        continue;
      }
      try {
        const sub = await venue.streamPositions({
          connection: opts.connection,
          trader: opts.trader,
          onUpdate: (positions) => {
            lastByVenue.set(venue.capabilities.id, positions);
            emit();
          },
          onError: (err) => opts.onError?.(venue.capabilities.id, err),
        });
        subs.push(sub);
      } catch (e) {
        opts.onError?.(venue.capabilities.id, e instanceof Error ? e : new Error(String(e)));
      }
    }

    return {
      unsupported,
      unsubscribe: async () => {
        await Promise.all(subs.map((s) => s.unsubscribe()));
      },
    };
  }
}
