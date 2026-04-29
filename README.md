# @cloak.dev/perps

Privacy-first perpetuals integration kit for Solana. One package, one
`PerpVenue` interface, two adapters (Phoenix Eternal — atomic; Jupiter
Perpetuals — async, keeper-executed), and a Cloak-shielded-pool funding
boundary so the funding wallet `W` is unlinkable from the trading
wallet `T` on chain.

Depends only on **published** SDKs from npm — no internal Cloak code,
no local relay. The Cloak SDK defaults to Cloak's hosted relay at
`https://api.cloak.ag`.

## Install

```
npm install @cloak.dev/perps
```

## Use

```ts
import {
  fundTargetFromUsdc, reshieldUsdc,        // Cloak primitives
  Aggregator,                                // multi-venue router
  RiseVenue, JupiterVenue,                  // venue adapters
  type PerpVenue, type TradeIntent,         // interface + types
} from "@cloak.dev/perps";

// Or via namespace sub-paths (better for tree-shaking):
import { fundTargetFromUsdc } from "@cloak.dev/perps/cloak";
import { Aggregator }         from "@cloak.dev/perps/core";
import { JupiterVenue }       from "@cloak.dev/perps/jupiter";
import { RiseVenue }          from "@cloak.dev/perps/rise";

// Node-only helpers (file → Keypair):
import { loadKeypair } from "@cloak.dev/perps/node";
```

### Wallet shapes

`W` (the funding wallet) accepts either a `Keypair` (script use) or a
wallet-adapter-shaped object (`{ publicKey, signTransaction, … }`) — so
the same code works for CLI tools and browser frontends.

`T` (the trading wallet) is always a `Keypair`. If you don't pass one,
`fundTargetFromUsdc` generates a fresh one and returns it in the
result. Persist it locally (e.g., `localStorage`); it never leaves your
process.

```ts
// Browser flow:
const { TKeypair, TGenerated } = await fundTargetFromUsdc({
  connection,
  W: phantomAdapter,        // any wallet-adapter-shaped signer
  T: undefined,             // → auto-generated
  tSol: 0.005, tUsdc: 0.5,
});
if (TGenerated) localStorage.setItem("cloak-perps-T", JSON.stringify(Array.from(TKeypair.secretKey)));
```

### Multi-venue (Synthesis-style)

```ts
const aggregator = new Aggregator([
  new RiseVenue({ rpcUrl }),
  new JupiterVenue({ rpcUrl }),
]);

const outcomes = await aggregator.openMulti({
  connection, trader: T,
  intents: [
    { market: "SOL", side: "long",  orderType: "limit",  ... },  // → Phoenix (Rise)
    { market: "BTC", side: "short", orderType: "market", ... },  // → Jupiter
  ],
});
// One T, two venues, parallel submission. Each intent picks the
// best-scoring compatible venue.
```

## Layout

```
@cloak.dev/perps/
├── package.json                              single package
├── src/
│   ├── index.ts                              top-level re-exports
│   ├── core/                                 PerpVenue interface + shared types
│   │   ├── venue.ts                          PerpVenue contract
│   │   ├── types.ts                          OpenPositionParams, PositionState, …
│   │   └── index.ts
│   ├── cloak/                                Cloak privacy primitives (browser-safe)
│   │   ├── fund-target-from-usdc.ts          Case A: W has USDC, no swap
│   │   ├── fund-target-from-sol.ts           Case B: W has SOL, Cloak shielded-swaps
│   │   ├── reshield-usdc.ts                  re-shield USDC after a perp exit
│   │   └── lib/{fees,jupiter-quote}.ts
│   ├── rise/                                 Phoenix Eternal adapter (atomic)
│   │   ├── venue.ts                          RiseVenue → PerpVenue
│   │   ├── phoenix-lifecycle.ts              Ember+Deposit / place / cancel / Withdraw+Ember-w
│   │   ├── full-pipeline.ts                  composed Cloak fund + Phoenix + re-shield
│   │   ├── flight.ts                         Flight builder-fee surface
│   │   ├── jito-bundles.ts                   entry/exit Jito bundles
│   │   └── lib/{kit-send,kit-signer,jito}.ts
│   ├── jupiter/                              Jupiter Perpetuals adapter (async)
│   │   ├── venue.ts                          JupiterVenue → PerpVenue
│   │   ├── full-pipeline.ts                  composed Cloak fund + Jupiter + re-shield
│   │   ├── ix.ts                             ix builders (open / close / deposit / withdraw / cancel)
│   │   ├── pdas.ts                           Position / PositionRequest seed-derivation
│   │   ├── handle.ts                         position + request handle encoding
│   │   ├── markets.ts                        9-market table (3 longs + 6 shorts)
│   │   ├── decode.ts                         Anchor IDL decoders
│   │   ├── free-collateral.ts                drain-free withdraw math
│   │   ├── program.ts                        Anchor Program client
│   │   ├── constants.ts
│   │   └── idl/                              vendored Anchor IDL (ISC)
│   └── node/                                 Node-only helpers
│       ├── keypair.ts                        loadKeypair (file → Keypair)
│       └── index.ts
├── examples/                                 runnable end-to-end CLIs
│   ├── rise-flow.ts
│   └── jupiter-flow.ts
└── test/                                     unit + surfpool integration
    └── jupiter/
```

## Why this shape

`core/` is **venue-agnostic**: the `PerpVenue` interface plus shared
types. Every venue adapter conforms to it.

`cloak/` is **venue-agnostic** too — the privacy primitives don't care
which perp T trades on. They live here so any venue (or any non-perp
use case) can drop in.

`rise/` and `jupiter/` are the per-venue adapters. They depend on
`core/` for types and `cloak/` only when composing the full pipeline.
The aggregator does not paper over orderbook (atomic) vs. oracle/JLP
(async, keeper-executed) settlement differences — those leak as
`capabilities.execution: "atomic" | "async"` so callers can surface
honest UX.

## Venues

| sub-path | venue | shape | status |
|---|---|---|---|
| `@cloak.dev/perps/rise`    | Phoenix Eternal (Ellipsis Labs Rise SDK) | orderbook, atomic; cross-margin trader PDA; Flight builder-fee surface | mainnet-ready |
| `@cloak.dev/perps/jupiter` | Jupiter Perpetuals                       | oracle/JLP, async (keeper-executed); pure-deposit + drain-free withdraw supported | mainnet-ready |

## Adding a venue

1. Create `src/<venue>/` with the adapter sources.
2. Implement `PerpVenue` from `@cloak.dev/perps/core`:
   - `capabilities` — declare `execution: "atomic" | "async"`,
     `orderTypes`, `traderRegistrationRequired`, `collateralMints`.
   - `openPosition` / `closePosition` — the trade-side glue.
   - `awaitSettlement` — no-op for atomic, polling loop for async.
   - `cancelRequest` — implement only on async venues with a refund path.
3. Re-export from `src/<venue>/index.ts` and add a sub-path in
   `package.json`'s `exports` field.
4. Optionally compose a `full-pipeline.ts` that chains
   `fundTargetFrom{Usdc,Sol}` → `openPosition` → `closePosition` →
   `reshieldUsdc` for that venue.

## Shared invariants

- **Funding-layer privacy only.** Cloak shields the on/off-ramp; the
  trade itself stays public on the partner protocol.
- **Cloak fees** are `5_000_000 lamports + 0.3%` per `Transact*` op.
  The `fundTarget*` helpers gross both legs up so post-fee deliveries
  to T match what you asked for.
- **No direct W→T transfer.** Both inflows to T must come through
  Cloak pool unshields for the privacy property to hold.
