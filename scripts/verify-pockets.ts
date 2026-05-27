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
  bandMergeDeadZones,
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
// Dead-zone tests (commit 6a — global reference frame, band merge)
// ════════════════════════════════════════════════════════════════════

console.log();
console.log('Dead-zone defaults:', DEFAULT_DEAD_ZONE_OPTIONS);

// Test 1: canonical above-wall band → 5 strikes individually flagged,
// consolidated into ONE band marker by band-merge.
// Surface: call wall at $755 (|GEX| = 1e7 = global peak), above-wall
// strikes $760-770 in $2.5 steps all at 1.5e5 = 1.5% of global peak
// (well below the 2% absoluteFloorRatio default).
{
  const peakGex = 1e7;
  const exposures: Array<{ strike: number; netGEX: number }> = [];
  for (let k = 745; k <= 754; k++) exposures.push({ strike: k, netGEX: peakGex * 0.3 });
  exposures.push({ strike: 755, netGEX: peakGex });
  for (let k = 760; k <= 770; k += 2.5) exposures.push({ strike: k, netGEX: 1.5e5 });

  const out = detectPocketsAcrossExpirations(
    [{ expiration: '2026-07-17', dte: 14, exposures }],
    750,
    { callWall: 755, putWall: 745 },
  );
  const dz = out.filter((p) => p.type === 'dead_zone');
  const expectedStrikes = [760, 762.5, 765, 767.5, 770];
  const allFlagged = expectedStrikes.every((s) => dz.some((p) => Math.abs(p.strike - s) < 1e-6));

  // Band-merge: pass chain strikes for consecutiveness detection.
  const chainStrikes = exposures.map((e) => e.strike).sort((a, b) => a - b);
  const markers = bandMergeDeadZones(dz, chainStrikes);
  const bands = markers.filter((m) => m.kind === 'band');
  const points = markers.filter((m) => m.kind === 'point');

  console.log();
  console.log('Test 1 — canonical above-wall band:');
  console.log(`  5 strikes flagged as dead_zone: ${dz.length}`, allFlagged && dz.length === 5 ? 'OK' : 'FAIL');
  console.log(`  band-merge → 1 band, 0 points:`, bands.length === 1 && points.length === 0 ? 'OK' : `FAIL (bands=${bands.length}, points=${points.length})`);
  if (bands.length === 1 && bands[0].kind === 'band') {
    console.log(`  band span: $${bands[0].bottomStrike}–$${bands[0].topStrike} (${bands[0].strikes.length} strikes)`);
  }
}

// Test 2: isolated solo dead strike → 1 point marker, not a band.
// One thin strike at $735, surrounded by non-thin neighbors.
{
  const exposures: Array<{ strike: number; netGEX: number }> = [];
  exposures.push({ strike: 732.5, netGEX: 1e6 });
  exposures.push({ strike: 735, netGEX: 1e5 }); // thin (1% of global)
  exposures.push({ strike: 737.5, netGEX: 1e6 });
  for (let k = 745; k <= 754; k++) exposures.push({ strike: k, netGEX: 1e6 });
  exposures.push({ strike: 755, netGEX: 1e7 }); // global peak

  const out = detectPocketsAcrossExpirations(
    [{ expiration: '2026-07-17', dte: 14, exposures }],
    750,
    { callWall: 755, putWall: 745 },
  );
  const dz = out.filter((p) => p.type === 'dead_zone');
  const chainStrikes = exposures.map((e) => e.strike).sort((a, b) => a - b);
  const markers = bandMergeDeadZones(dz, chainStrikes);
  const points = markers.filter((m) => m.kind === 'point');
  const bands = markers.filter((m) => m.kind === 'band');

  console.log();
  console.log('Test 2 — isolated solo dead strike:');
  console.log(`  1 dead_zone at $735, 0 bands, 1 point:`,
    dz.length === 1 && dz[0].strike === 735 && points.length === 1 && bands.length === 0 ? 'OK' : `FAIL (dz=${dz.length}, points=${points.length}, bands=${bands.length})`);
}

// Test 3: whole quiet expiry → consolidates into one or more bands,
// not 20+ individual square markers. Detector behavior is permissive
// (every strike fires), band-merge is what keeps the marker count
// manageable.
{
  const busyExposures: Array<{ strike: number; netGEX: number }> = [];
  for (let k = 745; k <= 770; k++) busyExposures.push({ strike: k, netGEX: 1e7 * (k === 755 ? 1 : 0.5) });

  // Quiet expiry: every strike < 1% of global peak
  const quietExposures: Array<{ strike: number; netGEX: number }> = [];
  for (let k = 745; k <= 770; k++) quietExposures.push({ strike: k, netGEX: 5e4 }); // 0.5% of global

  const out = detectPocketsAcrossExpirations(
    [
      { expiration: '2026-07-17', dte: 14, exposures: busyExposures },
      { expiration: '2026-08-21', dte: 49, exposures: quietExposures },
    ],
    750,
    { callWall: 755, putWall: 745 },
  );
  const dzQuiet = out.filter((p) => p.type === 'dead_zone' && p.expiry === '2026-08-21');
  const chainStrikes = quietExposures.map((e) => e.strike).sort((a, b) => a - b);
  const markers = bandMergeDeadZones(dzQuiet, chainStrikes);
  const bands = markers.filter((m) => m.kind === 'band');
  const points = markers.filter((m) => m.kind === 'point');
  const totalMarkers = bands.length + points.length;

  console.log();
  console.log('Test 3 — whole quiet expiry → bands, not 20+ squares:');
  console.log(`  individual dead_zone strikes (expect ~20+, scope-excluded inside corridor): ${dzQuiet.length}`);
  console.log(`  band-merge → total markers: ${totalMarkers}, bands: ${bands.length}, points: ${points.length}`);
  console.log(`  total markers ≤ 6:`, totalMarkers <= 6 ? 'OK' : 'FAIL');
}

// Test 4: in-corridor strike rejection.
// Strike $750 (in-corridor) at 3% of global peak — above the 2% floor.
// Should NOT fire as dead_zone (and not as void either, since 3% is
// not "locally thin" against neighbors at 50%).
{
  const exposures: Array<{ strike: number; netGEX: number }> = [];
  for (let k = 745; k <= 770; k++) {
    if (k === 750) {
      exposures.push({ strike: k, netGEX: 3e5 }); // 3% of global peak
    } else if (k === 755) {
      exposures.push({ strike: k, netGEX: 1e7 }); // global peak
    } else {
      exposures.push({ strike: k, netGEX: 5e6 });
    }
  }
  const out = detectPocketsAcrossExpirations(
    [{ expiration: '2026-07-17', dte: 14, exposures }],
    750,
    { callWall: 755, putWall: 745 },
  );
  const k750 = out.filter((p) => Math.abs(p.strike - 750) < 1e-6);
  const isDeadZone = k750.some((p) => p.type === 'dead_zone');
  console.log();
  console.log('Test 4 — in-corridor strike (3% of global) rejection:');
  console.log(`  $750 NOT classified as dead_zone:`, !isDeadZone ? 'OK' : 'FAIL');
}
