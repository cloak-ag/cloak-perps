/**
 * Jupiter Perpetuals mainnet constants. Verified live by the
 * pre-implementation probe pass (see resolution of Unknowns #1–#3).
 */

import { PublicKey } from "@solana/web3.js";

export const JUPITER_PERPETUALS_PROGRAM_ID = new PublicKey(
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu",
);

export const JUPITER_PERPETUALS_EVENT_AUTHORITY = new PublicKey(
  "37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN",
);

export const JLP_POOL = new PublicKey(
  "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq",
);

export const DOVES_PROGRAM_ID = new PublicKey(
  "DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e",
);

/**
 * Custody PDAs on JLP. Index matches `pool.custodies` order on chain.
 *
 *   - SOL  (volatile, tradable as Long collateral and via shorts collateralized in USDC/USDT)
 *   - ETH  (volatile, wormhole-wrapped mint)
 *   - BTC  (volatile, wormhole-wrapped mint)
 *   - USDC (stable, collateral-only)
 *   - USDT (stable, collateral-only)
 */
export const CUSTODIES = {
  SOL:  new PublicKey("7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz"),
  ETH:  new PublicKey("AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn"),
  BTC:  new PublicKey("5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm"),
  USDC: new PublicKey("G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa"),
  USDT: new PublicKey("4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk"),
} as const;

export const MINTS = {
  SOL:  new PublicKey("So11111111111111111111111111111111111111112"),
  ETH:  new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
  BTC:  new PublicKey("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"),
  USDC: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  USDT: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
} as const;

export type CustodySymbol = keyof typeof CUSTODIES;
export type MarketBase = "SOL" | "ETH" | "BTC";

/**
 * Pool-level config snapshot, read live by the probe pass.
 * Used as a default; the adapter re-reads on each call to stay current.
 */
export const POOL_CONFIG_SNAPSHOT = {
  /** Keeper has this many seconds to execute or auto-rejects. */
  maxRequestExecutionSec: 45,
  /** Doves/Pyth oracle staleness tolerance per custody (uniform). */
  maxPriceAgeSec: 5,
  /** Open + close fee in basis points per custody (uniform). */
  positionFeeBps: 6,
  /** Max leverage parameter (BPS denominator; effective = sizeUsd*BPS/maxLeverage). */
  maxLeverageBps: 5_000_000,
} as const;
