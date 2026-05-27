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

import {
  detectPocketsForExpiry,
  detectPocketsAcrossExpirations,
  DEFAULT_POCKET_OPTIONS,
  DEFAULT_DEAD_ZONE_OPTIONS,
  DEFAULT_SURFACE_FLOOR_PERCENTILE,
} from '../src/lib/math/pockets';

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

// (4) SIGN-FLIP ARTIFACT TEST: plant a microscopic negative at $753.
// This is the failure mode twin flagged: |z| is huge (-8ish) but
// |gex_K|/nAbsMed is rounding-error (~0.008 << minMagnitudeRatio=0.20).
// The minMagnitudeRatio gate must reject the sign-flip classification.
// (It may still be classified as a void — that's acceptable because a
//  near-zero strike in a busy band IS literally a thin spot. The wall-
//  exclusion mechanism is the right tool for filtering wall-adjacent
//  thin spots; minMagnitudeRatio's job is just to prevent these from
//  registering as sign-flips with cosmetically huge z-scores.)
gex.set(753, -50_000);

const pockets = detectPocketsForExpiry(gex, spot, '2026-07-17', 14);

console.log('Pocket detector synthetic fixture (v2 defaults)');
console.log('Defaults:', DEFAULT_POCKET_OPTIONS);
console.log();
console.log('Fixture: SPY-like surface, spot=$750, strikes $735–$770');
console.log('  Planted void at $760 (50K vs neighbors ~6M-9M)              — expect VOID');
console.log('  Planted sign-flip at $748 (-4.5M in positive band)          — expect SIGN_FLIP');
console.log('  Planted sf-artifact at $753 (-50K, |z| huge, |gex|/n trivial)— expect NOT SIGN_FLIP');
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

const expectVoid = pockets.find((p) => p.strike === 760 && p.type === 'void');
const expectFlip = pockets.find((p) => p.strike === 748 && p.type === 'sign_flip');
const artifactNotFlip = !pockets.find((p) => p.strike === 753 && p.type === 'sign_flip');
const stray = pockets.filter(
  (p) => p.strike !== 760 && p.strike !== 748 && p.strike !== 753,
);

console.log();
console.log('Acceptance (v2):');
console.log('  void@$760 fires as void:                ', expectVoid ? 'OK' : 'FAIL');
console.log('  sign_flip@$748 fires as sign_flip:      ', expectFlip ? 'OK' : 'FAIL');
console.log('  sf-artifact@$753 NOT classed sign_flip: ', artifactNotFlip ? 'OK' : 'FAIL');
console.log('  stray pockets (excl. planted):           ', stray.length, stray.length > 0 ? '(FAIL)' : '(OK)');

// Wall-exclusion test via wrapper. Pretend $755 is the labeled call wall.
// Even if a detector run thinks there's a pocket there, the wrapper drops
// it because it's within WALL_EXCLUSION_BUFFER of an excluded strike.
const acrossOne = detectPocketsAcrossExpirations(
  [{ expiration: '2026-07-17', dte: 14, exposures: [...gex.entries()].map(([strike, netGEX]) => ({ strike, netGEX })) }],
  spot,
  { excludeStrikes: [755] },
);
const wallExcluded = !acrossOne.find((p) => Math.abs(p.strike - 755) <= 0.5);
console.log('  wall@$755 ±$0.50 excluded:', wallExcluded ? 'OK' : 'FAIL');
if (!wallExcluded) {
  console.log('  DEBUG acrossOne:', acrossOne.map((p) => `${p.type}@$${p.strike}`));
}

// Note: the surface-floor mechanism is data-shape-dependent and best
// validated against real SPY chains. In synthetic fixtures with
// pathological wing/main ratios, P25 can land inside the wing and
// fail to suppress; real chains have main-band strikes dominating
// the bottom quartile of |GEX|, so P25 sits well above any wing
// strike. Empirical validation happens at live-deploy time, not here.

console.log();
console.log('Surface floor percentile default:', DEFAULT_SURFACE_FLOOR_PERCENTILE);

// ════════════════════════════════════════════════════════════════════
// Dead-zone tests (commit 6 of PR2)
// ════════════════════════════════════════════════════════════════════

console.log();
console.log('Dead-zone defaults:', DEFAULT_DEAD_ZONE_OPTIONS);

// Test 1: canonical dead zone above the wall.
// Build a single-expiry surface with:
//   - Call wall at $755, peak |GEX| = 1e7
//   - In-corridor strikes $745-755 with moderate GEX (0.3 * peak)
//   - Above-wall strikes $760-770 at uniform 3e5 (3% of peak,
//     below the 5% absoluteFloorRatio)
// Expected: every above-wall strike $760-770 flagged as dead_zone.
{
  const peakGex = 1e7;
  const exposures: Array<{ strike: number; netGEX: number }> = [];
  for (let k = 745; k <= 754; k++) exposures.push({ strike: k, netGEX: peakGex * 0.3 });
  exposures.push({ strike: 755, netGEX: peakGex });
  for (let k = 760; k <= 770; k += 2.5) exposures.push({ strike: k, netGEX: 3e5 });

  const out = detectPocketsAcrossExpirations(
    [{ expiration: '2026-07-17', dte: 14, exposures }],
    750,
    { callWall: 755, putWall: 745 },
  );
  const dzAboveWall = out.filter((p) => p.type === 'dead_zone' && p.strike > 755.5);
  const expectedStrikes = [760, 762.5, 765, 767.5, 770];
  const allFlagged = expectedStrikes.every((s) => dzAboveWall.some((p) => Math.abs(p.strike - s) < 1e-6));
  console.log();
  console.log('Test 1 — canonical dead zone above wall:');
  console.log(`  expected ${expectedStrikes.length} dead_zones at $760-770, got ${dzAboveWall.length}:`, allFlagged ? 'OK' : 'FAIL');
  if (!allFlagged) {
    console.log('  detected dead_zones above wall:', dzAboveWall.map((p) => `$${p.strike} deadness=${p.deadness?.toFixed(4)}`));
  }
}

// Test 2: quiet-expiry rejection.
// Two expiries: a busy one (peak 1e7) and a quiet one (peak 5% of busy peak).
// Even though every strike in the quiet expiry is "thin" by its own
// expiryPeak, the expiry-relevance gate (default 10% of global peak)
// rejects all of them.
{
  const busyExposures: Array<{ strike: number; netGEX: number }> = [];
  for (let k = 745; k <= 770; k++) busyExposures.push({ strike: k, netGEX: 1e7 * (k === 755 ? 1 : 0.3) });
  const quietExposures: Array<{ strike: number; netGEX: number }> = [];
  // Quiet expiry: peak 5% of busy peak (5e5). All other strikes way below.
  for (let k = 745; k <= 770; k++) quietExposures.push({ strike: k, netGEX: k === 755 ? 5e5 : 1e3 });

  const out = detectPocketsAcrossExpirations(
    [
      { expiration: '2026-07-17', dte: 14, exposures: busyExposures },
      { expiration: '2026-08-21', dte: 49, exposures: quietExposures },
    ],
    750,
    { callWall: 755, putWall: 745 },
  );
  const dzQuiet = out.filter((p) => p.type === 'dead_zone' && p.expiry === '2026-08-21');
  console.log();
  console.log('Test 2 — quiet-expiry rejection:');
  console.log(`  quiet-expiry dead_zones (expect 0): ${dzQuiet.length}`, dzQuiet.length === 0 ? 'OK' : 'FAIL');
}

// Test 3: in-corridor strike rejection.
// A strike between the walls with absolutely tiny |GEX| should be a
// void (existing detector catches relative thinness) but NOT a
// dead_zone (scope restriction excludes in-corridor strikes).
{
  const exposures: Array<{ strike: number; netGEX: number }> = [];
  for (let k = 745; k <= 770; k++) {
    if (k === 750) {
      exposures.push({ strike: k, netGEX: 1e4 }); // thin in-corridor strike
    } else {
      exposures.push({ strike: k, netGEX: 1e7 * (k === 755 ? 1 : 0.5) });
    }
  }
  const out = detectPocketsAcrossExpirations(
    [{ expiration: '2026-07-17', dte: 14, exposures }],
    750,
    { callWall: 755, putWall: 745 },
  );
  const k750 = out.filter((p) => Math.abs(p.strike - 750) < 1e-6);
  const isVoid = k750.some((p) => p.type === 'void');
  const isDeadZone = k750.some((p) => p.type === 'dead_zone');
  console.log();
  console.log('Test 3 — in-corridor strike rejection:');
  console.log(`  $750 fires as void (in-corridor thin):`, isVoid ? 'OK' : 'FAIL');
  console.log(`  $750 NOT classified as dead_zone:`, !isDeadZone ? 'OK' : 'FAIL');
}
