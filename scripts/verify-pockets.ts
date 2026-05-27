/**
 * Scratch verifier for the pocket detector.
 *
 * Constructs a synthetic SPY-like GEX-by-strike fixture with three
 * deliberately-planted features:
 *
 *   (1) A clean wall pattern at $740-$750 with positive GEX growing
 *       toward $755 (the canonical "call wall" structure).
 *   (2) A void at $760 — a strike with near-zero GEX inside the busy
 *       $755-$765 band. Should fire as a `void` pocket.
 *   (3) A sign-flip at $748 — a strike with negative GEX in an
 *       otherwise consistently positive band. Should fire as a
 *       `sign_flip` pocket.
 *
 * Run:
 *   npx tsx scripts/verify-pockets.ts
 *
 * Expected output: 1 void at $760, 1 sign-flip at $748, no other
 * pockets. If any of the wall strikes ($740-$745, $755) trip the
 * detector, the void/flip thresholds are too lenient.
 */

import { detectPocketsForExpiry, DEFAULT_POCKET_OPTIONS } from '../src/lib/math/pockets';

const spot = 750;
const gex = new Map<number, number>();

// Background: smoothly rising positive GEX from $735 to $755 (call wall),
// then declining from $755 back down through $770. Positive across the
// whole band — neighbors of any void should all share the positive sign.
for (let k = 735; k <= 770; k++) {
  const dist = Math.abs(k - 755);
  gex.set(k, 800_000 * Math.max(1, 12 - dist) + (k - 735) * 50_000);
}

// (2) Plant a void at $760 — overwrite with near-zero magnitude.
gex.set(760, 50_000);

// (3) Plant a sign-flip at $748 — overwrite with strongly negative
// magnitude inside the otherwise-positive band.
gex.set(748, -4_500_000);

const pockets = detectPocketsForExpiry(gex, spot, '2026-07-17', 14);

console.log('Pocket detector synthetic fixture (window=5, flipZ=1.5, voidRatio=0.25)');
console.log('Spot:', spot);
console.log('Strikes:', gex.size, 'covering $735–$770');
console.log('Planted void at $760 (50K vs neighbors ~6M-9M)');
console.log('Planted sign-flip at $748 (-4.5M in a positive band)');
console.log();
console.log('Detected pockets:');
for (const p of pockets) {
  const tag = p.type === 'void'
    ? `thinness=${p.thinness?.toFixed(4)}`
    : `z=${p.z?.toFixed(2)}`;
  console.log(
    `  ${p.type.padEnd(10)} strike=$${p.strike}  ${tag}  ` +
    `distPct=${(p.distPct * 100).toFixed(2)}%  dte=${p.dte}`,
  );
}

// Acceptance assertions (fail-loud rather than silent pass on regressions)
const expectVoid = pockets.find((p) => p.strike === 760 && p.type === 'void');
const expectFlip = pockets.find((p) => p.strike === 748 && p.type === 'sign_flip');
const stray = pockets.filter((p) => p.strike !== 760 && p.strike !== 748);

console.log();
console.log('Acceptance:');
console.log('  void@$760 fired:    ', expectVoid ? 'OK' : 'FAIL');
console.log('  sign_flip@$748 fired:', expectFlip ? 'OK' : 'FAIL');
console.log('  stray pockets:       ', stray.length, stray.length > 0 ? '(FAIL)' : '(OK)');

// Tune-knob smoke: tighten voidRatio to 0.05 and re-run, void should drop out
const tightened = detectPocketsForExpiry(gex, spot, '2026-07-17', 14, { voidRatio: 0.005 });
const tightenedVoid = tightened.find((p) => p.strike === 760 && p.type === 'void');
console.log('  void disappears at voidRatio=0.005:', tightenedVoid ? 'FAIL' : 'OK');

console.log();
console.log('Defaults in use:', DEFAULT_POCKET_OPTIONS);
