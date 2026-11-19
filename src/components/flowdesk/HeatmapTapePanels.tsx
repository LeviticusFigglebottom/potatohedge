'use client';

import { useMemo, useState } from 'react';
import { heatmapCells, type EnrichedTrade, type HeatCell } from '@/lib/flowdesk/flow/aggregate';
import { tapeDetail } from '@/lib/flowdesk/flow/classify';
import { C, fmtNum, fmtUsd } from './chart/theme';
import { Panel, Seg } from './ui';
import { useDesk } from './useFlowDesk';

// ─── Panel 5: Option Heatmap (Flow) ─────────────────────────

function cellColor(c: HeatCell): string {
  if (c.buys === c.sells) return '#2a2a3d';
  const r = c.buySellRatio;
  const strength = Math.min(1, Math.abs(Math.log(Number.isFinite(r) ? Math.max(r, 1e-3) : 8)) / Math.log(4));
  const a = 0.18 + 0.72 * strength;
  return r > 1 ? `rgba(0,230,118,${a.toFixed(2)})` : `rgba(255,61,87,${a.toFixed(2)})`;
}

export function FlowHeatmapPanel({ symbol, trades, spot }: { symbol: string; trades: EnrichedTrade[]; spot: number }) {
  const [range, setRange] = useState<number>(6);
  const [hover, setHover] = useState<{ c: HeatCell; x: number; y: number } | null>(null);
  const cells = useMemo(() => heatmapCells(trades.filter((t) => t.root === symbol)), [trades, symbol]);
  const expiries = useMemo(() => [...new Set(cells.map((c) => c.expiry))].sort(), [cells]);
  const strikes = useMemo(() => [...new Set(cells.map((c) => c.strike))]
    .filter((k) => Math.abs(k / spot - 1) <= range / 100).sort((a, b) => b - a), [cells, spot, range]);
  const byKey = useMemo(() => new Map(cells.map((c) => [`${c.expiry}|${c.strike}`, c])), [cells]);

  const cw = Math.max(48, Math.min(90, 900 / Math.max(1, expiries.length)));
  const ch = 16;
  const left = 56, top = 22;
  const width = left + cw * expiries.length + 8;
  const height = top + ch * strikes.length + 8;
  // spot line position between strike rows
  let spotY: number | null = null;
  for (let i = 0; i < strikes.length - 1; i++) {
    if (spot <= strikes[i] && spot >= strikes[i + 1]) {
      const f = (strikes[i] - spot) / (strikes[i] - strikes[i + 1]);
      spotY = top + ch * (i + 0.5 + f);
    }
  }

  return (
    <Panel id="flow-heatmap" title={`Option Heatmap (Flow) — ${symbol}`}
      subtitle="Strike × expiry · colour = buy count ÷ sell count (green > 1, red < 1, intensity = log ratio) · dashed line = spot"
      actions={<Seg value={range} onChange={setRange} options={[{ value: 3, label: '±3%' }, { value: 6, label: '±6%' }, { value: 10, label: '±10%' }]} />}>
      <div className="relative overflow-x-auto" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} className="font-mono" role="img" aria-label="Option flow heatmap">
          {expiries.map((e, j) => (
            <text key={e} x={left + cw * j + cw / 2} y={14} textAnchor="middle" fontSize={10} fill={C.text}>{e.slice(5)}</text>
          ))}
          {strikes.map((k, i) => (
            <text key={k} x={left - 6} y={top + ch * i + ch / 2 + 3} textAnchor="end" fontSize={10} fill={Math.abs(k - spot) < (strikes[0] - strikes[strikes.length - 1]) / strikes.length ? C.amber : C.text}>{k}</text>
          ))}
          {strikes.map((k, i) => expiries.map((e, j) => {
            const c = byKey.get(`${e}|${k}`);
            return (
              <rect key={`${e}|${k}`} x={left + cw * j + 1} y={top + ch * i + 1} width={cw - 2} height={ch - 2} rx={2}
                fill={c ? cellColor(c) : '#16161f'}
                onMouseMove={(ev) => c && setHover({ c, x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY })} />
            );
          }))}
          {spotY != null && <>
            <line x1={left} x2={width - 8} y1={spotY} y2={spotY} stroke={C.amber} strokeDasharray="4 3" strokeWidth={1.5} />
            <text x={width - 10} y={spotY - 3} textAnchor="end" fontSize={10} fill={C.amber}>spot {spot.toFixed(2)}</text>
          </>}
        </svg>
        {hover && <HeatTooltip c={hover.c} x={hover.x} y={hover.y} />}
      </div>
      <div className="flex gap-4 mt-2 text-[11px] font-mono text-text-secondary">
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(0,230,118,0.8)' }} /> buys &gt; sells</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(255,61,87,0.8)' }} /> sells &gt; buys</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-border" /> balanced</span>
      </div>
    </Panel>
  );
}

function HeatTooltip({ c, x, y }: { c: HeatCell; x: number; y: number }) {
  const total = c.buys + c.sells + c.unknown;
  const bull = c.bullPremium >= 0;
  return (
    <div className="absolute z-10 pointer-events-none bg-bg-primary/95 border border-border rounded-md px-3 py-2 text-[11px] font-mono shadow-lg min-w-[220px]"
      style={{ left: x + 14, top: y + 14 }} data-testid="heatmap-tooltip">
      <div className="text-text-primary font-semibold mb-1">{c.strike} · {c.expiry}</div>
      <div>Premium Flow {bull ? 'Bullish' : 'Bearish'}: <span className={bull ? 'text-accent-green' : 'text-accent-red'}>{fmtUsd(c.bullPremium)}</span></div>
      <div>Calls: {fmtUsd(c.callPremium)} · Puts: {fmtUsd(c.putPremium)}</div>
      <div>Call volume: {fmtNum(c.callVolume)} · Put volume: {fmtNum(c.putVolume)}</div>
      <div>Buy: {c.buys} ({total ? Math.round((100 * c.buys) / total) : 0}%) · Sell: {c.sells} ({total ? Math.round((100 * c.sells) / total) : 0}%)</div>
      <div>Unknown: {c.unknown}</div>
    </div>
  );
}

// ─── Panel 8: Tape ──────────────────────────────────────────

export function TapePanel({ trades }: { trades: EnrichedTrade[] }) {
  const { settings } = useDesk();
  const [filter, setFilter] = useState<'all' | 'SWEEP' | 'BLOCK'>('all');
  const [minValue, setMinValue] = useState(25_000);
  const rows = useMemo(() => trades
    .filter((t) => (filter === 'all' ? t.kind === 'SWEEP' || t.kind === 'BLOCK' : t.kind === filter) && t.premium >= minValue)
    .sort((a, b) => b.time - a.time)
    .slice(0, 200), [trades, filter, minValue]);

  return (
    <Panel id="tape" title="Tape"
      subtitle={`Sweeps & blocks, newest first · DETAILS qty@price with _A (ask side), _B (bid side), _M (mid/unknown) · rows flagged ITM have |Δ| > ${settings.deepItmDelta} and are ${settings.excludeDeepItm ? 'excluded from' : 'included in'} sentiment`}
      actions={<>
        <Seg value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Sweep+Block' }, { value: 'SWEEP', label: 'Sweeps' }, { value: 'BLOCK', label: 'Blocks' }]} />
        <Seg value={minValue} onChange={setMinValue} options={[{ value: 0, label: 'All $' }, { value: 25_000, label: '≥$25K' }, { value: 100_000, label: '≥$100K' }]} />
      </>}>
      <div className="overflow-auto max-h-[560px]">
        <table className="w-full text-xs font-mono" data-testid="tape-table">
          <thead className="sticky top-0 bg-bg-secondary">
            <tr className="text-text-muted border-b border-border">
              {['TIME', 'SYMBOL', 'EXP', 'STRIKE', 'C/P', 'SPOT', 'DETAILS', 'TYPE', 'VALUE', 'IV'].map((h) => (
                <th key={h} className={`px-2 py-1.5 font-medium ${['TIME', 'SYMBOL', 'EXP', 'C/P', 'DETAILS', 'TYPE'].includes(h) ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const tone = t.side === 'buy' ? 'text-accent-green' : t.side === 'sell' ? 'text-accent-red' : 'text-text-secondary';
              return (
                <tr key={t.id} className={`border-b border-border/40 ${t.deepItm ? 'opacity-60' : ''}`}>
                  <td className="px-2 py-1 text-text-secondary">{new Date(t.time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })}</td>
                  <td className="px-2 py-1 text-accent-cyan">{t.root}</td>
                  <td className="px-2 py-1">{t.expiry}</td>
                  <td className="px-2 py-1 text-right">{t.strike}</td>
                  <td className={`px-2 py-1 ${t.right === 'C' ? 'text-accent-green' : 'text-accent-red'}`}>{t.right === 'C' ? 'CALL' : 'PUT'}</td>
                  <td className="px-2 py-1 text-right">{t.spot.toFixed(2)}</td>
                  <td className={`px-2 py-1 ${tone}`}>{tapeDetail(t, t.side)}{t.deepItm && <span className="ml-1.5 px-1 rounded border border-accent-amber/40 text-accent-amber text-[9px]">ITM Δ{Math.abs(t.delta ?? 0).toFixed(2)} excl.</span>}{t.nbboAtTrade === false && <span className="ml-1 text-[9px] text-text-muted">≈quote</span>}</td>
                  <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded text-[10px] ${t.kind === 'SWEEP' ? 'bg-accent-purple/15 text-accent-purple' : 'bg-accent-amber/15 text-accent-amber'}`}>{t.kind}</span></td>
                  <td className="px-2 py-1 text-right text-text-primary">{fmtUsd(t.premium)}</td>
                  <td className="px-2 py-1 text-right">{t.iv != null ? `${(t.iv * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={10} className="text-center text-text-muted py-6">No prints match</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
