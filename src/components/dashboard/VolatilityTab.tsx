'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { Thermometer, Brain, TrendingUp, TrendingDown, Shield } from 'lucide-react';

// New modular vol components
import InfoTip from './vol/InfoTip';
import VRPChart from './vol/VRPChart';
import VolSurface from './vol/VolSurface';
import VolCone from './vol/VolCone';
import { IVGauge, IVStats, TermStructureChart, SkewChart } from './vol/VolPanels';

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

    const data = vixSeries;
    const vixValues = data.map(d => d.vix * 100);
    const sortedVix = [...vixValues].sort((a, b) => a - b);
    const vp2 = sortedVix[Math.floor(sortedVix.length * 0.02)] ?? sortedVix[0];
    const vp98 = sortedVix[Math.floor(sortedVix.length * 0.98)] ?? sortedVix[sortedVix.length - 1];
    const minV = Math.min(vp2 * 0.9, 10);
    const maxV = Math.max(vp98 * 1.1, 30);
    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;

    const toX = (t: number) => pad.left + ((t - minTime) / (maxTime - minTime)) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minV) / (maxV - minV)) * ch;

    // Zone fills
    if (minV < 13 && 13 < maxV) {
      ctx.fillStyle = '#00e67606';
      ctx.fillRect(pad.left, toY(13), cw, pad.top + ch - toY(13));
    }
    if (minV < 25 && 18 < maxV) {
      const y18 = toY(Math.max(18, minV));
      const y25 = toY(Math.min(25, maxV));
      ctx.fillStyle = '#ffaa0006';
      ctx.fillRect(pad.left, y25, cw, y18 - y25);
    }
    if (maxV > 25) {
      ctx.fillStyle = '#ff3d5706';
      ctx.fillRect(pad.left, pad.top, cw, toY(25) - pad.top);
    }

    // Zone boundaries
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

    // VIX line
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
        if (!started) { ctx.moveTo(toX(data[i].time), toY(ma)); started = true; }
        else { ctx.lineTo(toX(data[i].time), toY(ma)); }
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
      ctx.fillStyle = vix.price > 25 ? '#ff3d57' : vix.price > 18 ? '#ffaa00' : '#00e676';
      ctx.font = '10px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(vix.price.toFixed(1), w - pad.right + 4, lastY + 4);
    }

    // Y axis
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = minV + ((maxV - minV) / 4) * (4 - i);
      ctx.fillText(val.toFixed(0), pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    // X axis
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

  const regimeLabel = vix.price > 35 ? 'Extreme Fear' : vix.price > 25 ? 'Elevated Fear' : vix.price > 18 ? 'Moderate' : vix.price > 13 ? 'Low Volatility' : 'Complacency';
  const regimeColor = vix.price > 25 ? 'text-red-400' : vix.price > 18 ? 'text-amber-400' : 'text-green-400';
  const regimeBg = vix.price > 25 ? 'bg-red-500/10 text-red-400' : vix.price > 18 ? 'bg-amber-500/10 text-amber-400' : 'bg-green-500/10 text-green-400';

  const iv = snapshot?.iv;
  const ivPct = iv ? iv.currentIV * 100 : 0;
  const spread = ivPct > 0 ? ivPct - vix.price : 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Thermometer className="w-3.5 h-3.5 text-accent-purple" />
          <span className="panel-title">CBOE Volatility Index (VIX)</span>
          <InfoTip text="The VIX measures the market's 30-day expected volatility derived from S&P 500 options. It's the benchmark 'fear gauge.' Low VIX (<15) = complacency, options are cheap across the market. High VIX (>25) = fear, options are expensive. Mean-reverting: extreme spikes tend to fade within weeks. Compare your stock's IV to VIX to gauge relative richness." />
        </div>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${regimeBg}`}>{regimeLabel}</span>
      </div>

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

      {vixSeries && vixSeries.length >= 5 ? (
        <div ref={containerRef} className="min-h-[220px] px-0">
          <canvas ref={canvasRef} className="w-full h-full" />
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-xs font-mono text-text-muted">
          VIX history requires FRED API key (free) — add <code className="text-text-muted/80">FRED_API_KEY</code> to env
        </div>
      )}

      <div className="px-4 py-3 border-t border-border/20 text-xs font-mono text-text-secondary leading-relaxed space-y-1.5">
        <p>
          <strong className={regimeColor}>{regimeLabel}:</strong>{' '}
          {vix.price > 35
            ? 'Markets pricing extreme uncertainty. Options premiums are highly elevated across the board. Historically, VIX spikes above 35 tend to mean-revert within weeks.'
            : vix.price > 25
            ? 'Elevated market fear. Options premiums are rich — selling strategies (iron condors, credit spreads) have a statistical edge but wider stops are needed.'
            : vix.price > 18
            ? 'Normal volatility environment. Options pricing is fair relative to historical realized moves.'
            : vix.price > 13
            ? 'Low volatility — calm markets. Options are cheap, making long premium strategies (straddles, debit spreads) more attractive.'
            : 'Extreme complacency — VIX at historical lows. Long volatility positions (VIX calls, straddles) are historically cheap here.'}
        </p>
        {ma20 > 0 && (
          <p className="text-text-muted/60">
            {vix.price > ma20 * 1.1
              ? `VIX is ${((vix.price / ma20 - 1) * 100).toFixed(0)}% above its 20-day average (${ma20.toFixed(1)}) — rising vol regime.`
              : vix.price < ma20 * 0.9
              ? `VIX is ${((1 - vix.price / ma20) * 100).toFixed(0)}% below its 20-day average (${ma20.toFixed(1)}) — vol compression.`
              : `VIX is near its 20-day average (${ma20.toFixed(1)}) — stable volatility regime.`}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── CBOE SKEW Index Panel ─────────────────────────────────

function SKEWPanel() {
  const { snapshot } = useDashboardStore();
  const skew = snapshot?.skew;
  if (!skew) return null;

  const level = skew.current > 150 ? 'Extreme' : skew.current > 140 ? 'Elevated' : skew.current > 125 ? 'Normal' : 'Low';
  const color = skew.current > 150 ? 'text-red-400' : skew.current > 140 ? 'text-amber-400' : skew.current > 125 ? 'text-text-primary' : 'text-green-400';
  const bg = skew.current > 150 ? 'bg-red-500/10 text-red-400' : skew.current > 140 ? 'bg-amber-500/10 text-amber-400' : skew.current > 125 ? 'bg-bg-tertiary text-text-muted' : 'bg-green-500/10 text-green-400';

  const gaugeMin = 100, gaugeMax = 170;
  const gaugePct = Math.max(0, Math.min(100, ((skew.current - gaugeMin) / (gaugeMax - gaugeMin)) * 100));

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-accent-amber" />
          <span className="panel-title">CBOE SKEW Index</span>
          <InfoTip text="The CBOE SKEW Index measures the perceived tail risk of the S&P 500, derived from OTM option prices. High SKEW (>145) = institutional demand for crash protection, even if VIX is low. SKEW-VIX divergence (high SKEW + low VIX) is historically the most dangerous setup — smart money hedging while the surface appears calm. Low SKEW (<120) = OTM puts are cheap for hedging." />
        </div>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${bg}`}>{level} Tail Risk</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 px-4 pt-3 pb-2">
        <div>
          <div className="text-[9px] font-mono text-text-muted">Current</div>
          <div className={`text-lg font-mono font-bold ${color}`}>{skew.current.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">Previous</div>
          <div className="text-sm font-mono font-semibold text-text-secondary">{skew.previous.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">Change</div>
          <div className={`text-sm font-mono font-semibold flex items-center gap-0.5 ${skew.change > 0 ? 'text-red-400' : 'text-green-400'}`}>
            {skew.change > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {skew.change > 0 ? '+' : ''}{skew.change.toFixed(2)} ({skew.changePercent >= 0 ? '+' : ''}{skew.changePercent.toFixed(1)}%)
          </div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-text-muted">As Of</div>
          <div className="text-sm font-mono font-semibold text-text-muted">{skew.date}</div>
        </div>
      </div>

      <div className="px-4 py-2">
        <div className="relative h-3 bg-bg-tertiary rounded-full overflow-hidden">
          <div className="absolute inset-0 flex">
            <div className="h-full bg-green-500/15" style={{ width: '35.7%' }} />
            <div className="h-full bg-amber-500/10" style={{ width: '21.4%' }} />
            <div className="h-full bg-amber-500/15" style={{ width: '14.3%' }} />
            <div className="h-full bg-red-500/15" style={{ width: '28.6%' }} />
          </div>
          <div className="absolute top-0 h-full w-1 bg-white/80 rounded-full" style={{ left: `${gaugePct}%` }} />
        </div>
        <div className="flex justify-between text-[8px] font-mono text-text-muted/50 mt-0.5">
          <span>100 (Low)</span><span>125</span><span>140</span><span>150</span><span>170 (Extreme)</span>
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border/20 text-xs font-mono text-text-secondary leading-relaxed space-y-1.5">
        <p>
          <strong className={color}>{level}:</strong>{' '}
          {skew.current > 150
            ? 'SKEW above 150 — extreme tail-risk pricing. Market makers charging large premiums for OTM puts. Historically, extreme SKEW precedes vol spikes within 2-6 weeks.'
            : skew.current > 140
            ? 'SKEW elevated — increased tail-risk premium. OTM puts are priced richer than calls. Consider long put spreads or portfolio hedges.'
            : skew.current > 125
            ? 'SKEW in normal range — balanced tail-risk pricing. No unusual demand for crash protection.'
            : 'SKEW unusually low — OTM puts are relatively cheap. Historically attractive entry for long-dated downside hedges.'}
        </p>
        {snapshot?.vix && (
          <p className="text-text-muted/60">
            {skew.current > 145 && snapshot.vix.price < 18
              ? `⚠ Divergence: SKEW (${skew.current.toFixed(0)}) signals tail-risk fear while VIX (${snapshot.vix.price.toFixed(1)}) shows complacency. Smart money may be quietly hedging — historically dangerous.`
              : skew.current < 125 && snapshot.vix.price > 25
              ? `VIX elevated (${snapshot.vix.price.toFixed(1)}) but SKEW low (${skew.current.toFixed(0)}). Broad-based fear, not tail-specific. Often resolves with VIX mean reversion.`
              : `VIX at ${snapshot.vix.price.toFixed(1)} with SKEW at ${skew.current.toFixed(0)} — ${skew.current > 140 && snapshot.vix.price > 20 ? 'both elevated, confirming risk-off' : 'aligned within normal parameters'}.`}
          </p>
        )}
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
            Loading options snapshot & computing volatility analytics...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Section 1: Overview — IV Gauge + Stats side by side */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <IVGauge />
        <div className="md:col-span-2">
          <IVStats />
        </div>
      </div>

      {/* Section 2: Volatility Risk Premium — the primary edge-finding chart */}
      <VRPChart />

      {/* Section 3: Volatility Surface + Vol Cone */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <VolSurface />
        <VolCone />
      </div>

      {/* Section 4: Term Structure + Skew */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TermStructureChart />
        <SkewChart />
      </div>

      {/* Section 5: Volatility Context */}
      <IVInterpretation />

      {/* Section 6: Market Vol Indices */}
      <VIXPanel />
      <SKEWPanel />

      {/* Footer */}
      {snapshot && (
        <div className="text-xs font-mono text-text-muted text-center py-2">
          Polygon snapshot: {snapshot.snapshotCount} contracts analyzed
          {snapshot.vix && ` | VIX: ${snapshot.vix.price.toFixed(2)}`}
          {snapshot.volCone && ` | Vol Cone: ${snapshot.volCone.length} windows`}
        </div>
      )}
    </div>
  );
}
