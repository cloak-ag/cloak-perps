/**
 * Phoenix Flight builder-fee surface — independent of the privacy boundary
 * but lives in this integration because it's how Cloak captures economic
 * value on perp orders routed through its UI/SDK.
 *
 * Flight is a thin proxy program that wraps Phoenix order instructions so
 * a registered "builder" trader account collects a fee (capped at 10 bps
 * by the on-chain global state) on every routed limit/market order.
 *
 * Two functions:
 *   - registerFlightBuilder    — one-time mainnet ix to register Cloak's
 *                                builder authority on Flight at fee_bps
 *   - placeFlightWrappedOrder  — build + submit a Phoenix place_limit_order
 *                                wrapped through Flight so the builder
 *                                trader collects fees on fill
 *
 * Library:
 *   import { placeFlightWrappedOrder } from "../rise/index.js";
 *
 * CLI (env-driven):
 *   AUTHORITY=<your trader authority>
 *   BUILDER_AUTHORITY=<cloak builder authority>     # default: same as AUTHORITY
 *   BUILDER_TRADER=<cloak builder's Phoenix trader PDA>
 *   FEE_BPS=10
 *   SOLANA_RPC_URL=https://your-mainnet-rpc
 *   SYMBOL=SOL SIDE=bid PRICE_USD=50 BASE_UNITS=0.01
 *   npx tsx src/flight.ts              # simulate place (no signing)
 *   ACTION=register npx tsx src/flight.ts  # register the builder (signs!)
 */

import {
  Side as PhoenixSide,
  createPhoenixClient,
  flight,
  type Authority,
  type Symbol as PhoenixSymbol,
  type TraderAddress,
} from "@ellipsis-labs/rise";

const { buildRegisterBuilderIx, wrapInstructionWithFlight } = flight;
import { type Address, type KeyPairSigner } from "@solana/kit";
import { Keypair as Web3Keypair } from "@solana/web3.js";

import { sendIxs } from "./lib/kit-send.js";
import { web3KeypairToKitSigner } from "./lib/kit-signer.js";

const DEFAULT_API_URL = "https://perp-api.phoenix.trade";
const FLIGHT_FEE_BPS_CAP = 10n;

// ─────────────────────────────────────────────────────────────────────────
// Register Cloak as a Flight builder. One-time mainnet operation.
// ─────────────────────────────────────────────────────────────────────────

export interface RegisterFlightBuilderOptions {
  rpcUrl: string;
  /** Builder authority signer — must already be a registered Phoenix trader. */
  builderAuthority: Web3Keypair | KeyPairSigner;
  /** Fee charged in basis points (0–10 per current on-chain global cap). */
  feeBps: number | bigint;
  /** Phoenix trader pda_index for the builder's collector trader (default 0). */
  builderPdaIndex?: number;
  /** Phoenix trader subaccount_index for the collector trader (default 0). */
  builderSubaccountIndex?: number;
}

export async function registerFlightBuilder(opts: RegisterFlightBuilderOptions): Promise<string> {
  const fee = BigInt(opts.feeBps);
  if (fee > FLIGHT_FEE_BPS_CAP) {
    throw new Error(
      `feeBps=${fee} exceeds Flight global cap of ${FLIGHT_FEE_BPS_CAP} bps. ` +
      `Update once Ellipsis raises the cap.`,
    );
  }
  const signer = await asKitSigner(opts.builderAuthority);
  const ix = await buildRegisterBuilderIx({
    traderAuthority: signer.address as Authority,
    traderPdaIndex: opts.builderPdaIndex ?? 0,
    traderSubaccountIndex: opts.builderSubaccountIndex ?? 0,
    feeBps: fee,
  });
  return sendIxs({ rpcUrl: opts.rpcUrl, signer, instructions: [ix] });
}

// ─────────────────────────────────────────────────────────────────────────
// Place a Phoenix limit order wrapped through Flight so the builder trader
// collects fees on fill.
// ─────────────────────────────────────────────────────────────────────────

export interface PlaceFlightWrappedOrderOptions {
  rpcUrl: string;
  apiUrl?: string;
  /** Trader authority — the user placing the order. Pays Phoenix fees + Flight builder fee on fill. */
  T: Web3Keypair | KeyPairSigner;
  /** Cloak's Flight builder authority (the one that called registerFlightBuilder). */
  builderAuthority: Address | string;
  /** Cloak's Phoenix trader PDA (the builder's fee-collector account). */
  builderTrader: Address | string;
  builderPdaIndex?: number;
  builderSubaccountIndex?: number;
  symbol: string;
  side: "bid" | "ask";
  priceUsd: number;
  baseUnits: string;
  onProgress?: (status: string) => void;
}

export interface PlaceFlightWrappedOrderResult {
  signature: string;
  builderAuthority: string;
  builderTrader: string;
  symbol: string;
}

export async function placeFlightWrappedOrder(
  opts: PlaceFlightWrappedOrderOptions,
): Promise<PlaceFlightWrappedOrderResult> {
  const signer = await asKitSigner(opts.T);
  const authority = signer.address as Authority;
  const symbol = opts.symbol as PhoenixSymbol;
  const builderAuthority = (typeof opts.builderAuthority === "string"
    ? opts.builderAuthority
    : opts.builderAuthority) as Authority;
  const builderTrader = (typeof opts.builderTrader === "string"
    ? opts.builderTrader
    : opts.builderTrader) as TraderAddress;

  const client = createPhoenixClient({
    apiUrl: opts.apiUrl ?? DEFAULT_API_URL,
    rpcUrl: opts.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  try {
    await client.exchange.ready();

    opts.onProgress?.("building order packet");
    const orderPacket = await client.orderPackets.buildLimitOrderPacket({
      symbol: opts.symbol,
      side: opts.side === "bid" ? PhoenixSide.Bid : PhoenixSide.Ask,
      priceUsd: opts.priceUsd.toString(),
      baseUnits: opts.baseUnits,
    });
    const innerIx = await client.ixs.buildPlaceLimitOrder({
      authority, symbol, orderPacket,
    });

    opts.onProgress?.("wrapping with Flight");
    const wrapped = await wrapInstructionWithFlight({
      phoenixInstruction: innerIx,
      authority,
      phoenixProgramAddress: client.pda.getProgramAddress(),
      flight: {
        builderAuthority,
        builderPdaIndex: opts.builderPdaIndex ?? 0,
        builderSubaccountIndex: opts.builderSubaccountIndex ?? 0,
      },
      resolveFeeCollectorTraderAddress: async () => builderTrader,
    });

    opts.onProgress?.("submitting");
    const signature = await sendIxs({
      rpcUrl: opts.rpcUrl, signer, instructions: [wrapped],
    });
    return {
      signature,
      builderAuthority: builderAuthority.toString(),
      builderTrader: builderTrader.toString(),
      symbol: opts.symbol,
    };
  } finally {
    client.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function asKitSigner(T: Web3Keypair | KeyPairSigner): Promise<KeyPairSigner> {
  if ("address" in T) return T;
  return web3KeypairToKitSigner(T);
}
