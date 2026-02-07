'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import { Brain, ChevronRight } from 'lucide-react';

export default function InterpretationsPanel() {
  const { analytics, loading } = useDashboardStore();

  if (loading.analytics && !analytics) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title flex items-center gap-2">
            <Brain className="w-3.5 h-3.5 text-accent-purple" />
            Market Interpretation
          </span>
        </div>
        <div className="panel-body space-y-2">
          <div className="skeleton w-full h-4" />
          <div className="skeleton w-3/4 h-4" />
          <div className="skeleton w-5/6 h-4" />
        </div>
      </div>
    );
  }

  if (!analytics?.interpretations?.length) return null;

  return (
    <div className="panel animate-slide-up">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-accent-purple" />
          Market Interpretation
        </span>
        <span className="badge badge-cyan">Auto-generated</span>
      </div>
      <div className="panel-body space-y-2">
        {analytics.interpretations.map((interp, i) => (
          <div
            key={i}
            className="flex items-start gap-2 text-sm text-text-secondary leading-relaxed"
          >
            <ChevronRight className="w-3.5 h-3.5 text-accent-purple mt-1 shrink-0" />
            <span>{interp}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
