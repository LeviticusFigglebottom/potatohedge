import { describe, expect, it } from 'vitest';
import { classifySide, tapeDetail } from './classify';
import { dailyRootSummary, enrich, expirationTable, heatmapCells, intradayFlow, recentTrades, symbolTable } from './aggregate';
import { dealerExposure, filterStrikeRange } from './greeks';
import { termStructure, skewByExpiry } from './vol';
import { computeMsiComponents, normalizedEntropy } from '../msi/components';
import { computeMsiComposite, validateMsiConfig } from '../msi/composite';
import { demoChain, demoTrades, demoBars, demoNowMs } from '../demo';
import { etToMs } from '../time';
import { DEFAULT_FLOW_SETTINGS, type OptionTrade } from '../types';
import msiDefault from '../../../../config/flow-desk/msi.json';

const T0 = etToMs('2026-11-16', 10, 0);

function trade(p: Partial<OptionTrade>): OptionTrade {
  return {
    id: Math.random().toString(36), time: T0, root: 'SPY', expiry: '2026-11-20', strike: 590, right: 'C',
    price: 2, size: 10, bid: 1.9, ask: 2.1, spot: 590, iv: 0.15, delta: 0.5, gamma: 0.02, vega: 0.3, kind: 'SINGLE', ...p,
  };
}

describe('aggressor classification', () => {
  it('ask/bid/quote rule/unknown', () => {
    expect(classifySide(2.1, 1.9, 2.1)).toBe('buy');
    expect(classifySide(2.2, 1.9, 2.1)).toBe('buy');
    expect(classifySide(1.9, 1.9, 2.1)).toBe('sell');
    expect(classifySide(1.8, 1.9, 2.1)).toBe('sell');
    expect(classifySide(2.05, 1.9, 2.1)).toBe('buy'); // above mid
    expect(classifySide(1.95, 1.9, 2.1)).toBe('sell'); // below mid
    expect(classifySide(2.0, 1.9, 2.1)).toBe('unknown'); // at mid
    expect(classifySide(2.0, null, null)).toBe('unknown');
    expect(classifySide(2.0, 2.2, 2.1)).toBe('unknown'); // crossed
  });
  it('tape detail suffixes', () => {
    expect(tapeDetail(trade({ size: 25, price: 2.1 }), 'buy')).toBe('25@2.10_A');
    expect(tapeDetail(trade({ size: 3, price: 1.9 }), 'sell')).toBe('3@1.90_B');
  });
});

describe('table conventions', () => {
  const trades = enrich([
    trade({ right: 'C', price: 2.1, size: 10 }), // call buy  +2100
    trade({ right: 'P', price: 1.9, size: 10 }), // put sell  −1900
    trade({ right: 'P', price: 2.1, size: 5, expiry: '2026-11-27' }), // put buy +1050
    trade({ right: 'C', price: 2.0, size: 7 }), // unknown: volume only
    trade({ right: 'C', price: 50, size: 100, bid: 49, ask: 50, delta: 0.99 }), // deep ITM buy, excluded
  ], DEFAULT_FLOW_SETTINGS);

  it('Top Symbols: Net = Call − Put, volumes include unknown and deep-ITM', () => {
    const [row] = symbolTable(trades, 'call_minus_put');
    expect(row.callPremium).toBeCloseTo(2100, 6);
    expect(row.putPremium).toBeCloseTo(-1900 + 1050, 6);
    expect(row.netPremium).toBeCloseTo(2100 - (-850), 6);
    expect(row.callVolume).toBe(117);
    expect(row.putVolume).toBe(15);
    expect(row.totalVolume).toBe(132);
    expect(row.sentiment).toBe('Bullish');
  });

  it('By Expiration: Net = Call + Put, C/P is a volume ratio', () => {
    const rows = expirationTable(trades, 'call_plus_put');
    const a = rows.find((r) => r.expiration === '2026-11-20')!;
    expect(a.netPremium).toBeCloseTo(2100 - 1900, 6);
    expect(a.callPutRatio).toBeCloseTo(117 / 10, 9);
    const b = rows.find((r) => r.expiration === '2026-11-27')!;
    expect(b.netPremium).toBeCloseTo(1050, 6);
    expect(b.callPutRatio).toBe(0);
  });

  it('deep-ITM exclusion can be switched off', () => {
    const all = enrich([trade({ right: 'C', price: 50, size: 100, bid: 49, ask: 50, delta: 0.99 })], { excludeDeepItm: false, deepItmDelta: 0.95 });
    expect(symbolTable(all, 'call_minus_put')[0].callPremium).toBeCloseTo(500000, 6);
  });

  it('recent window, heatmap and intraday cumulative flow', () => {
    const later = enrich([trade({ time: T0 + 40 * 60000, price: 2.1 }), trade({ time: T0 + 5 * 60000, right: 'P', price: 2.1 })], DEFAULT_FLOW_SETTINGS);
    expect(recentTrades(later, T0 + 41 * 60000, 30)).toHaveLength(1);
    const flow = intradayFlow(later, { rthOnly: true });
    expect(flow).toHaveLength(2);
    expect(flow[0].putFlow).toBeCloseTo(2100, 6);
    expect(flow[1].netFlow).toBeCloseTo(2100 - 2100, 6);
    const cells = heatmapCells(trades);
    const c = cells.find((x) => x.expiry === '2026-11-20' && x.strike === 590)!;
    expect(c.buys).toBe(2);
    expect(c.sells).toBe(1);
    expect(c.unknown).toBe(1);
    expect(c.buySellRatio).toBe(2);
  });

  it('daily root summary', () => {
    const [s] = dailyRootSummary(trades, '2026-11-16');
    // bull premium: call buy +2100, put sell +1900, put buy −1050
    expect(s.total_net_premium).toBeCloseTo(2100 + 1900 - 1050, 6);
    expect(s.total_net_delta).toBeCloseTo(10 * 100 * 0.5 - 10 * 100 * 0.5 + 5 * 100 * 0.5, 6);
  });
});

describe('demo data → greeks, vol, MSI', () => {
  const session = '2026-11-16';
  const chain = demoChain('SPY', session);
  const trades = enrich(demoTrades('SPY', session, demoNowMs(session)), DEFAULT_FLOW_SETTINGS);

  it('demo data is deterministic', () => {
    expect(demoTrades('SPY', session).slice(0, 5)).toEqual(demoTrades('SPY', session).slice(0, 5));
    expect(demoBars('QQQ', '1h', session).length).toBeGreaterThan(100);
  });

  it('OI-weighted gamma follows the repo convention (calls +, puts −)', () => {
    const calls = { ...chain, contracts: chain.contracts.filter((c) => c.right === 'C') };
    const g = dealerExposure({ chain: calls, trades1d: [], trades5d: [], mode: 'oi' });
    expect(g.every((r) => r.gamma >= 0)).toBe(true);
    const puts = { ...chain, contracts: chain.contracts.filter((c) => c.right === 'P') };
    expect(dealerExposure({ chain: puts, trades1d: [], trades5d: [], mode: 'oi' }).every((r) => r.gamma <= 0)).toBe(true);
    const flow = dealerExposure({ chain, trades1d: trades, trades5d: trades, mode: 'flow1d' });
    expect(flow.length).toBeGreaterThan(0);
    expect(filterStrikeRange(flow, chain.spot, 5).every((r) => Math.abs(r.strike / chain.spot - 1) <= 0.05)).toBe(true);
  });

  it('vol term structure and skew', () => {
    const ts = termStructure(chain);
    expect(ts.length).toBeGreaterThan(5);
    expect(ts.every((p) => p.callIv! > 0 && p.putIv! > 0)).toBe(true);
    const sk = skewByExpiry(chain)[0];
    expect(sk.points[0].right).toBe('P');
    expect(sk.points[0].iv).toBeGreaterThan(sk.points[sk.points.length - 1].iv); // put skew
  });

  it('entropy and MSI composite from JSON config', () => {
    expect(normalizedEntropy([1, 1, 1, 1])).toBeCloseTo(1, 12);
    expect(normalizedEntropy([5])).toBe(0);
    const grid = intradayFlow(trades, { rthOnly: true });
    const comps = computeMsiComponents(chain, trades, grid, 15);
    expect(comps.length).toBeGreaterThan(10);
    const v = validateMsiConfig(msiDefault);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const msi = computeMsiComposite(comps, v.config);
    expect(msi.every((p) => p.value >= 0 && p.value <= 100)).toBe(true);
    // swapping the formula is data-only
    const alt = validateMsiConfig({ normalize: 'none', components: [{ id: 'flow_skew', weight: 1 }], output: { transform: 'none', scale: 1 } });
    expect(alt.ok && computeMsiComposite(comps, alt.config)[3].value).toBeCloseTo(comps[3].values.flow_skew, 12);
    expect(validateMsiConfig({ components: [{ id: 'nope', weight: 1 }] }).ok).toBe(false);
  });
});
