/**
 * Unit tests for the aggregator. Mock venues — no network.
 *
 *   npx tsx test/core/aggregator.test.ts
 */

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  Aggregator,
  chooseVenue,
  defaultVenueScore,
} from "../../src/core/aggregator.js";
import type { PerpVenue } from "../../src/core/venue.js";
import type {
  OpenPositionParams,
  PositionState,
  VenueCapabilities,
  VenueOpResult,
} from "../../src/core/types.js";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const SOL = new PublicKey("So11111111111111111111111111111111111111112");

interface MockOptions {
  positions?: PositionState[];
  openResult?: VenueOpResult;
  /** Throw on open if true. */
  failOpen?: boolean;
}

function mockVenue(
  cap: Partial<VenueCapabilities> & Pick<VenueCapabilities, "id">,
  opts: MockOptions = {},
): PerpVenue {
  const capabilities: VenueCapabilities = {
    name: cap.id,
    orderTypes: ["market", "limit"],
    execution: "atomic",
    traderRegistrationRequired: false,
    collateralMints: [USDC],
    ...cap,
  };
  const positions = opts.positions ?? [];
  const venue: PerpVenue = {
    capabilities,
    async openPosition(o: { params: OpenPositionParams }): Promise<VenueOpResult> {
      if (opts.failOpen) throw new Error(`${cap.id} mock open failure`);
      return opts.openResult ?? {
        status: "confirmed",
        signatures: ["mock-sig"],
        requestHandle: `${cap.id}/${o.params.market}/${o.params.side}`,
      };
    },
    async closePosition(): Promise<VenueOpResult> {
      return { status: "confirmed", signatures: ["mock-close-sig"] };
    },
    async depositCollateral(): Promise<VenueOpResult> {
      return { status: "confirmed", signatures: ["mock-dep-sig"] };
    },
    async withdrawCollateral(): Promise<VenueOpResult> {
      return { status: "confirmed", signatures: ["mock-wd-sig"] };
    },
    async getPosition({ positionHandle }): Promise<PositionState | null> {
      return positions.find((p) => p.handle === positionHandle) ?? null;
    },
    async listPositions(): Promise<PositionState[]> {
      return positions;
    },
    async awaitSettlement(): Promise<VenueOpResult> {
      return { status: "confirmed", signatures: [] };
    },
  };
  return venue;
}

const fakeConn = {} as never;
const fakeTrader = Keypair.generate();

// ── default score: atomic > async ──────────────────────────────
{
  const atomic = mockVenue({ id: "rise", execution: "atomic" });
  const async_ = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] });
  assert.ok(
    defaultVenueScore(atomic, {} as never) > defaultVenueScore(async_, {} as never),
    "atomic should outscore async",
  );
}

// ── chooseVenue: orderType filter ──────────────────────────────
{
  const onlyMarket = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] });
  const both = mockVenue({ id: "rise", execution: "atomic", orderTypes: ["market", "limit"] });
  const sel = chooseVenue(
    { market: "SOL", side: "long", orderType: "limit", collateralMint: USDC },
    [onlyMarket, both],
  );
  assert.equal(sel.venue.capabilities.id, "rise", "limit-order intent must pick the venue with limit support");
}

// ── chooseVenue: collateral filter ─────────────────────────────
{
  const usdcOnly = mockVenue({ id: "rise", collateralMints: [USDC] });
  const multi = mockVenue({ id: "jupiter", collateralMints: [USDC, USDT, SOL] });
  const sel1 = chooseVenue(
    { market: "SOL", side: "long", orderType: "market", collateralMint: USDC },
    [usdcOnly, multi],
  );
  assert.equal(sel1.venue.capabilities.id, "rise");
  const sel2 = chooseVenue(
    { market: "SOL", side: "long", orderType: "market", collateralMint: SOL },
    [usdcOnly, multi],
  );
  assert.equal(sel2.venue.capabilities.id, "jupiter");
}

// ── chooseVenue: throws when no match ──────────────────────────
{
  const venue = mockVenue({ id: "rise", orderTypes: ["limit"], collateralMints: [USDC] });
  assert.throws(
    () => chooseVenue(
      { market: "SOL", side: "long", orderType: "market", collateralMint: USDT },
      [venue],
    ),
    /no compatible venue/,
  );
}

// ── Aggregator.openPosition routes correctly ───────────────────
{
  const a = mockVenue({ id: "rise", execution: "atomic" });
  const b = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] });
  const agg = new Aggregator([a, b]);
  const result = await agg.openPosition({
    connection: fakeConn,
    trader: fakeTrader,
    params: {
      market: "SOL", side: "long", orderType: "market",
      size: "100", collateral: 10n, collateralMint: USDC,
    },
  });
  assert.equal(result.venueId, "rise");
  assert.equal(result.status, "confirmed");
}

// ── Aggregator.openMulti opens across venues in parallel ───────
{
  const a = mockVenue({ id: "rise", execution: "atomic", orderTypes: ["market", "limit"] });
  const b = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] });
  const agg = new Aggregator([a, b]);

  const outcomes = await agg.openMulti({
    connection: fakeConn,
    trader: fakeTrader,
    intents: [
      {
        market: "SOL", side: "long", orderType: "limit",
        size: "1", collateral: 10n, collateralMint: USDC,
      },
      {
        market: "BTC", side: "short", orderType: "market",
        size: "1", collateral: 10n, collateralMint: USDC,
      },
    ],
  });
  assert.equal(outcomes.length, 2);
  // Limit intent → only rise supports it
  assert.equal(outcomes[0].venueId, "rise");
  assert.equal(outcomes[0].ok, true);
  // Market intent → atomic rise outscores async jupiter on default score
  assert.equal(outcomes[1].venueId, "rise");
  assert.equal(outcomes[1].ok, true);
}

// ── Aggregator.openMulti tolerates per-intent failure ──────────
{
  // rise only supports limit; jupiter only supports market. So the
  // limit intent must route to rise (which fails), and the market
  // intent must route to jupiter (which succeeds).
  const a = mockVenue({ id: "rise", execution: "atomic", orderTypes: ["limit"] }, { failOpen: true });
  const b = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] });
  const agg = new Aggregator([a, b]);
  const outcomes = await agg.openMulti({
    connection: fakeConn,
    trader: fakeTrader,
    intents: [
      // Forced to rise via limit orderType; rise will throw.
      { market: "SOL", side: "long", orderType: "limit",
        size: "1", collateral: 10n, collateralMint: USDC, priceUsd: 100 },
      // Goes to jupiter (async); succeeds.
      { market: "BTC", side: "short", orderType: "market",
        size: "1", collateral: 10n, collateralMint: USDC },
    ],
  });
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].error ?? "", /mock open failure/);
  assert.equal(outcomes[1].ok, true);
  assert.equal(outcomes[1].venueId, "jupiter");
}

// ── Aggregator.listPositions merges across venues ──────────────
{
  const riseP: PositionState = {
    handle: "rise/SOL/long", market: "SOL", side: "long",
    size: "1", collateral: 10n, collateralMint: USDC,
    unrealizedPnl: 0n, funding: 0n,
  };
  const jupP: PositionState = {
    handle: "jupiter/BTC/short", market: "BTC", side: "short",
    size: "1", collateral: 10n, collateralMint: USDC,
    unrealizedPnl: 0n, funding: 0n,
  };
  const a = mockVenue({ id: "rise" }, { positions: [riseP] });
  const b = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] }, { positions: [jupP] });
  const agg = new Aggregator([a, b]);
  const all = await agg.listPositions({ connection: fakeConn, trader: fakeTrader });
  assert.equal(all.length, 2);
  assert.ok(all.some((p) => p.handle === "rise/SOL/long"));
  assert.ok(all.some((p) => p.handle === "jupiter/BTC/short"));
}

// ── Aggregator.getPosition routes by handle prefix ─────────────
{
  const riseP: PositionState = {
    handle: "rise/SOL/long", market: "SOL", side: "long",
    size: "1", collateral: 10n, collateralMint: USDC,
    unrealizedPnl: 0n, funding: 0n,
  };
  const a = mockVenue({ id: "rise" }, { positions: [riseP] });
  const b = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] });
  const agg = new Aggregator([a, b]);
  const got = await agg.getPosition({
    connection: fakeConn, trader: fakeTrader, positionHandle: "rise/SOL/long",
  });
  assert.ok(got !== null);
  assert.equal(got!.handle, "rise/SOL/long");
  const miss = await agg.getPosition({
    connection: fakeConn, trader: fakeTrader, positionHandle: "unknown/foo/bar",
  });
  assert.equal(miss, null);
}

// ── closeAll fans out across all open positions ────────────────
{
  const riseP: PositionState = {
    handle: "rise/SOL/long", market: "SOL", side: "long",
    size: "1", collateral: 10n, collateralMint: USDC,
    unrealizedPnl: 0n, funding: 0n,
  };
  const jupP: PositionState = {
    handle: "jupiter/BTC/short", market: "BTC", side: "short",
    size: "1", collateral: 10n, collateralMint: USDC,
    unrealizedPnl: 0n, funding: 0n,
  };
  const a = mockVenue({ id: "rise" }, { positions: [riseP] });
  const b = mockVenue({ id: "jupiter", execution: "async", orderTypes: ["market"] }, { positions: [jupP] });
  const agg = new Aggregator([a, b]);
  const results = await agg.closeAll({ connection: fakeConn, trader: fakeTrader });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
}

// ── Aggregator throws if constructed empty ─────────────────────
{
  let caught = false;
  try { new Aggregator([]); } catch { caught = true; }
  assert.ok(caught);
}

console.log("aggregator.test.ts: ok");
