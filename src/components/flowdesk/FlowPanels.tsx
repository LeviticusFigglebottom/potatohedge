'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { expirationTable, intradayFlow, recentTrades, symbolTable, type EnrichedTrade, type ExpirationRow, type SymbolRow } from '@/lib/flowdesk/flow/aggregate';
import { useDesk } from './useFlowDesk';
import { C, deskChart, etTime, fmtNum, fmtUsd } from './chart/theme';
import { Panel, SentimentBadge, Signed, SortTable, Toggle, type Column } from './ui';

// ─── Panel 1: Options Flow ──────────────────────────────────

export function OptionsFlowPanel({ symbol, trades }: { symbol: string; trades: EnrichedTrade[] }) {
  const { settings, setSettings } = useDesk();
  const [showPrice, setShowPrice] = useState(true);
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<Record<string, ISeriesApi<'Line'> | ISeriesApi<'Histogram'>>>({});
  const points = useMemo(() => intradayFlow(trades.filter((t) => t.root === symbol), { rthOnly: settings.rthOnly }), [trades, symbol, settings.rthOnly]);
  const last = points[points.length - 1];

  useEffect(() => {
    if (!el.current) return;
    const c = deskChart(el.current, { leftPriceScale: { visible: true, borderColor: C.border }, rightPriceScale: { visible: true, borderColor: C.border } });
    chart.current = c;
    const money = { type: 'custom' as const, formatter: (v: number) => fmtUsd(v) };
    series.current = {
      call: c.addLineSeries({ color: C.green, lineWidth: 2, title: 'Call flow', priceFormat: money }),
      put: c.addLineSeries({ color: C.red, lineWidth: 2, title: 'Put flow', priceFormat: money }),
      net: c.addLineSeries({ color: C.cyan, lineWidth: 2, title: 'Net flow', priceFormat: money }),
      price: c.addLineSeries({ color: C.amber, lineWidth: 1, lineStyle: LineStyle.Dotted, priceScaleId: 'left', title: symbol }),
      vol: c.addHistogramSeries({ color: '#8888a055', priceScaleId: 'vol', priceFormat: { type: 'volume' } }),
    };
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    c.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.22 } });
    c.priceScale('left').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.22 } });
    return () => { c.remove(); chart.current = null; };
  }, [symbol]);

  useEffect(() => {
    const s = series.current;
    if (!s.call) return;
    s.call.setData(points.map((p) => ({ time: etTime(p.time), value: p.callFlow })));
    s.put.setData(points.map((p) => ({ time: etTime(p.time), value: p.putFlow })));
    s.net.setData(points.map((p) => ({ time: etTime(p.time), value: p.netFlow })));
    s.price.setData(points.map((p) => ({ time: etTime(p.time), value: p.spot })));
    (s.vol as ISeriesApi<'Histogram'>).setData(points.map((p) => ({ time: etTime(p.time), value: p.volume, color: p.callVolume >= p.putVolume ? '#00e67640' : '#ff3d5740' })));
    chart.current?.timeScale().fitContent();
  }, [points]);

  useEffect(() => {
    series.current.price?.applyOptions({ visible: showPrice });
    chart.current?.applyOptions({ leftPriceScale: { visible: showPrice } });
  }, [showPrice]);

  return (
    <Panel id="options-flow" title={`Options Flow — ${symbol}`}
      subtitle="Cumulative aggressor-signed premium by minute (buy at/above ask +, sell at/below bid −). Net = Call − Put. Price on the left axis."
      actions={<>
        <Toggle label="Show Stock Price" checked={showPrice} onChange={setShowPrice} />
        <Toggle label="RTH Only" checked={settings.rthOnly} onChange={(v) => setSettings({ rthOnly: v })} />
      </>}>
      <div className="flex flex-wrap gap-4 text-[11px] font-mono mb-2 text-text-secondary">
        <LegendSwatch color={C.green} label="Call flow" value={last ? fmtUsd(last.callFlow) : '—'} />
        <LegendSwatch color={C.red} label="Put flow" value={last ? fmtUsd(last.putFlow) : '—'} />
        <LegendSwatch color={C.cyan} label="Net flow" value={last ? fmtUsd(last.netFlow) : '—'} />
        {showPrice && <LegendSwatch color={C.amber} label={`${symbol} price`} value={last ? last.spot.toFixed(2) : '—'} dotted />}
        <LegendSwatch color="#8888a0" label="Volume (contracts/min)" value="" bar />
      </div>
      <div ref={el} className="h-[360px] w-full" />
    </Panel>
  );
}

function LegendSwatch({ color, label, value, dotted, bar }: { color: string; label: string; value: string; dotted?: boolean; bar?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {bar ? <span className="w-2.5 h-2.5 rounded-sm" style={{ background: `${color}88` }} />
        : <span className="w-4 h-0" style={{ borderTop: `2px ${dotted ? 'dotted' : 'solid'} ${color}` }} />}
      {label} <span className="text-text-primary">{value}</span>
    </span>
  );
}

// ─── Panels 2 & 4: symbols ──────────────────────────────────

const symbolColumns: Column<SymbolRow>[] = [
  { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, align: 'left', render: (r) => <span className="text-accent-cyan">{r.symbol}</span> },
  { key: 'net', label: 'Net Premium', value: (r) => r.netPremium, render: (r) => <Signed v={r.netPremium} fmt={fmtUsd} /> },
  { key: 'call', label: 'Call Premium', value: (r) => r.callPremium, render: (r) => <Signed v={r.callPremium} fmt={fmtUsd} /> },
  { key: 'put', label: 'Put Premium', value: (r) => r.putPremium, render: (r) => <Signed v={r.putPremium} fmt={fmtUsd} /> },
  { key: 'vol', label: 'Total Volume', value: (r) => r.totalVolume, render: (r) => fmtNum(r.totalVolume) },
  { key: 'cvol', label: 'Call Vol', value: (r) => r.callVolume, render: (r) => fmtNum(r.callVolume) },
  { key: 'pvol', label: 'Put Vol', value: (r) => r.putVolume, render: (r) => fmtNum(r.putVolume) },
  { key: 'sent', label: 'Sentiment', value: (r) => r.netPremium, render: (r) => <SentimentBadge s={r.sentiment} /> },
];

const netLabel = (c: string) => (c === 'call_minus_put' ? 'Net = Call − Put' : 'Net = Call + Put');

export function TopSymbolsPanel({ trades }: { trades: EnrichedTrade[] }) {
  const { settings } = useDesk();
  const rows = useMemo(() => symbolTable(trades, settings.symbolsNet), [trades, settings.symbolsNet]);
  return (
    <Panel id="top-symbols" title="Top Symbols by Premium Flow" subtitle={`${netLabel(settings.symbolsNet)} · aggressor-signed premium${settings.excludeDeepItm ? ` · |Δ| > ${settings.deepItmDelta} excluded` : ''}`}>
      <SortTable rows={rows} columns={symbolColumns} rowKey={(r) => r.symbol} initialSort={{ key: 'net', dir: 'desc' }} testId="top-symbols-table" />
    </Panel>
  );
}

export function RecentFlowPanel({ trades, nowMs }: { trades: EnrichedTrade[]; nowMs: number }) {
  const { settings } = useDesk();
  const rows = useMemo(() => symbolTable(recentTrades(trades, nowMs, settings.recentWindowMin), settings.symbolsNet), [trades, nowMs, settings]);
  const until = new Date(nowMs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  return (
    <Panel id="recent-flow" title={`Recent Flow (Last ${settings.recentWindowMin} Minutes)`} subtitle={`Rolling window ending ${until} ET · ${netLabel(settings.symbolsNet)}`}>
      <SortTable rows={rows} columns={symbolColumns} rowKey={(r) => r.symbol} initialSort={{ key: 'net', dir: 'desc' }} testId="recent-flow-table" />
    </Panel>
  );
}

// ─── Panel 3: by expiration ─────────────────────────────────

const expColumns: Column<ExpirationRow>[] = [
  { key: 'exp', label: 'Expiration', value: (r) => r.expiration, align: 'left' },
  { key: 'net', label: 'Net Premium', value: (r) => r.netPremium, render: (r) => <Signed v={r.netPremium} fmt={fmtUsd} /> },
  { key: 'call', label: 'Call Premium', value: (r) => r.callPremium, render: (r) => <Signed v={r.callPremium} fmt={fmtUsd} /> },
  { key: 'put', label: 'Put Premium', value: (r) => r.putPremium, render: (r) => <Signed v={r.putPremium} fmt={fmtUsd} /> },
  { key: 'vol', label: 'Total Volume', value: (r) => r.totalVolume, render: (r) => fmtNum(r.totalVolume) },
  { key: 'cp', label: 'Call/Put Ratio', value: (r) => (Number.isFinite(r.callPutRatio) ? r.callPutRatio : 1e9), render: (r) => (Number.isFinite(r.callPutRatio) ? r.callPutRatio.toFixed(2) : '∞') },
  { key: 'sent', label: 'Sentiment', value: (r) => r.netPremium, render: (r) => <SentimentBadge s={r.sentiment} /> },
];

export function ByExpirationPanel({ trades }: { trades: EnrichedTrade[] }) {
  const { settings } = useDesk();
  const rows = useMemo(() => expirationTable(trades, settings.expirationNet), [trades, settings.expirationNet]);
  return (
    <Panel id="by-expiration" title="Premium Flow by Expiration (All Symbols)" subtitle={`${netLabel(settings.expirationNet)} · Call/Put Ratio = call volume ÷ put volume`}>
      <SortTable rows={rows} columns={expColumns} rowKey={(r) => r.expiration} initialSort={{ key: 'exp', dir: 'asc' }} testId="by-expiration-table" />
    </Panel>
  );
}
