'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import { Brain, ChevronRight, Shield, Activity, BarChart3 } from 'lucide-react';

export default function InterpretationsPanel() {
  const { multiGEX, snapshot, loading } = useDashboardStore();

  if ((loading.multiGEX || loading.snapshot) && !multiGEX && !snapshot) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title flex items-center gap-2">
            <Brain className="w-3.5 h-3.5 text-accent-purple" />
            Market Context
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

  const sections: { icon: React.ElementType; color: string; text: string }[] = [];

  if (multiGEX?.context?.dealer?.interpretation) {
    sections.push({ icon: Shield, color: 'text-accent-cyan', text: multiGEX.context.dealer.interpretation });
  }
  if (multiGEX?.context?.volume?.interpretation && multiGEX.context.volume.interpretation !== 'Volume within normal ranges.') {
    sections.push({ icon: BarChart3, color: 'text-accent-green', text: multiGEX.context.volume.interpretation });
  }
  if (multiGEX?.context?.skew?.interpretation) {
    sections.push({ icon: Activity, color: 'text-accent-purple', text: multiGEX.context.skew.interpretation });
  }
  if (snapshot?.iv?.interpretation) {
    sections.push({ icon: Activity, color: 'text-accent-amber', text: snapshot.iv.interpretation });
  }
  if (multiGEX?.context?.oi?.interpretation && multiGEX.context.oi.interpretation !== 'OI well-distributed across strikes.') {
    sections.push({ icon: BarChart3, color: 'text-accent-red', text: multiGEX.context.oi.interpretation });
  }

  if (sections.length === 0) return null;

  return (
    <div className="panel animate-slide-up">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-accent-purple" />
          Market Context
        </span>
        <span className="badge badge-cyan">Multi-exp analysis</span>
      </div>
      <div className="divide-y divide-border/20">
        {sections.map((s, i) => (
          <div key={i} className="px-4 py-2.5 flex items-start gap-2">
            <s.icon className={`w-3.5 h-3.5 ${s.color} mt-0.5 shrink-0`} />
            <span className="text-sm text-text-secondary leading-relaxed">{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
