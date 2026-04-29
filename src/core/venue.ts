/**
 * The contract every venue adapter conforms to.
 *
 * The aggregator's privacy boundary is venue-agnostic: T arrives funded
 * via Cloak; the adapter's job is to take T into a position and back
 * out without leaking the W↔T linkage on its own surface. The adapter
 * does NOT touch Cloak — `cloak-bridge` handles the funding and exit
 * lanes. The adapter only owns the trade-side glue.
 *
 * Two settlement shapes are accommodated:
 *
 *   - **atomic** (Phoenix, Zeta, Mango v4): `openPosition` returns
 *     `status: "confirmed"` immediately. `awaitSettlement` is a no-op.
 *
 *   - **async** (Jupiter Perps, Flash Trade): `openPosition` returns
 *     `status: "pending"` plus a `requestHandle`. The caller polls
 *     `awaitSettlement(requestHandle)` until terminal. The adapter
 *     also exposes a `cancelRequest` path for stalled requests.
 *
 * Callers branch on `capabilities.execution` to surface the difference;
 * the aggregator does not paper over it.
 */

import type { Connection, Keypair } from "@solana/web3.js";
import type {
  ClosePositionParams,
  DepositCollateralParams,
  OpenPositionParams,
  PositionState,
  VenueCapabilities,
  VenueOpResult,
  WithdrawCollateralParams,
} from "./types.js";

export interface PerpVenue {
  readonly capabilities: VenueCapabilities;

  /**
   * Open or increase a position. For async venues this submits the
   * request; the actual position state isn't observable until the
   * keeper executes. Use `awaitSettlement` to block on outcome.
   */
  openPosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: OpenPositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult>;

  /**
   * Close (or partial-close) a position. Same atomic/async semantics
   * as `openPosition`. Does NOT withdraw collateral — call
   * `withdrawCollateral` separately. (Async venues whose decrease ix
   * can withdraw collateral atomically may emit both legs in one
   * request internally; the caller-facing API still treats them as
   * separate operations.)
   */
  closePosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: ClosePositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult>;

  /**
   * Deposit collateral without changing position size. On orderbook
   * cross-margin venues this is a standalone ix; on async oracle/JLP
   * venues this maps to `increase-position-request` with `sizeDelta=0`.
   */
  depositCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: DepositCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult>;

  /**
   * Withdraw collateral without changing position size. Counterpart to
   * `depositCollateral`. On async venues this maps to
   * `decrease-position-request` with `sizeDelta=0`.
   */
  withdrawCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: WithdrawCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult>;

  /**
   * Read a single position by handle. Returns `null` if no position
   * exists at that handle (e.g. after a full close). Adapters use this
   * internally to size partial closes; callers may use it directly.
   */
  getPosition(opts: {
    connection: Connection;
    trader: Keypair;
    positionHandle: string;
  }): Promise<PositionState | null>;

  /** List T's open positions on this venue. */
  listPositions(opts: {
    connection: Connection;
    trader: Keypair;
  }): Promise<PositionState[]>;

  /**
   * Block until an async request reaches terminal state (`"confirmed"`,
   * `"failed"`, or `"refunded"`). For atomic venues this is a no-op
   * and resolves immediately with the result already returned.
   *
   * Async venues need `trader` to derive the Position PDA seeds the
   * polling targets. Atomic venues ignore it.
   */
  awaitSettlement(opts: {
    connection: Connection;
    trader: Keypair;
    requestHandle: string;
    timeoutMs?: number;
  }): Promise<VenueOpResult>;

  /**
   * Cancel a pending async request and refund any locked collateral.
   * Only meaningful on async venues; atomic venues throw.
   */
  cancelRequest?(opts: {
    connection: Connection;
    trader: Keypair;
    requestHandle: string;
  }): Promise<VenueOpResult>;

  /**
   * Subscribe to live position updates for `trader`. Optional —
   * adapters that don't implement it return undefined from
   * `Aggregator.streamPositions`, and callers fall back to polling
   * `listPositions` themselves.
   *
   * Contract:
   *   - The first call to `onUpdate` fires synchronously after
   *     subscription with the current position state (so the callback
   *     is also a useful initial-fetch).
   *   - Subsequent calls fire whenever the underlying state changes
   *     (account-data update for Anchor-decoded venues, server-pushed
   *     deltas for HTTP-streamed venues).
   *   - `unsubscribe()` tears down all underlying listeners. Idempotent.
   */
  streamPositions?(opts: {
    connection: Connection;
    trader: Keypair;
    onUpdate: (positions: PositionState[]) => void;
    onError?: (err: Error) => void;
  }): Promise<{ unsubscribe: () => void | Promise<void> }>;
}
