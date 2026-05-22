/**
 * `RiseVenue` — Phoenix Eternal adapter conforming to `PerpVenue` from
 * `@cloak.dev/perps/core`.
 *
 * Phoenix is an **atomic** venue: every method here returns a confirmed
 * result in a single signed v0 tx, so `awaitSettlement` is a no-op and
 * `cancelRequest` is unsupported. The lower-level surface
 * (`phoenixLifecycle`, `bundlePhoenixEntry`, `bundlePhoenixExit`,
 * `placeFlightWrappedOrder`) stays exported for callers who want richer
 * control; this adapter is the venue-agnostic projection used by the
 * aggregator.
 */

import {
  OrderFlags,
  Side as PhoenixSide,
  buildEmberWithdrawIx,
  createPhoenixClient,
  type Authority,
  type Symbol as PhoenixSymbol,
} from "@ellipsis-labs/rise";

import {
  streamTraderState,
  type TraderStatePosition,
  type TraderStateSubaccount,
} from "./trader-state-stream.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { IInstruction } from "@solana/kit";

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

import { sendIxs } from "./lib/kit-send.js";
import { web3KeypairToKitSigner } from "./lib/kit-signer.js";

// Phoenix Eternal universally quotes in USDC.
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEFAULT_API_URL = "https://perp-api.phoenix.trade";

export interface RiseVenueOptions {
  rpcUrl: string;
  apiUrl?: string;
}

const sideToPhoenix = (s: Side): PhoenixSide =>
  s === "long" ? PhoenixSide.Bid : PhoenixSide.Ask;
const oppositeSide = (s: Side): Side => (s === "long" ? "short" : "long");

const encodeHandle = (market: string, side: Side) => `rise/${market}/${side}`;
const decodeHandle = (h: string): { market: string; side: Side } => {
  const [venue, market, side] = h.split("/");
  if (venue !== "rise" || !market || (side !== "long" && side !== "short")) {
    throw new Error(`invalid rise position handle: ${h}`);
  }
  return { market, side };
};

/**
 * Workaround for `@ellipsis-labs/rise@0.4.8`: `buildEmberWithdrawIxResolved`
 * swaps the input/output mint+ATA slots vs. the on-chain Ember program's
 * fixed account layout. Rebuild the trailing Ember-w ix with the slots
 * un-swapped using accounts pulled from the broken ix.
 */
/**
 * Convert one Phoenix `TraderStatePosition` (raw WS payload) into the
 * venue-agnostic `PositionState`. mark-price / liq-price / upnl are
 * not derivable from traderState alone — those need the marketStats
 * feed merged in by the caller and are left undefined here.
 */
function traderStatePositionToState(
  symbol: string,
  pos: TraderStatePosition,
  subaccountCollateralUsd: bigint,
): PositionState | null {
  const baseLotsStr = pos.basePositionLots ?? "0";
  if (baseLotsStr === "0") return null;
  const isShort = baseLotsStr.startsWith("-");
  const side: Side = isShort ? "short" : "long";
  const sizeBase = pos.basePositionUnits != null
    ? Math.abs(parseFloat(pos.basePositionUnits))
    : undefined;
  const entryPriceUsd = pos.entryPriceUsd != null ? parseFloat(pos.entryPriceUsd) : undefined;

  // Funding lots are USDC base-unit equivalents (6 decimals). Sum
  // unsettled + accumulated for the "lifetime funding so far" view.
  const fundingLots =
    (BigInt(pos.unsettledFundingQuoteLots ?? "0") +
      BigInt(pos.accumulatedFundingQuoteLots ?? "0"));

  return {
    handle: `rise/${symbol}/${side}`,
    market: symbol,
    side,
    size: baseLotsStr,
    sizeBase,
    collateral: subaccountCollateralUsd,
    collateralMint: USDC_MINT,
    unrealizedPnl: 0n,
    entryPriceUsd,
    funding: fundingLots,
    takeProfitTriggers: pos.takeProfitTriggers?.map((t) => ({
      id: t.takeProfitId,
      triggerPriceUsd: t.trigger.triggerPriceUsd
        ? parseFloat(t.trigger.triggerPriceUsd)
        : ticksToUsd(t.trigger.triggerPriceTicks),
      executionPriceUsd: t.trigger.executionPriceUsd
        ? parseFloat(t.trigger.executionPriceUsd)
        : t.trigger.executionPriceTicks
          ? ticksToUsd(t.trigger.executionPriceTicks)
          : undefined,
    })),
    stopLossTriggers: pos.stopLossTriggers?.map((t) => ({
      id: t.stopLossId,
      triggerPriceUsd: t.trigger.triggerPriceUsd
        ? parseFloat(t.trigger.triggerPriceUsd)
        : ticksToUsd(t.trigger.triggerPriceTicks),
      executionPriceUsd: t.trigger.executionPriceUsd
        ? parseFloat(t.trigger.executionPriceUsd)
        : t.trigger.executionPriceTicks
          ? ticksToUsd(t.trigger.executionPriceTicks)
          : undefined,
    })),
  };
}

function ticksToUsd(ticks: string | undefined): number {
  // Phoenix ticks are USDC at 4 decimals (1 tick = $0.01 most markets;
  // exact factor varies by market but 100 ticks/USD is the dominant
  // convention used by our markets).
  if (!ticks) return 0;
  return parseFloat(ticks) / 100;
}

function traderStateToPositions(
  subaccounts: TraderStateSubaccount[],
): PositionState[] {
  const out: PositionState[] = [];
  for (const sa of subaccounts) {
    // Collateral is per-subaccount in Phoenix's Cross-margin model;
    // every position on the subaccount shares the same pool. We
    // attribute the full balance to each position for display — the
    // UI knows to render it as "Cross".
    const collateralUsd = BigInt(sa.collateral ?? "0");
    for (const p of sa.positions ?? []) {
      const state = traderStatePositionToState(p.symbol, p, collateralUsd);
      if (state) out.push(state);
    }
  }
  return out;
}

function fixEmberWithdraw(
  withdrawIxs: { instructions: IInstruction[]; named: { emberWithdraw: unknown } },
  amount: bigint,
): IInstruction[] {
  const broken = withdrawIxs.named.emberWithdraw as {
    accounts: ReadonlyArray<{ address: string }>;
  };
  const fixedEmberWithdraw = buildEmberWithdrawIx({
    owner:        broken.accounts[0]!.address as Authority,
    emberState:   broken.accounts[1]!.address as never,
    inputMint:    broken.accounts[3]!.address as never,
    outputMint:   broken.accounts[2]!.address as never,
    inputTokenAccount:  broken.accounts[5]!.address as never,
    outputTokenAccount: broken.accounts[4]!.address as never,
    emberVault:   broken.accounts[6]!.address as never,
    amount,
  });
  const fixed = [...withdrawIxs.instructions];
  fixed[fixed.length - 1] = fixedEmberWithdraw;
  return fixed;
}

export class RiseVenue implements PerpVenue {
  readonly capabilities: VenueCapabilities = {
    id: "rise",
    name: "Phoenix Eternal",
    orderTypes: ["market", "limit"],
    execution: "atomic",
    traderRegistrationRequired: true,
    collateralMints: [USDC_MINT],
  };

  constructor(private readonly opts: RiseVenueOptions) {}

  // ────────────────────────────────────────────────────────────────
  // open / close
  // ────────────────────────────────────────────────────────────────

  async openPosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: OpenPositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    const { trader, params, onProgress } = opts;
    if (!params.collateralMint.equals(USDC_MINT)) {
      throw new Error("rise: only USDC collateral is supported on Phoenix Eternal");
    }
    if (params.orderType === "limit" && params.priceUsd == null) {
      throw new Error("rise: priceUsd required for limit orders");
    }

    const signer = await web3KeypairToKitSigner(trader);
    const authority = signer.address as Authority;
    const symbol = params.market as PhoenixSymbol;

    const client = createPhoenixClient({
      apiUrl: this.opts.apiUrl ?? DEFAULT_API_URL,
      rpcUrl: this.opts.rpcUrl,
      ws: false,
      exchangeMetadata: { stream: false },
    });
    try {
      await client.exchange.ready();

      const ixs: IInstruction[] = [];

      if (params.collateral > 0n) {
        onProgress?.("building deposit");
        const dep = await client.ixs.buildDepositIxs({ authority, amount: params.collateral });
        ixs.push(...dep.instructions);
      }

      onProgress?.("building place");
      const orderFlags = params.reduceOnly ? OrderFlags.ReduceOnly : OrderFlags.None;
      const placeIx: IInstruction =
        params.orderType === "limit"
          ? params.postOnly
            ? await (async () => {
                // Post-only goes through a dedicated builder so the
                // venue rejects (not just cancels) crossing orders.
                // Builders share most fields; we reuse the limit packet
                // shape and let the SDK adapt.
                const orderPacket = await client.orderPackets.buildLimitOrderPacket({
                  symbol: params.market,
                  side: sideToPhoenix(params.side),
                  priceUsd: (params.priceUsd as number).toString(),
                  baseUnits: params.size,
                  orderFlags,
                });
                return client.ixs.buildPlacePostOnlyOrder({
                  authority, symbol,
                  // The post-only ix accepts a Post-only-shaped packet.
                  // Rise's LimitOrderPacket is structurally compatible
                  // for the fields we set.
                  orderPacket: orderPacket as unknown as Parameters<
                    typeof client.ixs.buildPlacePostOnlyOrder
                  >[0]["orderPacket"],
                });
              })()
            : await (async () => {
                const orderPacket = await client.orderPackets.buildLimitOrderPacket({
                  symbol: params.market,
                  side: sideToPhoenix(params.side),
                  priceUsd: (params.priceUsd as number).toString(),
                  baseUnits: params.size,
                  orderFlags,
                });
                return client.ixs.buildPlaceLimitOrder({ authority, symbol, orderPacket });
              })()
          : await (async () => {
              // TODO: translate `params.slippageBps` to `priceLimitUsd`
              // by fetching mid via client.api/streams and capping at
              // mid * (1 ± slippage). For the v0 shim we submit
              // unbounded — caller is responsible for slippage until
              // this is wired.
              const orderPacket = await client.orderPackets.buildMarketOrderPacket({
                symbol: params.market,
                side: sideToPhoenix(params.side),
                baseUnits: params.size,
                orderFlags,
              });
              return client.ixs.buildPlaceMarketOrder({ authority, symbol, orderPacket });
            })();
      ixs.push(placeIx);

      // Optional TP/SL conditionals attached to the position. Phoenix
      // models these as separate "position conditional" orders that
      // fire when the trigger price is crossed.
      if (params.takeProfitPrice != null || params.stopLossPrice != null) {
        onProgress?.("attaching TP/SL triggers");
        const builder = (client.ixs as unknown as {
          buildPlacePositionConditionalOrder?: (input: Record<string, unknown>) => Promise<IInstruction>;
        }).buildPlacePositionConditionalOrder;
        if (builder) {
          if (params.takeProfitPrice != null) {
            const ix = await builder({
              authority, symbol,
              takeProfitTriggerPrice: params.takeProfitPrice,
              takeProfitExecutionPrice: params.takeProfitPrice,
            });
            ixs.push(ix);
          }
          if (params.stopLossPrice != null) {
            const ix = await builder({
              authority, symbol,
              stopLossTriggerPrice: params.stopLossPrice,
              stopLossExecutionPrice: params.stopLossPrice,
            });
            ixs.push(ix);
          }
        }
      }

      onProgress?.("submitting (atomic)");
      const sig = await sendIxs({ rpcUrl: this.opts.rpcUrl, signer, instructions: ixs });

      return {
        status: "confirmed",
        signatures: [sig],
        requestHandle: encodeHandle(params.market, params.side),
      };
    } finally {
      client.dispose();
    }
  }

  async closePosition(opts: {
    connection: Connection;
    trader: Keypair;
    params: ClosePositionParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    const { trader, params, onProgress } = opts;
    const { market, side } = decodeHandle(params.positionHandle);
    const fraction = params.fraction ?? 1;
    if (fraction <= 0 || fraction > 1) {
      throw new Error(`rise: fraction must be in (0, 1], got ${fraction}`);
    }

    const signer = await web3KeypairToKitSigner(trader);
    const authority = signer.address as Authority;
    const symbol = market as PhoenixSymbol;

    const client = createPhoenixClient({
      apiUrl: this.opts.apiUrl ?? DEFAULT_API_URL,
      rpcUrl: this.opts.rpcUrl,
      ws: false,
      exchangeMetadata: { stream: false },
    });
    try {
      await client.exchange.ready();

      // Pull the live position via traderState WS so we know the
      // exact signed size to flatten.
      const position = await this.getPosition({ connection: opts.connection, trader, positionHandle: params.positionHandle });
      if (!position || BigInt(position.size) === 0n) {
        throw new Error(`rise: no open position for ${params.positionHandle}`);
      }

      // Cancel resting orders on this market first (a partial flatten
      // on top of unfilled bids/asks would skew the close).
      onProgress?.("building cancel-all");
      const cancelIx = await client.ixs.buildCancelAll({ authority, symbol });

      // Flatten by placing an opposite-side market order, sized as
      // currentSize * fraction.
      const flattenSize = scaleBaseUnits(position.size, fraction);
      onProgress?.(`building flatten (${flattenSize} ${market}, ${oppositeSide(side)})`);
      const orderPacket = await client.orderPackets.buildMarketOrderPacket({
        symbol: market,
        side: sideToPhoenix(oppositeSide(side)),
        baseUnits: flattenSize,
      });
      const flattenIx = await client.ixs.buildPlaceMarketOrder({
        authority, symbol, orderPacket,
      });

      onProgress?.("submitting (atomic)");
      const sig = await sendIxs({
        rpcUrl: this.opts.rpcUrl, signer,
        instructions: [cancelIx, flattenIx],
      });
      return { status: "confirmed", signatures: [sig] };
    } finally {
      client.dispose();
    }
  }

  // ────────────────────────────────────────────────────────────────
  // collateral (deposit / withdraw — no position change)
  // ────────────────────────────────────────────────────────────────

  async depositCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: DepositCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    const { trader, params, onProgress } = opts;
    if (!params.collateralMint.equals(USDC_MINT)) {
      throw new Error("rise: only USDC collateral is supported on Phoenix Eternal");
    }

    const signer = await web3KeypairToKitSigner(trader);
    const authority = signer.address as Authority;

    const client = createPhoenixClient({
      apiUrl: this.opts.apiUrl ?? DEFAULT_API_URL,
      rpcUrl: this.opts.rpcUrl,
      ws: false,
      exchangeMetadata: { stream: false },
    });
    try {
      await client.exchange.ready();

      onProgress?.("building deposit");
      const dep = await client.ixs.buildDepositIxs({ authority, amount: params.amount });

      onProgress?.("submitting");
      const sig = await sendIxs({
        rpcUrl: this.opts.rpcUrl, signer,
        instructions: [...dep.instructions],
      });
      return { status: "confirmed", signatures: [sig] };
    } finally {
      client.dispose();
    }
  }

  async withdrawCollateral(opts: {
    connection: Connection;
    trader: Keypair;
    params: WithdrawCollateralParams;
    onProgress?: (status: string) => void;
  }): Promise<VenueOpResult> {
    const { trader, params, onProgress } = opts;
    if (!params.collateralMint.equals(USDC_MINT)) {
      throw new Error("rise: only USDC collateral is supported on Phoenix Eternal");
    }

    const signer = await web3KeypairToKitSigner(trader);
    const authority = signer.address as Authority;

    const client = createPhoenixClient({
      apiUrl: this.opts.apiUrl ?? DEFAULT_API_URL,
      rpcUrl: this.opts.rpcUrl,
      ws: false,
      exchangeMetadata: { stream: false },
    });
    try {
      await client.exchange.ready();

      const amount =
        params.amount === null
          ? await this._readFreeCollateral(client, authority)
          : params.amount;

      onProgress?.(`building withdraw (${amount})`);
      const wd = await client.ixs.buildWithdrawIxs({ authority, amount });
      const fixed = fixEmberWithdraw(wd, amount);

      onProgress?.("submitting");
      const sig = await sendIxs({
        rpcUrl: this.opts.rpcUrl, signer,
        instructions: fixed,
      });
      return { status: "confirmed", signatures: [sig] };
    } finally {
      client.dispose();
    }
  }

  // ────────────────────────────────────────────────────────────────
  // reads
  // ────────────────────────────────────────────────────────────────

  async getPosition(opts: {
    connection: Connection;
    trader: Keypair;
    positionHandle: string;
  }): Promise<PositionState | null> {
    const { market, side } = decodeHandle(opts.positionHandle);
    const all = await this.listPositions(opts);
    return all.find((p) => p.market === market && p.side === side) ?? null;
  }

  async listPositions(opts: {
    connection: Connection;
    trader: Keypair;
  }): Promise<PositionState[]> {
    // One-shot wait: open a traderState WS, take the first snapshot,
    // close. Phoenix sends the full snapshot immediately on subscribe.
    const authority = opts.trader.publicKey.toBase58();
    return new Promise<PositionState[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("rise: listPositions timed out waiting for traderState snapshot"));
      }, 8_000);
      const unsubscribe = streamTraderState(authority, (snap) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(traderStateToPositions(snap.subaccounts));
      });
    });
  }

  /**
   * Subscribe to live position updates for a trader. Each WS push
   * from Phoenix's traderState channel is normalized into a
   * `PositionState[]` and re-emitted to the caller. Returns an
   * unsubscribe handle compatible with the `PerpVenue` contract.
   */
  streamPositions(opts: {
    connection: Connection;
    trader: Keypair;
    onUpdate: (positions: PositionState[]) => void;
    onError?: (err: Error) => void;
  }): Promise<{ unsubscribe: () => void }> {
    const authority = opts.trader.publicKey.toBase58();
    try {
      const stop = streamTraderState(authority, (snap) => {
        try {
          opts.onUpdate(traderStateToPositions(snap.subaccounts));
        } catch (e) {
          opts.onError?.(e instanceof Error ? e : new Error(String(e)));
        }
      });
      return Promise.resolve({ unsubscribe: stop });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // async-only methods (no-op / unsupported on atomic venues)
  // ────────────────────────────────────────────────────────────────

  async awaitSettlement(_opts: {
    connection: Connection;
    trader: Keypair;
    requestHandle: string;
    timeoutMs?: number;
  }): Promise<VenueOpResult> {
    return { status: "confirmed", signatures: [] };
  }

  // No `cancelRequest` — Phoenix has no async request to cancel. The
  // optional method is intentionally omitted.

  // ────────────────────────────────────────────────────────────────
  // internals
  // ────────────────────────────────────────────────────────────────

  // Position reads now go through Phoenix's traderState WS via
  // `streamPositions` / `listPositions` / `getPosition`. The previous
  // `_readPosition` stub has been removed.

  /** TODO: wire to `client.api.getTraderState(authority)` and return
   *  the trader's free (non-locked) USDC collateral. */
  private async _readFreeCollateral(
    _client: ReturnType<typeof createPhoenixClient>,
    _authority: Authority,
  ): Promise<bigint> {
    throw new Error("rise: _readFreeCollateral not implemented in v0 shim");
  }
}

/** Multiply a base-unit string ("0.01") by a fraction in [0,1] without
 *  losing precision in the common case where the result is still a tidy
 *  decimal. Falls back to JS number math otherwise. */
function scaleBaseUnits(size: string, fraction: number): string {
  if (fraction === 1) return size;
  const n = parseFloat(size);
  if (!Number.isFinite(n)) throw new Error(`invalid base-units string: ${size}`);
  const scaled = n * fraction;
  // Strip trailing zeros; preserve at most 9 decimals (lamport precision).
  return scaled.toFixed(9).replace(/\.?0+$/, "");
}
