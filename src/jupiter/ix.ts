/**
 * Instruction builders for Jupiter Perps trader-side requests.
 *
 * What lives here:
 *   - `buildIncreaseRequestIx`   — open / increase / pure-deposit
 *   - `buildDecreaseRequestIx`   — close / reduce / pure-withdraw
 *   - `buildCloseRequestIx`      — cancel a pending request
 *
 * What does NOT live here:
 *   - Limit-order or TP/SL trigger ixs. Limit-entry is keeper-only.
 *     TP/SL on existing positions is via `createDecreasePositionRequest2`
 *     (out of scope for v0; would need its own helper).
 *
 * Each builder returns the instructions array (pre + main + post) and
 * the request handle the caller should poll on. The caller assembles
 * the v0 transaction and submits.
 */

import { BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CUSTODIES,
  JLP_POOL,
  MINTS,
  type CustodySymbol,
  type MarketBase,
} from "./constants.js";
import { encodeRequestHandle } from "./handle.js";
import { findMarket } from "./markets.js";
import { generatePositionPda, generatePositionRequestPda, perpetualsPda } from "./pdas.js";
import type { JupiterProgram } from "./program.js";
import type { Side } from "../core/index.js";

const SIDE_VARIANT = (side: Side) => (side === "long" ? { long: {} } : { short: {} });

const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;
const DEFAULT_COMPUTE_UNIT_PRICE = 100_000; // micro-lamports — placeholder, prod should fetch

export interface IncreaseRequestParams {
  program: JupiterProgram;
  owner: PublicKey;
  market: MarketBase;
  side: Side;
  /** Position size in USD-6dp (notional). Pass `0n` for pure-deposit. */
  sizeUsdDelta: bigint;
  /** Amount of `inputMint` to post in this op (token base units). */
  collateralTokenDelta: bigint;
  /** Mint of the token being posted. NATIVE_MINT triggers wSOL wrap. */
  inputMint: PublicKey;
  /** Acceptable price slippage on the open execution (USD-6dp around mark). */
  priceSlippage: bigint;
  /** Required when `inputMint` ≠ custody mint; ignored otherwise.
   *  See Jupiter Quote API v6 — pass the minOut from the quote. */
  jupiterMinimumOut?: bigint | null;
  /** Override which stable backs a Short position (default USDC). */
  stableSide?: "USDC" | "USDT";
  /** Optional explicit counter for deterministic request handles in tests. */
  counter?: bigint;
}

export interface IncreaseRequestResult {
  instructions: TransactionInstruction[];
  position: PublicKey;
  positionRequest: PublicKey;
  requestHandle: string;
  counter: bigint;
}

export async function buildIncreaseRequestIx(
  p: IncreaseRequestParams,
): Promise<IncreaseRequestResult> {
  const market = findMarket(p.market, p.side, p.stableSide ?? "USDC");
  const { position } = generatePositionPda({
    trader: p.owner,
    market: p.market,
    side: p.side,
    stableSide: p.stableSide ?? "USDC",
  });
  const counterBn = p.counter !== undefined ? new BN(p.counter.toString()) : undefined;
  const { positionRequest, counter } = generatePositionRequestPda({
    position,
    counter: counterBn,
    requestChange: "increase",
  });
  const positionRequestAta = getAssociatedTokenAddressSync(
    p.inputMint,
    positionRequest,
    true,
  );
  const fundingAccount = getAssociatedTokenAddressSync(p.inputMint, p.owner);

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  if (p.inputMint.equals(NATIVE_MINT)) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(p.owner, fundingAccount, p.owner, NATIVE_MINT),
      SystemProgram.transfer({
        fromPubkey: p.owner,
        toPubkey: fundingAccount,
        lamports: p.collateralTokenDelta,
      }),
      createSyncNativeInstruction(fundingAccount),
    );
    postInstructions.push(createCloseAccountInstruction(fundingAccount, p.owner, p.owner));
  }

  const increaseIx = await p.program.methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .createIncreasePositionMarketRequest({
      counter,
      collateralTokenDelta: new BN(p.collateralTokenDelta.toString()),
      jupiterMinimumOut:
        p.jupiterMinimumOut !== undefined && p.jupiterMinimumOut !== null
          ? new BN(p.jupiterMinimumOut.toString())
          : null,
      priceSlippage: new BN(p.priceSlippage.toString()),
      side: SIDE_VARIANT(p.side) as any,
      sizeUsdDelta: new BN(p.sizeUsdDelta.toString()),
    })
    .accounts({
      custody: market.custody,
      collateralCustody: market.collateralCustody,
      fundingAccount,
      inputMint: p.inputMint,
      owner: p.owner,
      perpetuals: perpetualsPda(),
      pool: JLP_POOL,
      position,
      positionRequest,
      positionRequestAta,
      referral: null,
    })
    .instruction();

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_UNIT_PRICE }),
    ...preInstructions,
    increaseIx,
    ...postInstructions,
  ];

  return {
    instructions,
    position,
    positionRequest,
    counter: BigInt(counter.toString()),
    requestHandle: encodeRequestHandle(p.market, p.side, BigInt(counter.toString())),
  };
}

export interface DecreaseRequestParams {
  program: JupiterProgram;
  owner: PublicKey;
  market: MarketBase;
  side: Side;
  /** Notional reduction in USD-6dp. Pass `0n` for pure-withdraw. */
  sizeUsdDelta: bigint;
  /** Collateral withdrawal in USD-6dp. Pass `0n` for pure-close. */
  collateralUsdDelta: bigint;
  /** Mint we want the funds returned in. */
  desiredMint: PublicKey;
  /** USD-6dp slippage on the close execution. */
  priceSlippage: bigint;
  /** True for full close; ignored when sizeUsdDelta < currentSize. */
  entirePosition?: boolean;
  jupiterMinimumOut?: bigint | null;
  stableSide?: "USDC" | "USDT";
  counter?: bigint;
}

export interface DecreaseRequestResult {
  instructions: TransactionInstruction[];
  position: PublicKey;
  positionRequest: PublicKey;
  requestHandle: string;
  counter: bigint;
}

export async function buildDecreaseRequestIx(
  p: DecreaseRequestParams,
): Promise<DecreaseRequestResult> {
  const market = findMarket(p.market, p.side, p.stableSide ?? "USDC");
  const { position } = generatePositionPda({
    trader: p.owner,
    market: p.market,
    side: p.side,
    stableSide: p.stableSide ?? "USDC",
  });
  const counterBn = p.counter !== undefined ? new BN(p.counter.toString()) : undefined;
  const { positionRequest, counter } = generatePositionRequestPda({
    position,
    counter: counterBn,
    requestChange: "decrease",
  });
  const positionRequestAta = getAssociatedTokenAddressSync(
    p.desiredMint,
    positionRequest,
    true,
  );

  const decreaseIx = await p.program.methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .createDecreasePositionMarketRequest({
      counter,
      collateralUsdDelta: new BN(p.collateralUsdDelta.toString()),
      sizeUsdDelta: new BN(p.sizeUsdDelta.toString()),
      priceSlippage: new BN(p.priceSlippage.toString()),
      jupiterMinimumOut:
        p.jupiterMinimumOut !== undefined && p.jupiterMinimumOut !== null
          ? new BN(p.jupiterMinimumOut.toString())
          : null,
      entirePosition: p.entirePosition ?? null,
    })
    .accounts({
      custody: market.custody,
      collateralCustody: market.collateralCustody,
      receivingAccount: getAssociatedTokenAddressSync(p.desiredMint, p.owner),
      desiredMint: p.desiredMint,
      owner: p.owner,
      perpetuals: perpetualsPda(),
      pool: JLP_POOL,
      position,
      positionRequest,
      positionRequestAta,
      referral: null,
    })
    .instruction();

  const preInstructions: TransactionInstruction[] = [];
  if (p.desiredMint.equals(NATIVE_MINT)) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        p.owner,
        getAssociatedTokenAddressSync(p.desiredMint, p.owner),
        p.owner,
        NATIVE_MINT,
      ),
    );
  }

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_COMPUTE_UNIT_PRICE }),
    ...preInstructions,
    decreaseIx,
  ];

  return {
    instructions,
    position,
    positionRequest,
    counter: BigInt(counter.toString()),
    requestHandle: encodeRequestHandle(p.market, p.side, BigInt(counter.toString())),
  };
}

export interface CloseRequestParams {
  program: JupiterProgram;
  owner: PublicKey;
  positionRequest: PublicKey;
  position: PublicKey;
  /** The mint that backs the request's positionRequestAta. */
  mint: PublicKey;
}

export async function buildCloseRequestIx(
  p: CloseRequestParams,
): Promise<TransactionInstruction[]> {
  const positionRequestAta = getAssociatedTokenAddressSync(p.mint, p.positionRequest, true);
  const ownerAta = getAssociatedTokenAddressSync(p.mint, p.owner);

  const preInstructions: TransactionInstruction[] = [
    // Idempotent so it works whether or not the user has the ATA already.
    createAssociatedTokenAccountIdempotentInstruction(p.owner, ownerAta, p.owner, p.mint),
  ];
  const postInstructions: TransactionInstruction[] = [];
  if (p.mint.equals(NATIVE_MINT)) {
    // Unwrap the refunded wSOL back to native SOL after the close.
    postInstructions.push(createCloseAccountInstruction(ownerAta, p.owner, p.owner));
  }

  const closeIx = await p.program.methods
    .closePositionRequest2()
    .accounts({
      keeper: null,
      owner: p.owner,
      ownerAta,
      pool: JLP_POOL,
      positionRequest: p.positionRequest,
      positionRequestAta,
      position: p.position,
      mint: p.mint,
    })
    .instruction();

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ...preInstructions,
    closeIx,
    ...postInstructions,
  ];
}

/** Resolve which mint corresponds to a custody for default deposit/withdraw paths. */
export function mintForCollateralCustody(
  market: MarketBase,
  side: Side,
  stableSide: "USDC" | "USDT" = "USDC",
): { custodySymbol: CustodySymbol; mint: PublicKey } {
  const m = findMarket(market, side, stableSide);
  const symbol: CustodySymbol = m.collateralSymbol;
  return { custodySymbol: symbol, mint: MINTS[symbol] };
}

void CUSTODIES;
