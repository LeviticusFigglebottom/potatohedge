'use client';

import { useDashboardStore, type TabId } from '@/hooks/useDashboardStore';
import { LayoutDashboard, TableProperties, Shield, Activity } from 'lucide-react';

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'dealer', label: 'Dealer Positioning', icon: Shield },
  { id: 'volatility', label: 'Volatility', icon: Activity },
  { id: 'chain', label: 'Options Chain', icon: TableProperties },
];

export default function TabNav() {
  const { activeTab, setActiveTab } = useDashboardStore();

  return (
    <nav className="flex items-center gap-1 border-b border-border px-1 overflow-x-auto scrollbar-none">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => setActiveTab(id)}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-all border-b-2 -mb-px ${
            activeTab === id
              ? 'border-accent-cyan text-accent-cyan'
              : 'border-transparent text-text-muted hover:text-text-secondary hover:border-border'
          }`}
        >
          <Icon className="w-4 h-4" />
          {label}
        </button>
      ))}
    </nav>
  );
}
