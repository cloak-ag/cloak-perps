/**
 * Jito Block Engine bundle primitives.
 *
 * A Jito bundle is up to 5 transactions submitted together to the Block
 * Engine — included atomically in the same slot, in order, by Jito-aware
 * leaders. Each bundle requires a SOL tip transfer to one of Jito's
 * known tip accounts; we attach the tip to the last tx as a final
 * SystemProgram.transfer instruction.
 *
 * Production endpoint examples:
 *   - https://mainnet.block-engine.jito.wtf
 *   - https://amsterdam.mainnet.block-engine.jito.wtf
 *   - https://frankfurt.mainnet.block-engine.jito.wtf
 *
 * Bundles are not testable against surfpool — the Block Engine is a
 * private mempool service that only runs on real mainnet leaders.
 */

import {
  AccountRole,
  address,
  type Address,
  type IInstruction,
} from "@solana/kit";

const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");

export const JITO_BLOCK_ENGINE_DEFAULT = "https://mainnet.block-engine.jito.wtf";

/** Eight known Jito tip accounts. Pick one at random per bundle. */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pivKeVBBjNS6jiBeaqMx",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

export function pickRandomJitoTipAccount(): Address {
  const i = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return address(JITO_TIP_ACCOUNTS[i]!);
}

/**
 * Build a SystemProgram.transfer kit instruction tipping the given
 * lamports to a Jito tip account. Append this to the LAST tx of your
 * bundle (or to any tx; it just has to be present in at least one).
 *
 * Tip floor changes; current Jito guidance is "at least 1000 lamports"
 * but realistic landing rates require 0.001+ SOL on busy markets.
 */
export function buildJitoTipIx(
  payer: Address,
  lamports: number | bigint,
  tipAccount?: Address,
): IInstruction {
  // SystemProgram.transfer encoding: 4-byte little-endian discriminator
  // (2 = transfer) followed by an 8-byte little-endian u64 of lamports.
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // transfer ix discriminator
  dv.setBigUint64(4, BigInt(lamports), true);
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: tipAccount ?? pickRandomJitoTipAccount(), role: AccountRole.WRITABLE },
    ],
    data,
  };
}

export interface SendJitoBundleOptions {
  endpoint?: string;
  /** Each entry is a base64-encoded signed v0/legacy transaction. */
  base64SignedTxs: string[];
}

/** POST a bundle to the Jito Block Engine. Returns the bundle UUID. */
export async function sendJitoBundle(opts: SendJitoBundleOptions): Promise<string> {
  if (opts.base64SignedTxs.length < 1 || opts.base64SignedTxs.length > 5) {
    throw new Error(
      `Jito bundle must contain 1-5 transactions, got ${opts.base64SignedTxs.length}`,
    );
  }
  const endpoint = opts.endpoint ?? JITO_BLOCK_ENGINE_DEFAULT;
  const url = `${endpoint.replace(/\/$/, "")}/api/v1/bundles`;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [opts.base64SignedTxs, { encoding: "base64" }],
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`Jito sendBundle HTTP ${r.status}: ${await r.text()}`);
  }
  const j = (await r.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(`Jito sendBundle: ${j.error.message}`);
  if (!j.result) throw new Error(`Jito sendBundle returned no bundle id`);
  return j.result;
}

export interface JitoBundleStatus {
  bundleId: string;
  status: "Pending" | "Landed" | "Failed" | "Invalid" | "unknown";
  slot?: number;
  err?: unknown;
  rawTransactions?: string[];
}

/** Poll Jito's getBundleStatuses until terminal or timeout. */
export async function waitForJitoBundle(
  bundleId: string,
  opts?: { endpoint?: string; timeoutSecs?: number; pollMs?: number },
): Promise<JitoBundleStatus> {
  const endpoint = (opts?.endpoint ?? JITO_BLOCK_ENGINE_DEFAULT).replace(/\/$/, "");
  const url = `${endpoint}/api/v1/bundles`;
  const timeoutMs = (opts?.timeoutSecs ?? 60) * 1000;
  const pollMs = opts?.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
    });
    if (r.ok) {
      const j = (await r.json()) as {
        result?: { value?: Array<{ bundle_id: string; slot: number; confirmation_status: string; err: unknown; transactions: string[] } | null> };
      };
      const v = j.result?.value?.[0];
      if (v) {
        const cs = (v.confirmation_status ?? "").toLowerCase();
        const status: JitoBundleStatus["status"] =
          cs === "finalized" || cs === "confirmed" ? "Landed"
          : cs === "failed" ? "Failed"
          : cs === "invalid" ? "Invalid"
          : "Pending";
        if (status !== "Pending") {
          return { bundleId, status, slot: v.slot, err: v.err, rawTransactions: v.transactions };
        }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { bundleId, status: "unknown" };
}
