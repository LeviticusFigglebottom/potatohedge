/**
 * Pocket detection for dealer-positioning surfaces.
 *
 * A "pocket" is a strike where the local GEX structure breaks against
 * its neighbors in one of two ways:
 *
 *   void       — magnitude collapses relative to surrounding strikes.
 *                Indicates a strike with no meaningful dealer positioning
 *                in an otherwise busy band. These are the "air pockets"
 *                price tends to move through quickly because there's no
 *                gamma defense at that level.
 *
 *   sign_flip  — the strike's GEX sign is opposite to its neighbors and
 *                the magnitude is statistically significant (|z| > flipZ).
 *                Indicates a strike where dealer positioning reverses
 *                inside an otherwise consistent band — usually because of
 *                a single fat-finger OI cluster (real or stale).
 *
 * Pure functions only. No React, no API calls, no dependencies beyond
 * the basic shapes. Designed to be called per-expiry (single-column scan)
 * or via the convenience wrapper across all expirations.
 *
 * Pocket semantics are gamma-specific. Running the same scan on DEX,
 * Vanna, or Charm produces misleading results (a negative DEX at a strike
 * isn't a "pocket", it's expected positioning). Keep the input shape as
 * `Map<strike, gexValue>` rather than a generic exposure object so callers
 * can't accidentally point the scan at the wrong tensor.
 */

export type PocketType = 'void' | 'sign_flip' | 'dead_zone';

export interface Pocket {
  /** YYYY-MM-DD expiration date the pocket belongs to. Empty when the
   *  detector is called at the single-column level; populated by the
   *  across-expirations wrapper. */
  expiry: string;
  /** Days-to-expiration corresponding to `expiry`. */
  dte: number;
  /** The strike price where the pocket was detected. */
  strike: number;
  /** Pocket category — drives the visual marker on the overlay layer
   *  (void = open circle, sign_flip = filled diamond) and the metrics
   *  card classification ("Nearest void" vs "Deepest sign-flip"). */
  type: PocketType;
  /** Z-score of this strike's GEX vs the neighbor window. Populated for
   *  sign_flip pockets; undefined for voids (voids use `thinness`). The
   *  larger |z|, the more anomalous vs neighbors. */
  z?: number;
  /** Void-pocket depth: |gex_here| / median(|gex_neighbor|). Populated for
   *  void pockets only. Lower = thinner; 0 = perfectly empty in a busy
   *  band. Compare against `voidRatio` from the detector options to
   *  understand whether the void is borderline or extreme. */
  thinness?: number;
  /** Dead-zone deadness: |gex_here| / perExpiryPeakAbsGex, in [0, 1].
   *  Populated for dead_zone pockets only. Closer to 0 = deader. Use
   *  this when distinguishing "modestly thin beyond the walls" from
   *  "structurally empty terrain." Sits alongside thinness (void) and
   *  z (sign_flip) — same Pocket shape, type discriminator selects
   *  which secondary metric is populated. */
  deadness?: number;
  /** Maximum |GEX| within this pocket's expiration. Populated for
   *  dead_zone pockets so the click popover and tooltip can show the
   *  comparison baseline ("$760 deadness 0.04 vs $755 peak 8.2M"). */
  perExpiryPeak?: number;
  /** Signed distance from spot as a fraction. `(strike - spot) / spot`.
   *  Positive = above spot, negative = below. Used by the metrics row
   *  for the "nearest void" card. */
  distPct: number;
}

export interface PocketDetectorOptions {
  /** Half-width of the neighbor window for the local-structure scan.
   *  Each strike compares against the `window` strikes on either side
   *  (excluding itself). At SPY's $1 strike spacing near ATM, window=5
   *  means ±$5 of context — small enough to catch genuine local
   *  anomalies, wide enough to be statistically meaningful (10 samples
   *  for mean/std/median). */
  window: number;
  /** Minimum |z-score| for a sign-flip pocket to register. Tightened
   *  from the initial 1.5 to 2.0 after the first overlay deploy
   *  produced ~50 false positives ('christmas-tree' density). 2.0 is
   *  the 98th-percentile cutoff under normal-ish neighbor
   *  distributions — pairs with the minMagnitudeRatio gate below to
   *  filter "microscopic opposite-sign value next to huge positive
   *  band" artifacts. */
  flipZ: number;
  /** Maximum |gex| / median(|gex_neighbors|) for a void pocket.
   *  Tightened from 0.25 to 0.15 — at 0.25 every slightly-below-
   *  average strike in a busy band registered as a "void". 0.15
   *  requires the strike to have less than 15% of the typical neighbor
   *  magnitude before it counts as genuine air. */
  voidRatio: number;
  /** Minimum |gex_K| / median(|gex_neighbors|) for a sign-flip pocket
   *  to be CONSIDERED. Without this gate, a strike with gex=-50 next
   *  to neighbors at +5M registers as a sign-flip with z=-10 — true
   *  z-score, but the absolute magnitude is rounding-error island, not
   *  a real structural reversal. The 0.20 default requires the
   *  opposite-sign value to be at least 20% of typical magnitude before
   *  the z-score gate is even consulted. NEW in pocket-detector v2. */
  minMagnitudeRatio: number;
  /** Absolute |gex| floor for the candidacy gate. A strike doesn't
   *  qualify as a pocket unless either its own |gex| (sign-flip case)
   *  or its neighbor median (void case) exceeds this floor. Filters
   *  out deep-OTM wing artifacts where every strike has tiny |gex| —
   *  a "void" in the wing is just the wing, not a pocket.
   *
   *  When detectPocketsForExpiry is called directly, set this to the
   *  absolute value desired (or 0 to disable). When using the
   *  detectPocketsAcrossExpirations wrapper, this is auto-computed
   *  from `surfaceFloorPercentile`. NEW in v2. */
  surfaceFloor: number;
}

/** Twin-recommended defaults, calibrated from the first PR2 deploy.
 *  Initial defaults (voidRatio=0.25, flipZ=1.5) produced ~50 pockets
 *  on the live SPY surface — christmas-tree density, not a signal
 *  layer. Tightened to the values below + the new candidacy gates
 *  (minMagnitudeRatio, surfaceFloor) for ~10-15 pockets per typical
 *  session. Tune voidRatio first if the canonical $760-770 mid-term
 *  SPY void stops triggering. */
export const DEFAULT_POCKET_OPTIONS: PocketDetectorOptions = {
  window: 5,
  flipZ: 2.0,
  voidRatio: 0.15,
  minMagnitudeRatio: 0.20,
  surfaceFloor: 0,
};

/** Default surface-floor percentile used by detectPocketsAcrossExpirations
 *  to compute the absolute floor from the full surface's |GEX|
 *  distribution. P25 means "the bottom quartile of strikes is too thin
 *  to even count as candidate-eligible" — filters out the wing region
 *  systematically. */
export const DEFAULT_SURFACE_FLOOR_PERCENTILE = 25;

/** Strikes within this dollar buffer of an excluded level (typically
 *  the labeled call wall / put wall) are skipped entirely by the
 *  multi-expiry wrapper. The wall is structure, not a pocket near it. */
export const WALL_EXCLUSION_BUFFER = 0.50;

// ── Dead-zone detector (absolute thinness, beyond the walls) ─────

export interface DeadZoneOptions {
  /** Strike-level deadness gate: a candidate must have
   *      |gex_K| < absoluteFloorRatio × expiryPeakAbsGex
   *  to register. 0.05 = "less than 5% of this expiry's heaviest
   *  strike" — structurally absent rather than locally diminished. */
  absoluteFloorRatio: number;
  /** Expiry-relevance gate: the expiry's own peak |GEX| must be
   *      expiryPeakAbsGex >= expiryRelevanceRatio × globalPeakAbsGex
   *  for any of its strikes to qualify as dead zones. Without this
   *  gate, a structurally quiet 35d column (peak 100× smaller than
   *  the 0DTE pin) would trip dead-zone on every strike — being thin
   *  inside a thin expiry is meaningless. */
  expiryRelevanceRatio: number;
}

// TUNE-ME — calibrated empirically after first dead-zone observation.
// If the live render shows >20 dead-zones, tighten absoluteFloorRatio
// to 0.03. If 0-1 dead-zones, loosen to 0.08.
export const DEFAULT_ABSOLUTE_FLOOR_RATIO = 0.05;
export const DEFAULT_EXPIRY_RELEVANCE_RATIO = 0.10;

export const DEFAULT_DEAD_ZONE_OPTIONS: DeadZoneOptions = {
  absoluteFloorRatio: DEFAULT_ABSOLUTE_FLOOR_RATIO,
  expiryRelevanceRatio: DEFAULT_EXPIRY_RELEVANCE_RATIO,
};

/**
 * Detect dead-zone pockets for a single expiration.
 *
 * Dead zones differ from voids semantically. A void is a strike that's
 * locally thin RELATIVE to its immediate neighbors (a dent in an
 * otherwise busy band). A dead zone is a strike that's ABSOLUTELY thin
 * relative to the expiry's own peak — structurally absent rather than
 * locally diminished. Trading semantic: voids are "the price might
 * slip through here within the defended terrain"; dead zones are
 * "this is unopposed terrain beyond the walls, a momentum target if
 * the wall breaks."
 *
 * Two gates (both must pass):
 *   1. Strike-level deadness: |gex_K| < absoluteFloorRatio × expiryPeak
 *   2. Expiry relevance: expiryPeak >= expiryRelevanceRatio × globalPeak
 *
 * Two scope restrictions (dead-zone-specific; void/sign_flip ignore
 * these):
 *   1. Outside the wall corridor: strike > callWall + WALL_EXCLUSION_BUFFER
 *      OR strike < putWall - WALL_EXCLUSION_BUFFER. Between-wall dead
 *      zones are conceptually redundant with relative voids and add
 *      marker noise. The dead-zone semantic is specifically "beyond
 *      the defended terrain."
 *   2. (Caller's responsibility) within actionable distance from spot
 *      — typically applied at the overlay-render layer, not here.
 *
 * If both walls are null, the corridor restriction is skipped — the
 * detector can't filter for "beyond walls" if no walls are identified.
 */
export function detectDeadZones(
  gexByStrike: Map<number, number>,
  spot: number,
  expiry: string,
  dte: number,
  expiryPeakAbsGex: number,
  globalPeakAbsGex: number,
  callWall: number | null,
  putWall: number | null,
  opts: Partial<DeadZoneOptions> = {},
): Pocket[] {
  // Use nullish-coalescing rather than spread defaults, because the
  // wrapper may pass {absoluteFloorRatio: undefined, ...} and the
  // spread would CLOBBER the default with the explicit undefined.
  const absoluteFloorRatio = opts.absoluteFloorRatio ?? DEFAULT_DEAD_ZONE_OPTIONS.absoluteFloorRatio;
  const expiryRelevanceRatio = opts.expiryRelevanceRatio ?? DEFAULT_DEAD_ZONE_OPTIONS.expiryRelevanceRatio;

  // Gate 2: expiry relevance. If the whole column is thin relative
  // to the surface peak, none of its strikes are meaningful dead
  // zones (they're just a quiet expiry).
  if (expiryPeakAbsGex <= 0) return [];
  if (globalPeakAbsGex > 0 && expiryPeakAbsGex < expiryRelevanceRatio * globalPeakAbsGex) return [];

  const absoluteFloor = absoluteFloorRatio * expiryPeakAbsGex;
  const hasCorridor = callWall != null || putWall != null;
  const corridorLo = putWall != null ? putWall - WALL_EXCLUSION_BUFFER : -Infinity;
  const corridorHi = callWall != null ? callWall + WALL_EXCLUSION_BUFFER : Infinity;

  const out: Pocket[] = [];
  for (const [K, gexK] of gexByStrike.entries()) {
    // Scope restriction: skip strikes between the walls (defended
    // terrain — voids cover that semantic, not dead zones).
    if (hasCorridor && K >= corridorLo && K <= corridorHi) continue;

    // Gate 1: strike-level deadness.
    const absK = Math.abs(gexK);
    if (absK >= absoluteFloor) continue;

    const distPct = spot > 0 ? (K - spot) / spot : 0;
    out.push({
      expiry,
      dte,
      strike: K,
      type: 'dead_zone',
      deadness: absK / expiryPeakAbsGex,
      perExpiryPeak: expiryPeakAbsGex,
      distPct,
    });
  }
  return out;
}

// ── Internal stats helpers (no external dep on lodash/d3) ──────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population standard deviation (ddof=0). Matches numpy.std default
 *  so cross-validation against Python reference implementations works
 *  without correction. */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - mu) * (x - mu);
  return Math.sqrt(acc / xs.length);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Sign function that returns 0 for 0 (Math.sign does this too, but
 *  bundlers occasionally polyfill it incorrectly; keeping the explicit
 *  three-way avoids ambiguity at the strike-with-zero-gex case where
 *  treating zero as positive or negative would trigger spurious flips). */
function sgn(x: number): -1 | 0 | 1 {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

// ── Single-expiry detector ─────────────────────────────────────────

/**
 * Scan one expiration column for void and sign-flip pockets.
 *
 * @param gexByStrike  Map of strike → netGEX for one expiration. Only
 *                     strikes actually present in the chain should be in
 *                     the map; the void detector compares against
 *                     neighbors so a "missing" strike (not in the map at
 *                     all) is correctly treated as absent rather than as
 *                     a zero-value pocket.
 * @param spot         Underlying spot price, for distPct.
 * @param expiry       YYYY-MM-DD attached to each Pocket emitted.
 * @param dte          Days to expiry attached to each Pocket emitted.
 * @param opts         Optional overrides; defaults from DEFAULT_POCKET_OPTIONS.
 */
export function detectPocketsForExpiry(
  gexByStrike: Map<number, number>,
  spot: number,
  expiry: string,
  dte: number,
  opts: Partial<PocketDetectorOptions> = {},
): Pocket[] {
  const { window, flipZ, voidRatio, minMagnitudeRatio, surfaceFloor } = {
    ...DEFAULT_POCKET_OPTIONS,
    ...opts,
  };

  const strikes = [...gexByStrike.keys()].sort((a, b) => a - b);
  if (strikes.length < 3) return []; // not enough context to scan

  const out: Pocket[] = [];

  for (let i = 0; i < strikes.length; i++) {
    const K = strikes[i];
    const gexK = gexByStrike.get(K) ?? 0;

    // Neighbor window: ±window strikes excluding K itself. Clamped at
    // both ends — we don't pad with zeros, we just use whatever's
    // available. At the edges the window is asymmetric, which is the
    // correct behavior (no synthetic neighbors).
    const lo = Math.max(0, i - window);
    const hi = Math.min(strikes.length, i + window + 1);
    const neighborValues: number[] = [];
    for (let j = lo; j < hi; j++) {
      if (j === i) continue;
      const nVal = gexByStrike.get(strikes[j]);
      if (nVal !== undefined) neighborValues.push(nVal);
    }
    if (neighborValues.length < 2) continue; // can't compute std/median meaningfully

    const nMean = mean(neighborValues);
    const nStd = stdev(neighborValues) || 1e-9;
    const nAbsMed = median(neighborValues.map(Math.abs));
    const absK = Math.abs(gexK);
    const z = (gexK - nMean) / nStd;
    const distPct = spot > 0 ? (K - spot) / spot : 0;

    // ── Sign-flip candidacy (precedence over void) ────────────────
    // All four conditions must hold for a sign-flip to register:
    //   1. K and neighbors are both signed (not zero on either side)
    //   2. signs disagree
    //   3. |z| > flipZ (statistical significance)
    //   4. |gex_K| >= minMagnitudeRatio × nAbsMed (relative magnitude)
    //   5. |gex_K| >= surfaceFloor (absolute magnitude — filters wings)
    // Gate (4) prevents the "microscopic negative inside huge positive
    // band" artifact that produced spurious |z|~8 flips at the call
    // wall strike on the first overlay deploy. Gate (5) keeps the deep
    // OTM wing region from registering rounding-error sign reversals.
    if (
      sgn(gexK) !== 0 &&
      sgn(nMean) !== 0 &&
      sgn(gexK) !== sgn(nMean) &&
      Math.abs(z) > flipZ &&
      absK >= minMagnitudeRatio * nAbsMed &&
      absK >= surfaceFloor
    ) {
      out.push({ expiry, dte, strike: K, type: 'sign_flip', z, distPct });
      continue;
    }

    // ── Void candidacy ────────────────────────────────────────────
    // All three conditions must hold:
    //   1. nAbsMed > 0 (some neighbors have non-zero gex)
    //   2. |gex_K| < voidRatio × nAbsMed (locally thin vs neighbors)
    //   3. nAbsMed >= surfaceFloor (neighbor band is meaningfully
    //      sized — filters wings where everything is naturally tiny)
    if (
      nAbsMed > 0 &&
      absK < voidRatio * nAbsMed &&
      nAbsMed >= surfaceFloor
    ) {
      out.push({
        expiry, dte, strike: K, type: 'void',
        thinness: absK / nAbsMed,
        distPct,
      });
    }
  }

  return out;
}

// ── Multi-expiry convenience wrapper ───────────────────────────────

/** Minimal exposure shape consumed by the multi-expiry detector.
 *  Matches the multi-gex API response shape but only requires the two
 *  fields we need; callers can pass StrikeExposure[] directly. */
export interface ExpiryExposureSlice {
  expiration: string;
  dte: number;
  exposures: Array<{ strike: number; netGEX: number }>;
}

export interface AcrossExpirationsOptions extends Partial<PocketDetectorOptions>, Partial<DeadZoneOptions> {
  /** Percentile of the across-surface |GEX| distribution that becomes
   *  the absolute candidacy floor for every per-expiry scan. Defaults
   *  to DEFAULT_SURFACE_FLOOR_PERCENTILE (25). Ignored if `surfaceFloor`
   *  is also passed explicitly — then the explicit value wins. */
  surfaceFloorPercentile?: number;
  /** Labeled call wall. Used by the dead-zone detector for the
   *  beyond-corridor scope restriction, AND implicitly added to
   *  excludeStrikes for the void/sign_flip post-filter. */
  callWall?: number | null;
  /** Labeled put wall. Same dual role as callWall. */
  putWall?: number | null;
  /** Additional strikes to exclude from the final void/sign_flip
   *  pocket list (does NOT affect dead_zone scope — dead zones use
   *  the explicit callWall/putWall for corridor). Any pocket within
   *  WALL_EXCLUSION_BUFFER ($0.50) of an entry here is dropped. The
   *  callWall + putWall values above are auto-merged in. */
  excludeStrikes?: number[];
}

/**
 * Run the single-expiry detector across every expiration in a multi-gex
 * response. Each pocket inherits its `expiry` and `dte` from the column
 * that produced it.
 *
 * Two additional gates beyond the per-expiry detector:
 *
 *   - **Surface floor**. The full across-expirations |GEX| distribution
 *     is collected and the P25 (default) value becomes the absolute
 *     candidacy floor. This filters wing strikes where every value is
 *     tiny, so "void" doesn't register on a naturally thin band.
 *   - **Wall exclusion**. Strikes within ±$0.50 of the labeled call/put
 *     wall are dropped — those strikes ARE the wall structure, not
 *     pockets near it. A future refactor could push this filter into
 *     the per-expiry detector, but keeping it at the wrapper avoids
 *     plumbing global-aggregate knowledge into the per-column scan.
 *
 * Output is flat (one array of all pockets across all expirations) so
 * the persistence detector — which groups pockets by (strike, type)
 * across expirations — can consume it directly. The visual overlay
 * layer also wants a flat list keyed by (expiry, strike, type) for
 * per-tick rendering.
 */
export function detectPocketsAcrossExpirations(
  perExpiration: ExpiryExposureSlice[],
  spot: number,
  opts: AcrossExpirationsOptions = {},
): Pocket[] {
  // ── Surface-floor for void/sign_flip candidacy ──────────────────
  let surfaceFloor = opts.surfaceFloor ?? 0;
  if (opts.surfaceFloor === undefined) {
    const allAbs: number[] = [];
    for (const exp of perExpiration) {
      for (const e of exp.exposures) {
        const v = Math.abs(e.netGEX);
        if (v > 0) allAbs.push(v);
      }
    }
    if (allAbs.length > 0) {
      allAbs.sort((a, b) => a - b);
      const p = opts.surfaceFloorPercentile ?? DEFAULT_SURFACE_FLOOR_PERCENTILE;
      const idx = Math.floor((p / 100) * (allAbs.length - 1));
      surfaceFloor = allAbs[idx];
    }
  }

  // ── Global peak |GEX| for dead-zone expiry-relevance gate ───────
  let globalPeakAbsGex = 0;
  for (const exp of perExpiration) {
    for (const e of exp.exposures) {
      const a = Math.abs(e.netGEX);
      if (a > globalPeakAbsGex) globalPeakAbsGex = a;
    }
  }

  const perExpiryOpts: Partial<PocketDetectorOptions> = { ...opts, surfaceFloor };
  delete (perExpiryOpts as AcrossExpirationsOptions).surfaceFloorPercentile;
  delete (perExpiryOpts as AcrossExpirationsOptions).excludeStrikes;
  delete (perExpiryOpts as AcrossExpirationsOptions).callWall;
  delete (perExpiryOpts as AcrossExpirationsOptions).putWall;
  delete (perExpiryOpts as AcrossExpirationsOptions).absoluteFloorRatio;
  delete (perExpiryOpts as AcrossExpirationsOptions).expiryRelevanceRatio;

  const callWall = opts.callWall ?? null;
  const putWall = opts.putWall ?? null;
  const dzOpts: Partial<DeadZoneOptions> = {
    absoluteFloorRatio: opts.absoluteFloorRatio,
    expiryRelevanceRatio: opts.expiryRelevanceRatio,
  };

  const voidsAndFlips: Pocket[] = [];
  const deadZones: Pocket[] = [];
  for (const exp of perExpiration) {
    const gexByStrike = new Map<number, number>();
    let expiryPeakAbsGex = 0;
    for (const e of exp.exposures) {
      gexByStrike.set(e.strike, e.netGEX);
      const a = Math.abs(e.netGEX);
      if (a > expiryPeakAbsGex) expiryPeakAbsGex = a;
    }
    voidsAndFlips.push(
      ...detectPocketsForExpiry(gexByStrike, spot, exp.expiration, exp.dte, perExpiryOpts),
    );
    deadZones.push(
      ...detectDeadZones(gexByStrike, spot, exp.expiration, exp.dte, expiryPeakAbsGex, globalPeakAbsGex, callWall, putWall, dzOpts),
    );
  }

  // ── Wall-exclusion post-filter for voids/sign_flips ─────────────
  // Auto-includes callWall + putWall alongside any caller-supplied
  // excludeStrikes. Dead zones are NOT subject to this filter — their
  // own scope restriction (corridor) is the right tool for them, and
  // post-filtering would zero out the very strikes we want to flag.
  const wallStrikes = [callWall, putWall].filter((s): s is number => typeof s === 'number');
  const excl = [...(opts.excludeStrikes ?? []), ...wallStrikes];
  const filteredVoidsAndFlips = excl.length > 0
    ? voidsAndFlips.filter((p) => !excl.some((w) => Math.abs(p.strike - w) <= WALL_EXCLUSION_BUFFER))
    : voidsAndFlips;

  return [...filteredVoidsAndFlips, ...deadZones];
}
