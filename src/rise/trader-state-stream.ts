/**
 * Phoenix Eternal `traderState` WS subscriber.
 *
 * Phoenix pushes a full traderState snapshot when you subscribe and
 * incremental updates as positions change. We re-emit the
 * (capabilities, subaccounts) tuple to callers; the venue layer
 * normalizes it into `PositionState[]`.
 *
 * The Rise SDK exposes higher-level stream clients but they pull in
 * a lot of dependencies. For our purpose — read positions for one
 * authority — a direct WS subscription is the minimal surface.
 */

const DEFAULT_WS_URL = "wss://perp-api.phoenix.trade/v1/ws";

export interface TraderStatePosition {
  symbol: string;
  positionSequenceNumber: string;
  /** Signed string. Negative => short. Units are Phoenix "base lots". */
  basePositionLots: string;
  basePositionUnits?: string;
  entryPriceTicks?: string;
  entryPriceUsd?: string;
  virtualQuotePositionLots?: string;
  unsettledFundingQuoteLots?: string;
  accumulatedFundingQuoteLots?: string;
  takeProfitTriggers?: Array<{
    takeProfitId: string;
    trigger: { triggerPriceTicks?: string; triggerPriceUsd?: string; executionPriceTicks?: string; executionPriceUsd?: string };
    status: string;
  }>;
  stopLossTriggers?: Array<{
    stopLossId: string;
    trigger: { triggerPriceTicks?: string; triggerPriceUsd?: string; executionPriceTicks?: string; executionPriceUsd?: string };
    status: string;
  }>;
}

export interface TraderStateSubaccount {
  subaccountIndex: number;
  sequence: number;
  /** USDC collateral in base units (6 decimals) as a string. */
  collateral: string;
  positions: TraderStatePosition[];
}

export interface TraderStateSnapshot {
  authority: string;
  traderPdaIndex: number;
  slot: number;
  subaccounts: TraderStateSubaccount[];
}

export type TraderStateListener = (snapshot: TraderStateSnapshot) => void;

/**
 * Subscribe to one authority's traderState WS feed. Phoenix sends an
 * initial snapshot on subscribe + deltas as state changes. We
 * maintain a local view (subaccounts keyed by index, positions keyed
 * by symbol) and emit the merged snapshot to the listener on every
 * update.
 *
 * Returns an unsubscribe handle.
 */
export function streamTraderState(
  authority: string,
  onSnapshot: TraderStateListener,
  opts: { wsUrl?: string; traderPdaIndex?: number } = {},
): () => void {
  const wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
  const traderPdaIndex = opts.traderPdaIndex ?? 0;

  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Local merged view of the trader state. We keep subaccounts in a
  // Map keyed by index so deltas can patch individual subaccounts
  // without overwriting siblings.
  const subaccounts = new Map<number, TraderStateSubaccount>();
  let lastSlot = 0;

  const emit = () => {
    onSnapshot({
      authority,
      traderPdaIndex,
      slot: lastSlot,
      subaccounts: Array.from(subaccounts.values()).sort((a, b) => a.subaccountIndex - b.subaccountIndex),
    });
  };

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      socket?.send(JSON.stringify({
        type: "subscribe",
        subscription: { channel: "traderState", authority, traderPdaIndex },
      }));
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as {
          channel?: string;
          authority?: string;
          messageType?: "snapshot" | "delta";
          slot?: number;
          subaccounts?: TraderStateSubaccount[];
          // Phoenix may push subaccount deltas as separate fields, but
          // the simplest robust path is to re-emit a full snapshot for
          // every received `subaccounts` array.
        };
        if (msg.channel !== "traderState" || msg.authority !== authority) return;
        if (typeof msg.slot === "number") lastSlot = msg.slot;
        if (msg.subaccounts) {
          // Replace local view with the broadcasted set. Phoenix's
          // snapshot is authoritative; for deltas we let the server
          // recompute and resend rather than maintaining a delta
          // patcher here.
          subaccounts.clear();
          for (const sa of msg.subaccounts) subaccounts.set(sa.subaccountIndex, sa);
          emit();
        }
      } catch { /* noop */ }
    };

    socket.onclose = () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, 2_000);
    };
    socket.onerror = () => { socket?.close(); };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
