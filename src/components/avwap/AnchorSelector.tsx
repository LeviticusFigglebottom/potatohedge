'use client';

import { useState } from 'react';
import type { AnchorDef } from './AVWAPTab';

const ANCHOR_COLORS = ['#2196F3', '#FF9800', '#4CAF50', '#E91E63', '#9C27B0'];

interface Props {
  availableAnchors: { date: string; label: string; type: string }[];
  anchors: AnchorDef[];
  onAnchorsChange: (anchors: AnchorDef[]) => void;
}

export default function AnchorSelector({ availableAnchors, anchors, onAnchorsChange }: Props) {
  const [customDate, setCustomDate] = useState('');

  const addAnchor = (anchorDef: { date: string; label: string; type: string }) => {
    if (anchors.length >= 5) return;
    if (anchors.find(a => a.date === anchorDef.date)) return;
    const color = ANCHOR_COLORS[anchors.length % ANCHOR_COLORS.length];
    onAnchorsChange([...anchors, { ...anchorDef, color }]);
  };

  const removeAnchor = (date: string) => {
    onAnchorsChange(anchors.filter(a => a.date !== date));
  };

  const addCustom = () => {
    if (!customDate) return;
    addAnchor({ date: customDate, label: `Custom ${customDate}`, type: 'custom' });
    setCustomDate('');
  };

  return (
    <div className="bg-surface rounded-xl border border-border p-3">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
        Anchor Points ({anchors.length}/5)
      </div>

      {/* Active anchors */}
      <div className="flex flex-wrap gap-2 mb-3">
        {anchors.map(anchor => (
          <span
            key={anchor.date}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
            style={{ borderColor: anchor.color, color: anchor.color }}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: anchor.color }} />
            {anchor.label}
            <button
              onClick={() => removeAnchor(anchor.date)}
              className="ml-1 hover:text-white transition-colors"
            >
              &times;
            </button>
          </span>
        ))}
        {anchors.length === 0 && (
          <span className="text-text-muted text-xs">No anchors selected &mdash; add from presets below</span>
        )}
      </div>

      {/* Preset anchors */}
      {availableAnchors.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {availableAnchors.map(anchor => {
            const isActive = anchors.find(a => a.date === anchor.date);
            return (
              <button
                key={`${anchor.type}-${anchor.date}`}
                onClick={() => (isActive ? removeAnchor(anchor.date) : addAnchor(anchor))}
                disabled={anchors.length >= 5 && !isActive}
                className={`px-2.5 py-1 rounded text-xs border transition-colors ${
                  isActive
                    ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
                    : 'border-border text-text-muted hover:border-text-muted hover:text-text-secondary'
                } disabled:opacity-40`}
              >
                {anchor.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Custom date input */}
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={customDate}
          onChange={e => setCustomDate(e.target.value)}
          className="bg-bg-primary border border-border rounded px-2 py-1 text-xs text-text-secondary focus:border-accent-cyan focus:outline-none"
        />
        <button
          onClick={addCustom}
          disabled={!customDate || anchors.length >= 5}
          className="px-3 py-1 bg-surface hover:bg-border border border-border rounded text-xs text-text-secondary disabled:opacity-40 transition-colors"
        >
          + Custom
        </button>
      </div>
    </div>
  );
}
