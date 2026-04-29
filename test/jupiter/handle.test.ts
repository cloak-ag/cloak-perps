/**
 * Unit tests for handle.ts. Run with: `npx tsx test/handle.test.ts`.
 * No test framework — assertion failures throw and the script exits non-zero.
 */

import { strict as assert } from "node:assert";
import {
  decodePositionHandle,
  decodeRequestHandle,
  encodePositionHandle,
  encodeRequestHandle,
  isRequestHandle,
} from "../../src/jupiter/handle.js";

// position handle round-trip
for (const base of ["SOL", "ETH", "BTC"] as const) {
  for (const side of ["long", "short"] as const) {
    const h = encodePositionHandle(base, side);
    assert.equal(h, `jupiter/${base}/${side}`);
    assert.deepEqual(decodePositionHandle(h), { market: base, side });
    assert.equal(isRequestHandle(h), false);
  }
}

// request handle round-trip
for (const counter of [0n, 1n, 12345n, 18446744073709551615n]) {
  const h = encodeRequestHandle("SOL", "long", counter);
  assert.equal(h, `jupiter/SOL/long:${counter}`);
  const d = decodeRequestHandle(h);
  assert.equal(d.market, "SOL");
  assert.equal(d.side, "long");
  assert.equal(d.counter, counter);
  assert.equal(isRequestHandle(h), true);
}

// invalid handles throw
for (const bad of [
  "jupiter/USDC/long",
  "jupiter/SOL/sideways",
  "rise/SOL/long",
  "jupiter/SOL/long/extra",
  "",
  "jupiter/SOL/long:not-a-number",
]) {
  assert.throws(() => decodePositionHandle(bad), `should reject: ${bad}`);
}

// request decoder rejects plain position handle (and vice versa)
assert.throws(() => decodeRequestHandle("jupiter/SOL/long"));
assert.throws(() => decodePositionHandle("jupiter/SOL/long:42"));

console.log("handle.test.ts: ok");
