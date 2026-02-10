'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { Thermometer, Brain, TrendingUp, TrendingDown } from 'lucide-react';

// ─── VIX Panel (chart + context + ranges) ─────────────────

function VIXPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();
  const vix = snapshot?.vix;
  const vixSeries = snapshot?.vixTimeSeries;

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !vixSeries?.length) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const pad = { top: 20, right: 55, bottom: 30, left: 45 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    // VIX values are already in decimal (divided by 100 in snapshot route)
    // Convert back to VIX points for charting
    const data = vixSeries;
    const vixValues = data.map(d => d.vix * 100);
    const minV = Math.min(...vixValues) * 0.9;
    const maxV = Math.max(...vixValues) * 1.1;
    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;

    const toX = (t: number) => pad.left + ((t - minTime) / (maxTime - minTime)) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minV) / (maxV - minV)) * ch;

    // Zone fills — key VIX levels
    // Complacency zone (< 13)
    if (minV < 13 && 13 < maxV) {
      const y13 = toY(13);
      ctx.fillStyle = '#00e67606';
      ctx.fillRect(pad.left, y13, cw, pad.top + ch - y13);
    }
    // Moderate zone (18-25)
    if (minV < 25 && 18 < maxV) {
      const y18 = toY(Math.max(18, minV));
      const y25 = toY(Math.min(25, maxV));
      ctx.fillStyle = '#ffaa0006';
      ctx.fillRect(pad.left, y25, cw, y18 - y25);
    }
    // Elevated zone (> 25)
    if (maxV > 25) {
      const y25 = toY(25);
      ctx.fillStyle = '#ff3d5706';
      ctx.fillRect(pad.left, pad.top, cw, y25 - pad.top);
    }

    // Zone boundary lines
    const thresholds = [13, 18, 25, 35];
    const threshColors = ['#00e676', '#ffaa00', '#ff3d57', '#ff1744'];
    const threshLabels = ['Complacent', 'Normal', 'Elevated', 'Fear'];
    for (let i = 0; i < thresholds.length; i++) {
      const t = thresholds[i];
      if (t > minV && t < maxV) {
        const y = toY(t);
        ctx.strokeStyle = `${threshColors[i]}20`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = `${threshColors[i]}50`;
        ctx.font = '7px "JetBrains Mono"';
        ctx.textAlign = 'left';
        ctx.fillText(threshLabels[i], w - pad.right + 3, y - 3);
      }
    }

    // Grid
    ctx.strokeStyle = '#1a1a2510';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // VIX area fill
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(vixValues[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(vixValues[i]));
    }
    ctx.lineTo(toX(data[data.length - 1].time), pad.top + ch);
    ctx.lineTo(toX(data[0].time), pad.top + ch);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    gradient.addColorStop(0, '#ff3d5715');
    gradient.addColorStop(0.5, '#ffaa0008');
    gradient.addColorStop(1, '#00e67605');
    ctx.fillStyle = gradient;
    ctx.fill();

    // VIX line — color changes based on level
    for (let i = 1; i < data.length; i++) {
      ctx.beginPath();
      ctx.moveTo(toX(data[i - 1].time), toY(vixValues[i - 1]));
      ctx.lineTo(toX(data[i].time), toY(vixValues[i]));
      const v = vixValues[i];
      ctx.strokeStyle = v > 25 ? '#ff3d57' : v > 18 ? '#ffaa00' : '#00e676';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 20-day MA
    if (vixValues.length >= 20) {
      ctx.beginPath();
      let started = false;
      for (let i = 19; i < vixValues.length; i++) {
        const ma = vixValues.slice(i - 19, i + 1).reduce((s, v) => s + v, 0) / 20;
        if (!started) {
          ctx.moveTo(toX(data[i].time), toY(ma));
          started = true;
        } else {
          ctx.lineTo(toX(data[i].time), toY(ma));
        }
      }
      ctx.strokeStyle = '#b388ff60';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Current VIX dot
    if (vix) {
      const lastX = toX(data[data.length - 1].time);
      const lastY = toY(vix.price);
      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, 2 * Math.PI);
      ctx.fillStyle = vix.price > 25 ? '#ff3d57' : vix.price > 18 ? '#ffaa00' : '#00e676';
      ctx.fill();
      // Label
      ctx.fillStyle = vix.price > 25 ? '#ff3d57' : vix.price > 18 ? '#ffaa00' : '#00e676';
      ctx.font = '10px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(vix.price.toFixed(1), w - pad.right + 4, lastY + 4);
    }

    // Y axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = minV + ((maxV - minV) / 4) * (4 - i);
      ctx.fillText(val.toFixed(0), pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    // X axis dates
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, data.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (data.length - 1));
      const d = new Date(data[idx].time * 1000);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(data[idx].time), h - pad.bottom + 14);
    }

    // Legend
    ctx.font = '8px "JetBrains Mono"';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8888a0';
    ctx.fillText('VIX', pad.left + 4, pad.top + 10);
    ctx.fillStyle = '#b388ff60';
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = '#b388ff60';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left + 28, pad.top + 8); ctx.lineTo(pad.left + 40, pad.top + 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8888a0';
    ctx.fillText('20d MA', pad.left + 44, pad.top + 10);

  }, [snapshot, vix, vixSeries]);

  if (!vix) return null;

  // Compute historical stats from the series
  const vixValues = vixSeries?.map(d => d.vix * 100) || [];
  const high52w = vixValues.length > 0 ? Math.max(...vixValues) : 0;
  const low52w = vixValues.length > 0 ? Math.min(...vixValues) : 0;
  const avg = vixValues.length > 0 ? vixValues.reduce((s, v) => s + v, 0) / vixValues.length : 0;
  const percentile = vixValues.length > 0
    ? Math.round((vixValues.filter(v => v <= vix.price).length / vixValues.length) * 100)
    : 50;
  const ma20 = vixValues.length >= 20
    ? vixValues.slice(-20).reduce((s, v) => s + v, 0) / 20
    : 0;

  // Regime label & color
  const regimeLabel = vix.price > 35 ? 'Extreme Fear' : vix.price > 25 ? 'Elevated Fear' : vix.price > 18 ? 'Moderate' : vix.price > 13 ? 'Low Volatility' : 'Complacency';
  const regimeColor = vix.price > 25 ? 'text-red-400' : vix.price > 18 ? 'text-amber-400' : 'text-green-400';
  const regimeBg = vix.price > 25 ? 'bg-red-500/10 text-red-400' : vix.price > 18 ? 'bg-amber-500/10 text-amber-400' : 'bg-green-500/10 text-green-400';

  // IV vs VIX spread
  const iv = snapshot?.iv;
  const ivPct = iv ? iv.currentIV * 100 : 0;
  const spread = ivPct > 0 ? ivPct - vix.price : 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Thermometer className="w-3.5 h-3.5 text-accent-purple" />
          <span className="panel-title">CBOE Volatility Index (VIX)</span>
        </div>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${regimeBg}`}>{regimeLabel}</span>
      </div>

      {/* Top stats row */}
      <div className="grid grid-cols-4 md:grid-cols-8 gap-2 px-4 pt-3 pb-2">
        <div>
          <div className="text-[9px] font-mono text-text-muted">Current</div>
          <div className={`text-lg font-mono font-bold ${regimeColor}`}>{vix.price.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">Change</div>
          <div className={`text-sm font-mono font-semibold flex items-center gap-0.5 ${vix.changePct >= 0 ? 'text-red-400' : 'text-green-400'}`}>
            {vix.changePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {vix.changePct >= 0 ? '+' : ''}{vix.changePct.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">20d MA</div>
          <div className="text-sm font-mono font-semibold text-text-secondary">{ma20 > 0 ? ma20.toFixed(1) : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">Percentile</div>
          <div className={`text-sm font-mono font-semibold ${percentile > 70 ? 'text-red-400' : percentile < 30 ? 'text-green-400' : 'text-text-secondary'}`}>
            {percentile}th
          </div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">Average</div>
          <div className="text-sm font-mono font-semibold text-text-muted">{avg > 0 ? avg.toFixed(1) : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">52w High</div>
          <div className="text-sm font-mono font-semibold text-red-400/60">{high52w > 0 ? high52w.toFixed(1) : '—'}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">52w Low</div>
          <div className="text-sm font-mono font-semibold text-green-400/60">{low52w > 0 ? low52w.toFixed(1) : '—'}</div>
        </div>
        {ivPct > 0 && (
          <div>
            <div className="text-[9px] font-mono text-text-muted">IV-VIX Spread</div>
            <div className={`text-sm font-mono font-semibold ${spread > 5 ? 'text-red-400' : spread < -5 ? 'text-green-400' : 'text-text-secondary'}`}>
              {spread > 0 ? '+' : ''}{spread.toFixed(1)}pp
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      {vixSeries && vixSeries.length >= 5 ? (
        <div ref={containerRef} className="min-h-[220px] px-0">
          <canvas ref={canvasRef} className="w-full h-full" />
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-xs font-mono text-text-muted">
          VIX history requires FRED API key (free) — add <code className="text-text-muted/80">FRED_API_KEY</code> to env
        </div>
      )}

      {/* Context interpretation */}
      <div className="px-4 py-3 border-t border-border/20 text-xs font-mono text-text-secondary leading-relaxed space-y-1.5">
        <p>
          <strong className={regimeColor}>{regimeLabel}:</strong>{' '}
          {vix.price > 35
            ? 'Markets pricing extreme uncertainty. Options premiums are highly elevated across the board. Hedging costs are at extremes — selling premium can be lucrative but carries significant tail risk. Historically, VIX spikes above 35 tend to mean-revert within weeks.'
            : vix.price > 25
            ? 'Elevated market fear. Options premiums are rich — selling strategies (iron condors, credit spreads) have a statistical edge but wider stops are needed. Expect intraday swings of 1-3%. Markets in this regime often see sharp reversals.'
            : vix.price > 18
            ? 'Normal volatility environment. Options pricing is fair relative to historical realized moves. Both buying and selling strategies can work; use IV rank of the specific stock to determine directional edge.'
            : vix.price > 13
            ? 'Low volatility — calm markets. Options are cheap, making long premium strategies (straddles, debit spreads) more attractive. Be cautious selling premium at these levels as sudden vol spikes can overwhelm small credits.'
            : 'Extreme complacency — VIX at historical lows. Markets pricing near-zero risk. This is often a contrarian warning. Long volatility positions (VIX calls, straddles) are historically cheap here.'}
        </p>
        {ma20 > 0 && (
          <p className="text-text-muted/60">
            {vix.price > ma20 * 1.1
              ? `VIX is ${((vix.price / ma20 - 1) * 100).toFixed(0)}% above its 20-day average (${ma20.toFixed(1)}) — rising vol regime, recent fear spike.`
              : vix.price < ma20 * 0.9
              ? `VIX is ${((1 - vix.price / ma20) * 100).toFixed(0)}% below its 20-day average (${ma20.toFixed(1)}) — vol compression, potential for expansion.`
              : `VIX is near its 20-day average (${ma20.toFixed(1)}) — stable volatility regime.`}
          </p>
        )}
        {ivPct > 0 && Math.abs(spread) > 5 && (
          <p className="text-text-muted/60">
            {spread > 10
              ? `This stock's IV (${ivPct.toFixed(0)}%) is ${spread.toFixed(0)}pp above VIX — significantly more volatile than the broad market. Likely reflects stock-specific risk (earnings, news, etc.).`
              : spread > 5
              ? `Stock IV at a ${spread.toFixed(0)}pp premium to VIX — modestly more volatile than market, typical for high-beta names.`
              : `Stock IV (${ivPct.toFixed(0)}%) is ${Math.abs(spread).toFixed(0)}pp below VIX — unusually calm for this market environment. May be underpricing risk.`}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── IV Rank Gauge ─────────────────────────────────────────

function IVGauge() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { snapshot } = useDashboardStore();
  const iv = snapshot?.iv;

  useEffect(() => {
    if (!canvasRef.current || !iv) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = 180;
    canvas.width = size * dpr;
    canvas.height = (size * 0.65) * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size * 0.65}px`;
    ctx.scale(dpr, dpr);

    const cx = size / 2, cy = size * 0.55;
    const r = size * 0.38;
    const startAngle = Math.PI;

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, 2 * Math.PI);
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#1a1a25';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Gradient arc for value
    const valueAngle = startAngle + (iv.ivRank / 100) * Math.PI;
    const gradient = ctx.createLinearGradient(0, cy, size, cy);
    gradient.addColorStop(0, '#00e676');
    gradient.addColorStop(0.5, '#ffaa00');
    gradient.addColorStop(1, '#ff3d57');

    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, valueAngle);
    ctx.lineWidth = 14;
    ctx.strokeStyle = gradient;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Needle
    const needleAngle = startAngle + (iv.ivRank / 100) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(needleAngle) * (r - 20), cy + Math.sin(needleAngle) * (r - 20));
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e8e8ef';
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#e8e8ef';
    ctx.fill();

    // Labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'center';
    ctx.fillText('0', cx - r - 2, cy + 14);
    ctx.fillText('100', cx + r + 2, cy + 14);
    ctx.fillText('50', cx, cy - r + 6);

  }, [snapshot, iv]);

  if (!iv) return null;

  const rankColor = iv.ivRank > 70 ? 'text-accent-red' : iv.ivRank < 30 ? 'text-accent-green' : 'text-accent-amber';

  return (
    <div className="panel p-4 flex flex-col items-center">
      <span className="panel-title mb-2">IV Rank</span>
      <canvas ref={canvasRef} />
      <div className={`text-3xl font-mono font-bold mt-1 ${rankColor}`}>{iv.ivRank}</div>
      <div className="text-xs font-mono text-text-muted mt-1">
        Percentile: {iv.ivPercentile}%
      </div>
    </div>
  );
}

// ─── IV Stats ──────────────────────────────────────────────

function IVStats() {
  const { snapshot } = useDashboardStore();
  const iv = snapshot?.iv;
  const hv = snapshot?.historicalVol;
  if (!iv) return null;

  const stats = [
    { label: 'Current IV', value: `${(iv.currentIV * 100).toFixed(1)}%`, color: 'text-text-primary' },
    { label: '30d MA', value: `${(iv.iv30dMA * 100).toFixed(1)}%`, color: iv.currentIV > iv.iv30dMA ? 'text-accent-red' : 'text-accent-green' },
    { label: '52w High', value: `${(iv.iv52wHigh * 100).toFixed(1)}%`, color: 'text-accent-red' },
    { label: '52w Low', value: `${(iv.iv52wLow * 100).toFixed(1)}%`, color: 'text-accent-green' },
    { label: 'HV 20d', value: hv ? `${(hv.hv20 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary' },
    { label: 'HV 60d', value: hv ? `${(hv.hv60 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary' },
    { label: 'IV/HV Ratio', value: iv.ivHvRatio.toFixed(2), color: iv.ivHvRatio > 1.3 ? 'text-accent-red' : iv.ivHvRatio < 0.8 ? 'text-accent-green' : 'text-text-primary' },
  ];

  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">IV Statistics</span></div>
      <div className="divide-y divide-border/30">
        {stats.map((s) => (
          <div key={s.label} className="px-4 py-2 flex justify-between items-center">
            <span className="text-xs font-mono text-text-muted">{s.label}</span>
            <span className={`text-sm font-mono font-medium ${s.color}`}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── IV vs VIX History Chart ──────────────────────────────

function IVvsVIXChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;
    const ivSeries = snapshot?.ivTimeSeries;
    const vixSeries = snapshot?.vixTimeSeries;
    if (!ivSeries?.length) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const pad = { top: 25, right: 60, bottom: 35, left: 55 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const data = ivSeries;
    if (data.length < 5) return;

    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;

    // Collect all values for Y scale
    const allVals = data.flatMap(d => [d.hv20, d.ivProxy]);
    if (vixSeries?.length) {
      for (const v of vixSeries) {
        if (v.time >= minTime && v.time <= maxTime) allVals.push(v.vix);
      }
    }
    if (snapshot?.iv?.currentIV) allVals.push(snapshot.iv.currentIV);

    const minV = Math.min(...allVals) * 0.85;
    const maxV = Math.max(...allVals) * 1.1;

    const toX = (t: number) => pad.left + ((t - minTime) / (maxTime - minTime)) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minV) / (maxV - minV)) * ch;

    // Grid lines
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (ch / 5) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // HV20 area fill
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].hv20));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].hv20));
    }
    ctx.lineTo(toX(data[data.length - 1].time), pad.top + ch);
    ctx.lineTo(toX(data[0].time), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = '#00d4ff08';
    ctx.fill();

    // HV20 line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].hv20));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].hv20));
    }
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // IV Proxy line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].ivProxy));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].ivProxy));
    }
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // VIX history line (if available)
    if (vixSeries?.length) {
      const vixInRange = vixSeries.filter(v => v.time >= minTime && v.time <= maxTime);
      if (vixInRange.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(toX(vixInRange[0].time), toY(vixInRange[0].vix));
        for (let i = 1; i < vixInRange.length; i++) {
          ctx.lineTo(toX(vixInRange[i].time), toY(vixInRange[i].vix));
        }
        ctx.strokeStyle = '#ff3d57';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Current IV horizontal line
    if (snapshot?.iv?.currentIV) {
      const cy = toY(snapshot.iv.currentIV);
      ctx.strokeStyle = '#ffaa0060';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, cy); ctx.lineTo(w - pad.right, cy); ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffaa00';
      ctx.font = '9px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`IV ${(snapshot.iv.currentIV * 100).toFixed(0)}%`, w - pad.right + 4, cy + 3);
    }

    // Y axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const val = minV + ((maxV - minV) / 5) * (5 - i);
      ctx.fillText(`${(val * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 5) * i + 3);
    }

    // X axis labels
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, data.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (data.length - 1));
      const d = new Date(data[idx].time * 1000);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(data[idx].time), h - pad.bottom + 14);
    }

    // Legend
    const legendY = 12;
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'left';
    let lx = pad.left;
    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(lx, legendY - 4, 12, 2);
    ctx.fillText('HV 20d', lx + 16, legendY);
    lx += 80;
    ctx.fillStyle = '#b388ff';
    ctx.fillRect(lx, legendY - 4, 12, 2);
    ctx.fillText('IV Proxy', lx + 16, legendY);
    lx += 85;
    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(lx, legendY - 4, 12, 2);
    ctx.fillText('Current IV', lx + 16, legendY);
    if (vixSeries?.length) {
      lx += 95;
      ctx.fillStyle = '#ff3d57';
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = '#ff3d57';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, legendY - 3); ctx.lineTo(lx + 12, legendY - 3); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('VIX', lx + 16, legendY);
    }

  }, [snapshot]);

  if (!snapshot?.ivTimeSeries?.length) {
    return (
      <div className="panel p-8 flex items-center justify-center">
        <span className="text-sm font-mono text-text-muted">IV history requires snapshot data</span>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">IV / HV / VIX History</span>
        <span className="badge badge-purple">{snapshot.ivTimeSeries.length}d</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[280px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}

// ─── Term Structure Chart ──────────────────────────────────

function TermStructureChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !snapshot?.termStructure?.length) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const pad = { top: 20, right: 50, bottom: 35, left: 50 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const data = snapshot.termStructure.filter(d => d.dte > 0 && d.dte <= 180 && d.atmIV > 0);
    if (data.length < 2) return;

    const minDTE = 0;
    const maxDTE = Math.max(...data.map(d => d.dte));
    const vixDecimal = snapshot.vix ? snapshot.vix.price / 100 : 0;
    const ivValues = data.map(d => d.atmIV);
    if (vixDecimal > 0) ivValues.push(vixDecimal);
    const minIV = Math.min(...ivValues) * 0.9;
    const maxIV = Math.max(...ivValues) * 1.1;

    const toX = (dte: number) => pad.left + ((dte - minDTE) / (maxDTE - minDTE)) * cw;
    const toY = (iv: number) => pad.top + ch - ((iv - minIV) / (maxIV - minIV)) * ch;

    // Grid
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // VIX horizontal reference line
    if (vixDecimal > 0 && vixDecimal >= minIV && vixDecimal <= maxIV) {
      const vy = toY(vixDecimal);
      ctx.strokeStyle = '#ff3d5740';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, vy); ctx.lineTo(w - pad.right, vy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff3d57';
      ctx.font = '8px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`VIX ${snapshot.vix!.price.toFixed(0)}`, w - pad.right + 4, vy + 3);
    }

    // Line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].dte), toY(data[0].atmIV));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].dte), toY(data[i].atmIV));
    }
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill under
    ctx.lineTo(toX(data[data.length - 1].dte), pad.top + ch);
    ctx.lineTo(toX(data[0].dte), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = '#b388ff10';
    ctx.fill();

    // Points
    data.forEach(d => {
      ctx.beginPath();
      ctx.arc(toX(d.dte), toY(d.atmIV), 3, 0, 2 * Math.PI);
      ctx.fillStyle = '#b388ff';
      ctx.fill();
    });

    // Labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    data.forEach(d => {
      ctx.textAlign = 'center';
      ctx.fillText(`${d.dte}d`, toX(d.dte), h - pad.bottom + 14);
    });

    // Y axis
    for (let i = 0; i <= 4; i++) {
      const iv = minIV + ((maxIV - minIV) / 4) * (4 - i);
      ctx.textAlign = 'right';
      ctx.fillText(`${(iv * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

  }, [snapshot]);

  const ts = snapshot?.termStructure?.filter(d => d.dte > 0 && d.dte <= 180) ?? [];
  const isBackwardation = ts.length >= 2 && ts[0].atmIV > ts[ts.length - 1].atmIV;

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">IV Term Structure</span>
        {ts.length >= 2 && (
          <span className={`badge ${isBackwardation ? 'badge-red' : 'badge-green'}`}>
            {isBackwardation ? 'Backwardation' : 'Contango'}
          </span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-[200px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      {isBackwardation && (
        <div className="px-4 py-2 border-t border-border text-xs text-text-secondary font-mono">
          Near-term IV exceeds far-term — market pricing imminent risk (earnings, event, etc.)
        </div>
      )}
    </div>
  );
}

// ─── Skew Chart ────────────────────────────────────────────

function SkewChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !snapshot?.skewSurface?.length) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const pad = { top: 20, right: 20, bottom: 35, left: 50 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const spot = snapshot.spotPrice;
    const exps = snapshot.skewSurface.slice(0, 3);
    if (exps.length === 0) return;

    const allPoints = exps.flatMap(e => e.points);
    const minIV = Math.min(...allPoints.map(p => p.iv)) * 0.9;
    const maxIV = Math.max(...allPoints.map(p => p.iv)) * 1.1;

    const focusMin = spot * 0.9, focusMax = spot * 1.1;
    const toX = (strike: number) => pad.left + ((strike - focusMin) / (focusMax - focusMin)) * cw;
    const toY = (iv: number) => pad.top + ch - ((iv - minIV) / (maxIV - minIV)) * ch;

    const colors = ['#00d4ff', '#b388ff', '#ffaa00'];

    exps.forEach((exp, ei) => {
      const pts = exp.points.filter(p => p.strike >= focusMin && p.strike <= focusMax);
      if (pts.length < 2) return;

      ctx.beginPath();
      ctx.moveTo(toX(pts[0].strike), toY(pts[0].iv));
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(toX(pts[i].strike), toY(pts[i].iv));
      }
      ctx.strokeStyle = colors[ei] || '#8888a0';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    const sx = toX(spot);
    ctx.strokeStyle = '#e8e8ef20';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(sx, pad.top); ctx.lineTo(sx, h - pad.bottom); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#8888a0';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'center';
    ctx.fillText('ATM', sx, h - pad.bottom + 12);

    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const iv = minIV + ((maxIV - minIV) / 4) * (4 - i);
      ctx.fillText(`${(iv * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    exps.forEach((exp, ei) => {
      ctx.fillStyle = colors[ei];
      ctx.font = '9px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`${exp.dte}d`, w - pad.right - 40, pad.top + 14 + ei * 14);
    });

  }, [snapshot]);

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">Volatility Skew</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[200px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}

// ─── IV Interpretation ─────────────────────────────────────

function IVInterpretation() {
  const { snapshot } = useDashboardStore();
  if (!snapshot?.iv?.interpretation) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-accent-purple" />
          Volatility Context
        </span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm text-text-secondary leading-relaxed">{snapshot.iv.interpretation}</p>
      </div>
    </div>
  );
}

// ─── Main Volatility Tab ───────────────────────────────────

export default function VolatilityTab() {
  const { snapshot, loading } = useDashboardStore();

  if (loading.snapshot && !snapshot) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="panel p-8 flex items-center justify-center">
          <div className="flex items-center gap-3 text-text-muted font-mono">
            <div className="w-5 h-5 border-2 border-accent-purple/30 border-t-accent-purple rounded-full animate-spin" />
            Loading Polygon options snapshot & computing IV analytics...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* VIX Panel — full-width with chart, stats, and context */}
      <VIXPanel />

      {/* Top row: gauge + stats + term structure */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <IVGauge />
        <IVStats />
        <TermStructureChart />
      </div>

      {/* IV vs VIX History */}
      <IVvsVIXChart />

      {/* Interpretation */}
      <IVInterpretation />

      {/* Skew */}
      <SkewChart />

      {/* Snapshot info */}
      {snapshot && (
        <div className="text-xs font-mono text-text-muted text-center py-2">
          Polygon snapshot: {snapshot.snapshotCount} contracts analyzed
          {snapshot.vix && ` | VIX: ${snapshot.vix.price.toFixed(2)}`}
        </div>
      )}
    </div>
  );
}
