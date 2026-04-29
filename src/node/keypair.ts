import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function expandHome(p: string): string {
  return p.startsWith("~")
    ? resolve(homedir(), p.slice(p.startsWith("~/") ? 2 : 1))
    : p;
}

/**
 * Load a Solana keypair from disk. Accepts either:
 *   - the standard solana-cli JSON byte-array format `[12, 34, ...]`
 *   - a base58-encoded 64-byte secret key (Phantom-style export), with
 *     optional surrounding double quotes
 */
export function loadKeypair(path: string): Keypair {
  const raw = readFileSync(expandHome(path), "utf8").trim();
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { /* fall through */ }
  return Keypair.fromSecretKey(bs58.decode(raw.replace(/^"(.*)"$/, "$1")));
}
