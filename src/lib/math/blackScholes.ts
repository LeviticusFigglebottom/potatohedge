/**
 * Black-Scholes Options Math Engine
 * 
 * All dealer positioning calculations assume the standard convention:
 * - Dealers are NET LONG calls (customers buy calls, dealers sell/delta hedge)
 * - Dealers are NET SHORT puts (customers buy puts for protection)
 * - Call gamma → positive GEX (dealers long gamma)
 * - Put gamma → negative GEX (dealers short gamma)
 */

// ─── Standard Normal Distribution ──────────────────────────────────

/** Cumulative standard normal distribution (Abramowitz & Stegun approximation) */
export function normCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

/** Standard normal PDF */
export function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ─── Black-Scholes Core ────────────────────────────────────────────

interface BSInput {
  S: number;   // Spot price
  K: number;   // Strike price
  T: number;   // Time to expiration (years)
  r: number;   // Risk-free rate
  sigma: number; // Implied volatility
}

function d1({ S, K, T, r, sigma }: BSInput): number {
  if (T <= 0 || sigma <= 0) return 0;
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

function d2(params: BSInput): number {
  return d1(params) - params.sigma * Math.sqrt(params.T);
}

/** Black-Scholes call price */
export function bsCallPrice(params: BSInput): number {
  const { S, K, T, r } = params;
  if (T <= 0) return Math.max(0, S - K);
  const D1 = d1(params);
  const D2 = d2(params);
  return S * normCDF(D1) - K * Math.exp(-r * T) * normCDF(D2);
}

/** Black-Scholes put price */
export function bsPutPrice(params: BSInput): number {
  const { S, K, T, r } = params;
  if (T <= 0) return Math.max(0, K - S);
  const D1 = d1(params);
  const D2 = d2(params);
  return K * Math.exp(-r * T) * normCDF(-D2) - S * normCDF(-D1);
}

// ─── Greeks ────────────────────────────────────────────────────────

export function delta(params: BSInput, type: 'call' | 'put'): number {
  if (params.T <= 0 || params.sigma <= 0) {
    if (type === 'call') return params.S > params.K ? 1 : 0;
    return params.S < params.K ? -1 : 0;
  }
  const D1 = d1(params);
  return type === 'call' ? normCDF(D1) : normCDF(D1) - 1;
}

export function gamma(params: BSInput): number {
  const { S, T, sigma } = params;
  if (T <= 0 || sigma <= 0) return 0;
  const D1 = d1(params);
  return normPDF(D1) / (S * sigma * Math.sqrt(T));
}

export function theta(params: BSInput, type: 'call' | 'put'): number {
  const { S, K, T, r, sigma } = params;
  if (T <= 0 || sigma <= 0) return 0;
  const D1 = d1(params);
  const D2 = d2(params);
  const sqrtT = Math.sqrt(T);

  const term1 = -(S * normPDF(D1) * sigma) / (2 * sqrtT);
  if (type === 'call') {
    return (term1 - r * K * Math.exp(-r * T) * normCDF(D2)) / 365;
  }
  return (term1 + r * K * Math.exp(-r * T) * normCDF(-D2)) / 365;
}

export function vega(params: BSInput): number {
  const { S, T } = params;
  if (T <= 0 || params.sigma <= 0) return 0;
  const D1 = d1(params);
  return (S * normPDF(D1) * Math.sqrt(T)) / 100; // per 1% IV change
}

export function rho(params: BSInput, type: 'call' | 'put'): number {
  const { K, T, r } = params;
  if (T <= 0) return 0;
  const D2 = d2(params);
  if (type === 'call') {
    return (K * T * Math.exp(-r * T) * normCDF(D2)) / 100;
  }
  return (-K * T * Math.exp(-r * T) * normCDF(-D2)) / 100;
}

// ─── Second-Order Greeks (Dealer Positioning) ──────────────────────

/** Vanna: ∂Δ/∂σ = ∂ν/∂S — sensitivity of delta to IV changes */
export function vanna(params: BSInput): number {
  const { S, T, sigma } = params;
  if (T <= 0 || sigma <= 0) return 0;
  const D1 = d1(params);
  const D2 = d2(params);
  return -normPDF(D1) * D2 / sigma;
}

/** Charm: ∂Δ/∂t — delta decay, how delta changes as time passes */
export function charm(params: BSInput, type: 'call' | 'put'): number {
  const { T, r, sigma } = params;
  if (T <= 0 || sigma <= 0) return 0;
  const D1 = d1(params);
  const D2 = d2(params);
  const sqrtT = Math.sqrt(T);

  const term = normPDF(D1) * (2 * r * T - D2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);
  if (type === 'call') {
    return -term / 365; // per day
  }
  return -term / 365;
}

/** Speed: ∂Γ/∂S — rate of change of gamma */
export function speed(params: BSInput): number {
  const { S, T, sigma } = params;
  if (T <= 0 || sigma <= 0) return 0;
  const D1 = d1(params);
  const g = gamma(params);
  return -g / S * (D1 / (sigma * Math.sqrt(T)) + 1);
}

// ─── IV Solver ─────────────────────────────────────────────────────

/** Newton-Raphson IV solver from market price */
export function impliedVolatility(
  S: number, K: number, T: number, r: number,
  marketPrice: number, type: 'call' | 'put',
  maxIter: number = 100, tol: number = 1e-6
): number {
  if (T <= 0) return 0;
  
  // Initial guess using Brenner-Subrahmanyam approximation
  let sigma = Math.sqrt(2 * Math.PI / T) * marketPrice / S;
  if (sigma <= 0 || !isFinite(sigma)) sigma = 0.3;
  sigma = Math.max(0.01, Math.min(5.0, sigma));

  for (let i = 0; i < maxIter; i++) {
    const params = { S, K, T, r, sigma };
    const price = type === 'call' ? bsCallPrice(params) : bsPutPrice(params);
    const diff = price - marketPrice;

    if (Math.abs(diff) < tol) return sigma;

    const v = vega(params) * 100; // undo the /100 in vega()
    if (Math.abs(v) < 1e-12) break;

    sigma -= diff / v;
    sigma = Math.max(0.001, Math.min(10.0, sigma));
  }

  return sigma;
}

// ─── Dealer Exposure Calculations ──────────────────────────────────

export interface StrikeExposure {
  strike: number;
  callGEX: number;
  putGEX: number;
  netGEX: number;
  callDEX: number;
  putDEX: number;
  netDEX: number;
  callVanna: number;
  putVanna: number;
  netVanna: number;
  callCharm: number;
  putCharm: number;
  netCharm: number;
}

interface ChainContract {
  strike: number;
  type: 'call' | 'put';
  openInterest: number;
  impliedVolatility: number;
  gamma?: number;
  delta?: number;
}

/**
 * Compute full dealer exposure profile across all strikes.
 * 
 * Convention:
 * - Positive GEX = dealers long gamma (suppresses vol, mean-reversion)
 * - Negative GEX = dealers short gamma (amplifies moves, trend-following)
 * 
 * GEX per strike = Gamma × OI × 100 × S² × 0.01
 * (measures dollar gamma per 1% move in underlying)
 */
export function computeDealerExposure(
  contracts: ChainContract[],
  spotPrice: number,
  riskFreeRate: number = 0.05
): StrikeExposure[] {
  const strikeMap = new Map<number, StrikeExposure>();

  for (const c of contracts) {
    if (c.openInterest <= 0 || c.impliedVolatility <= 0) continue;

    const T = Math.max(0.001, c.type === 'call' || c.type === 'put' ? 1 / 365 : 1 / 365); // will be set properly
    // We need DTE - estimate from IV if not provided
    const params: BSInput = {
      S: spotPrice,
      K: c.strike,
      T: 30 / 365, // default; caller should provide DTE
      r: riskFreeRate,
      sigma: c.impliedVolatility,
    };

    const g = c.gamma ?? gamma(params);
    const d = c.delta ?? delta(params, c.type);
    const v = vanna(params);
    const ch = charm(params, c.type);

    // GEX: dollar gamma per 1% move
    const gex = g * c.openInterest * 100 * spotPrice * spotPrice * 0.01;
    // DEX: dollar delta (notional)
    const dex = d * c.openInterest * 100 * spotPrice;
    // Vanna exposure
    const vannaExp = v * c.openInterest * 100;
    // Charm exposure
    const charmExp = ch * c.openInterest * 100;

    if (!strikeMap.has(c.strike)) {
      strikeMap.set(c.strike, {
        strike: c.strike,
        callGEX: 0, putGEX: 0, netGEX: 0,
        callDEX: 0, putDEX: 0, netDEX: 0,
        callVanna: 0, putVanna: 0, netVanna: 0,
        callCharm: 0, putCharm: 0, netCharm: 0,
      });
    }

    const entry = strikeMap.get(c.strike)!;
    if (c.type === 'call') {
      entry.callGEX += gex;       // Dealers long call gamma → positive
      entry.callDEX += dex;
      entry.callVanna += vannaExp;
      entry.callCharm += charmExp;
    } else {
      entry.putGEX -= gex;        // Dealers short put gamma → negative
      entry.putDEX -= dex;
      entry.putVanna -= vannaExp;
      entry.putCharm -= charmExp;
    }
    entry.netGEX = entry.callGEX + entry.putGEX;
    entry.netDEX = entry.callDEX + entry.putDEX;
    entry.netVanna = entry.callVanna + entry.putVanna;
    entry.netCharm = entry.callCharm + entry.putCharm;
  }

  return Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
}

/**
 * Compute dealer exposure with proper DTE for each contract.
 */
export function computeDealerExposureFromChain(
  calls: { strike: number; openInterest: number; impliedVolatility: number; gamma: number; delta: number; dte: number }[],
  puts: { strike: number; openInterest: number; impliedVolatility: number; gamma: number; delta: number; dte: number }[],
  spotPrice: number,
  riskFreeRate: number = 0.05
): StrikeExposure[] {
  const strikeMap = new Map<number, StrikeExposure>();

  const processContracts = (
    contracts: typeof calls,
    type: 'call' | 'put'
  ) => {
    for (const c of contracts) {
      if (c.openInterest <= 0) continue;

      const T = Math.max(1 / 365, c.dte / 365);
      const params: BSInput = {
        S: spotPrice, K: c.strike, T, r: riskFreeRate,
        sigma: c.impliedVolatility > 0 ? c.impliedVolatility : 0.3,
      };

      const g = c.gamma > 0 ? c.gamma : gamma(params);
      const d = c.delta !== 0 ? c.delta : delta(params, type);
      const v = vanna(params);
      const ch = charm(params, type);

      const gex = g * c.openInterest * 100 * spotPrice * spotPrice * 0.01;
      const dex = d * c.openInterest * 100 * spotPrice;
      const vannaExp = v * c.openInterest * 100;
      const charmExp = ch * c.openInterest * 100;

      if (!strikeMap.has(c.strike)) {
        strikeMap.set(c.strike, {
          strike: c.strike,
          callGEX: 0, putGEX: 0, netGEX: 0,
          callDEX: 0, putDEX: 0, netDEX: 0,
          callVanna: 0, putVanna: 0, netVanna: 0,
          callCharm: 0, putCharm: 0, netCharm: 0,
        });
      }

      const entry = strikeMap.get(c.strike)!;
      if (type === 'call') {
        entry.callGEX += gex;
        entry.callDEX += dex;
        entry.callVanna += vannaExp;
        entry.callCharm += charmExp;
      } else {
        entry.putGEX -= gex;
        entry.putDEX -= dex;
        entry.putVanna -= vannaExp;
        entry.putCharm -= charmExp;
      }
      entry.netGEX = entry.callGEX + entry.putGEX;
      entry.netDEX = entry.callDEX + entry.putDEX;
      entry.netVanna = entry.callVanna + entry.putVanna;
      entry.netCharm = entry.callCharm + entry.putCharm;
    }
  };

  processContracts(calls, 'call');
  processContracts(puts, 'put');

  return Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
}

/**
 * Find the gamma flip point — the spot price where total GEX crosses zero.
 * Below gamma flip: dealers short gamma (amplified moves).
 * Above gamma flip: dealers long gamma (suppressed moves).
 */
export function findGammaFlip(exposures: StrikeExposure[]): number | null {
  if (exposures.length < 2) return null;

  for (let i = 1; i < exposures.length; i++) {
    const prev = exposures[i - 1];
    const curr = exposures[i];

    // Cumulative GEX from puts (below) to calls (above)
    if (prev.netGEX <= 0 && curr.netGEX > 0) {
      // Linear interpolation
      const ratio = Math.abs(prev.netGEX) / (Math.abs(prev.netGEX) + curr.netGEX);
      return prev.strike + ratio * (curr.strike - prev.strike);
    }
  }

  return null;
}

/**
 * Find Call Wall — strike with highest positive call GEX (resistance).
 */
export function findCallWall(exposures: StrikeExposure[]): number | null {
  let maxGEX = 0;
  let wall: number | null = null;
  for (const e of exposures) {
    if (e.callGEX > maxGEX) {
      maxGEX = e.callGEX;
      wall = e.strike;
    }
  }
  return wall;
}

/**
 * Find Put Wall — strike with most negative put GEX (support).
 */
export function findPutWall(exposures: StrikeExposure[]): number | null {
  let minGEX = 0;
  let wall: number | null = null;
  for (const e of exposures) {
    if (e.putGEX < minGEX) {
      minGEX = e.putGEX;
      wall = e.strike;
    }
  }
  return wall;
}

/**
 * Compute max pain — the strike price where total option holder loss is maximized.
 */
export function computeMaxPain(
  calls: { strike: number; openInterest: number }[],
  puts: { strike: number; openInterest: number }[]
): { strike: number; totalPain: number; distribution: { strike: number; callPain: number; putPain: number; totalPain: number }[] } {
  const allStrikes = new Set<number>();
  calls.forEach(c => allStrikes.add(c.strike));
  puts.forEach(p => allStrikes.add(p.strike));
  const strikes = Array.from(allStrikes).sort((a, b) => a - b);

  if (strikes.length === 0) return { strike: 0, totalPain: 0, distribution: [] };

  const distribution: { strike: number; callPain: number; putPain: number; totalPain: number }[] = [];
  let minPain = Infinity;
  let maxPainStrike = strikes[0];

  for (const testPrice of strikes) {
    let callPain = 0;
    let putPain = 0;

    for (const c of calls) {
      if (testPrice > c.strike) {
        callPain += (testPrice - c.strike) * c.openInterest * 100;
      }
    }
    for (const p of puts) {
      if (testPrice < p.strike) {
        putPain += (p.strike - testPrice) * p.openInterest * 100;
      }
    }

    const totalPain = callPain + putPain;
    distribution.push({ strike: testPrice, callPain, putPain, totalPain });

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testPrice;
    }
  }

  return { strike: maxPainStrike, totalPain: minPain, distribution };
}

/**
 * Compute Put/Call Ratios
 */
export function computePCR(
  calls: { volume: number; openInterest: number }[],
  puts: { volume: number; openInterest: number }[]
): { volumePCR: number; oiPCR: number; totalCallVol: number; totalPutVol: number; totalCallOI: number; totalPutOI: number } {
  const totalCallVol = calls.reduce((sum, c) => sum + c.volume, 0);
  const totalPutVol = puts.reduce((sum, p) => sum + p.volume, 0);
  const totalCallOI = calls.reduce((sum, c) => sum + c.openInterest, 0);
  const totalPutOI = puts.reduce((sum, p) => sum + p.openInterest, 0);

  return {
    volumePCR: totalCallVol > 0 ? totalPutVol / totalCallVol : 0,
    oiPCR: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
    totalCallVol,
    totalPutVol,
    totalCallOI,
    totalPutOI,
  };
}
