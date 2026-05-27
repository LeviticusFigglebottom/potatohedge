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

export type PocketType = 'void' | 'sign_flip';

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
  /** Minimum |z-score| for a sign-flip pocket to register. 1.5 is the
   *  conventional 87th-percentile cutoff under normal-ish neighbor
   *  distributions; tightens to fewer false positives at 2.0, loosens
   *  to more at 1.0. Empirically calibrated against the SPY surface
   *  during PR2 spec. */
  flipZ: number;
  /** Maximum |gex| / median(|gex_neighbors|) for a void pocket. 0.25 =
   *  "this strike has less than a quarter of the typical neighbor
   *  magnitude" — captures genuine air pockets without flagging every
   *  slightly-below-average strike. */
  voidRatio: number;
}

/** Twin-recommended defaults. Tune `voidRatio` first if the canonical
 *  $760-770 mid-term SPY void doesn't trigger on the first overlay
 *  render (acceptance test at PR 2 commit 5). */
export const DEFAULT_POCKET_OPTIONS: PocketDetectorOptions = {
  window: 5,
  flipZ: 1.5,
  voidRatio: 0.25,
};

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
  const { window, flipZ, voidRatio } = { ...DEFAULT_POCKET_OPTIONS, ...opts };

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
    const z = (gexK - nMean) / nStd;
    const distPct = spot > 0 ? (K - spot) / spot : 0;

    // Sign-flip takes precedence over void: a strike with opposite-sign
    // significant magnitude isn't "thin", it's actively dealer-positioned
    // the other way.
    if (sgn(gexK) !== 0 && sgn(nMean) !== 0 && sgn(gexK) !== sgn(nMean) && Math.abs(z) > flipZ) {
      out.push({ expiry, dte, strike: K, type: 'sign_flip', z, distPct });
      continue;
    }

    // Void: small absolute value vs typical neighbor magnitude. Guard
    // against all-zero neighbor windows (nAbsMed === 0) where the ratio
    // comparison would be trivially false anyway.
    if (nAbsMed > 0 && Math.abs(gexK) < voidRatio * nAbsMed) {
      out.push({
        expiry, dte, strike: K, type: 'void',
        thinness: Math.abs(gexK) / nAbsMed,
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

/**
 * Run the single-expiry detector across every expiration in a multi-gex
 * response. Each pocket inherits its `expiry` and `dte` from the column
 * that produced it.
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
  opts: Partial<PocketDetectorOptions> = {},
): Pocket[] {
  const out: Pocket[] = [];
  for (const exp of perExpiration) {
    const gexByStrike = new Map<number, number>();
    for (const e of exp.exposures) gexByStrike.set(e.strike, e.netGEX);
    out.push(...detectPocketsForExpiry(gexByStrike, spot, exp.expiration, exp.dte, opts));
  }
  return out;
}
