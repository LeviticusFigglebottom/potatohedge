'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';

export default function GEXChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { analytics, loading, symbol } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !analytics?.gex?.exposures) return;

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

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 20, right: 60, bottom: 40, left: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Clear
    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, width, height);

    const exposures = analytics.gex.exposures.filter(e => Math.abs(e.netGEX) > 0);
    if (exposures.length === 0) return;

    // Find range - focus on strikes near spot
    const spot = analytics.gex.spotPrice;
    const nearSpot = exposures.filter(e => 
      e.strike >= spot * 0.92 && e.strike <= spot * 1.08
    );
    const data = nearSpot.length > 5 ? nearSpot : exposures;

    const maxAbs = Math.max(...data.map(e => Math.abs(e.netGEX)));
    const minStrike = data[0].strike;
    const maxStrike = data[data.length - 1].strike;
    const barWidth = Math.max(2, (chartWidth / data.length) - 2);

    // Draw bars
    data.forEach((e, i) => {
      const x = padding.left + (i / data.length) * chartWidth;
      const normalized = e.netGEX / maxAbs;
      const barHeight = Math.abs(normalized) * (chartHeight / 2);
      const y = e.netGEX >= 0
        ? padding.top + chartHeight / 2 - barHeight
        : padding.top + chartHeight / 2;

      // Color: positive = green (long gamma), negative = red (short gamma)
      if (e.netGEX >= 0) {
        ctx.fillStyle = '#00e67640';
        ctx.strokeStyle = '#00e67680';
      } else {
        ctx.fillStyle = '#ff3d5740';
        ctx.strokeStyle = '#ff3d5780';
      }

      ctx.fillRect(x, y, barWidth, barHeight);
      ctx.strokeRect(x, y, barWidth, barHeight);
    });

    // Zero line
    ctx.strokeStyle = '#8888a030';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + chartHeight / 2);
    ctx.lineTo(width - padding.right, padding.top + chartHeight / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Spot price line
    if (spot >= minStrike && spot <= maxStrike) {
      const spotX = padding.left + ((spot - minStrike) / (maxStrike - minStrike)) * chartWidth;
      ctx.strokeStyle = '#00d4ff60';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(spotX, padding.top);
      ctx.lineTo(spotX, height - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Spot label
      ctx.fillStyle = '#00d4ff';
      ctx.font = '10px "JetBrains Mono"';
      ctx.textAlign = 'center';
      ctx.fillText(`SPOT $${spot.toFixed(0)}`, spotX, padding.top - 5);
    }

    // Gamma flip line
    const gammaFlip = analytics.gex.gammaFlip;
    if (gammaFlip && gammaFlip >= minStrike && gammaFlip <= maxStrike) {
      const flipX = padding.left + ((gammaFlip - minStrike) / (maxStrike - minStrike)) * chartWidth;
      ctx.strokeStyle = '#ffaa0080';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(flipX, padding.top);
      ctx.lineTo(flipX, height - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffaa00';
      ctx.font = '10px "JetBrains Mono"';
      ctx.textAlign = 'center';
      ctx.fillText(`γ FLIP $${gammaFlip.toFixed(0)}`, flipX, height - padding.bottom + 15);
    }

    // Axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    ctx.fillText(`+${formatNumber(maxAbs)}`, width - 5, padding.top + 12);
    ctx.fillText(`-${formatNumber(maxAbs)}`, width - 5, height - padding.bottom - 5);

    // Strike labels (every Nth)
    ctx.textAlign = 'center';
    const labelEvery = Math.max(1, Math.floor(data.length / 8));
    data.forEach((e, i) => {
      if (i % labelEvery === 0) {
        const x = padding.left + (i / data.length) * chartWidth + barWidth / 2;
        ctx.fillStyle = '#555570';
        ctx.fillText(`$${e.strike}`, x, height - padding.bottom + 25);
      }
    });

  }, [analytics]);

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">Gamma Exposure (GEX) — {symbol}</span>
        {analytics?.gex && (
          <span className={`badge ${analytics.gex.totalGEX >= 0 ? 'badge-green' : 'badge-red'}`}>
            Net: {analytics.gex.totalGEX >= 0 ? '+' : ''}{formatNumber(analytics.gex.totalGEX)}
          </span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-[250px] relative">
        {loading.analytics && !analytics ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 text-text-muted text-sm font-mono">
              <div className="w-4 h-4 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
              Computing GEX...
            </div>
          </div>
        ) : !analytics?.gex ? (
          <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm font-mono">
            Load options chain to compute GEX
          </div>
        ) : (
          <canvas ref={canvasRef} className="w-full h-full" />
        )}
      </div>

      {/* Key levels */}
      {analytics?.gex && (
        <div className="px-4 py-2 border-t border-border flex flex-wrap gap-4 text-xs font-mono">
          {analytics.gex.gammaFlip !== null && (
            <div>
              <span className="text-text-muted">γ Flip: </span>
              <span className="text-accent-amber font-medium">{formatCurrency(analytics.gex.gammaFlip)}</span>
            </div>
          )}
          {analytics.gex.callWall !== null && (
            <div>
              <span className="text-text-muted">Call Wall: </span>
              <span className="text-accent-green font-medium">{formatCurrency(analytics.gex.callWall)}</span>
            </div>
          )}
          {analytics.gex.putWall !== null && (
            <div>
              <span className="text-text-muted">Put Wall: </span>
              <span className="text-accent-red font-medium">{formatCurrency(analytics.gex.putWall)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
