import { PublicKey, Connection } from "@solana/web3.js";
import { generatePositionPda } from "../../src/jupiter/pdas.js";
import { MARKETS } from "../../src/jupiter/markets.js";

async function main() {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const candidates = [
    "9qB3YPTKVpoCS18nC2969ViguxDXge55gYMbVNU2M4pd",
    "DFZcDnmEYNUK1khquZzx5dQYiEyjJ3N5STqaDVLZ88ZU",
  ];
  for (const addr of candidates) {
    const trader = new PublicKey(addr);
    const pdas = MARKETS.map((m) => {
      const { position } = generatePositionPda({
        trader, market: m.base, side: m.side,
        stableSide: m.collateralSymbol === "USDT" ? "USDT" : "USDC",
      });
      return { m, position };
    });
    const infos = await conn.getMultipleAccountsInfo(pdas.map((p) => p.position));
    const open = pdas.filter((_, i) => infos[i] !== null);
    console.log(`${addr}: ${open.length}/9 PDAs exist`);
    for (let i = 0; i < pdas.length; i++) {
      if (infos[i]) {
        console.log(`   ${pdas[i].m.base}/${pdas[i].m.side}/${pdas[i].m.collateralSymbol}  PDA=${pdas[i].position.toBase58()}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
