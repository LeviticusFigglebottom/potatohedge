'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatCurrency, formatNumber, formatIV, formatDelta } from '@/lib/utils/format';

export default function OptionsChainTable() {
  const { chain, expirations, selectedExpiration, setSelectedExpiration, loading, symbol } = useDashboardStore();

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header flex-wrap gap-2">
        <span className="panel-title">Options Chain — {symbol}</span>
        
        {/* Expiration selector */}
        <div className="flex items-center gap-1 overflow-x-auto max-w-lg scrollbar-none">
          {expirations.slice(0, 8).map((exp) => (
            <button
              key={exp.date}
              onClick={() => setSelectedExpiration(exp.date)}
              className={`px-2 py-1 rounded text-xs font-mono whitespace-nowrap transition-all ${
                selectedExpiration === exp.date
                  ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                  : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {exp.date.slice(5)} <span className="text-text-muted">({exp.dte}d)</span>
            </button>
          ))}
          {expirations.length > 8 && (
            <select
              value={selectedExpiration || ''}
              onChange={(e) => setSelectedExpiration(e.target.value)}
              className="input text-xs py-1 px-2 font-mono"
            >
              {expirations.map((exp) => (
                <option key={exp.date} value={exp.date}>
                  {exp.date} ({exp.dte}d)
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading.chain && !chain ? (
          <div className="p-8 flex items-center justify-center">
            <div className="flex items-center gap-2 text-text-muted text-sm font-mono">
              <div className="w-4 h-4 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
              Loading chain...
            </div>
          </div>
        ) : !chain ? (
          <div className="p-8 text-center text-text-muted text-sm font-mono">
            Select an expiration to view the options chain
          </div>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 z-10 bg-bg-secondary">
              <tr className="text-text-muted border-b border-border">
                {/* Calls side */}
                <th className="px-2 py-2 text-right">Vol</th>
                <th className="px-2 py-2 text-right">OI</th>
                <th className="px-2 py-2 text-right">IV</th>
                <th className="px-2 py-2 text-right">Δ</th>
                <th className="px-2 py-2 text-right">Bid</th>
                <th className="px-2 py-2 text-right">Ask</th>
                <th className="px-2 py-2 text-right text-accent-green">Last</th>
                {/* Strike */}
                <th className="px-3 py-2 text-center bg-bg-tertiary text-accent-cyan">Strike</th>
                {/* Puts side */}
                <th className="px-2 py-2 text-left text-accent-red">Last</th>
                <th className="px-2 py-2 text-left">Bid</th>
                <th className="px-2 py-2 text-left">Ask</th>
                <th className="px-2 py-2 text-left">Δ</th>
                <th className="px-2 py-2 text-left">IV</th>
                <th className="px-2 py-2 text-left">OI</th>
                <th className="px-2 py-2 text-left">Vol</th>
              </tr>
            </thead>
            <tbody>
              {chain.calls.map((call, i) => {
                const put = chain.puts.find(p => p.strike === call.strike);
                const isATM = Math.abs(call.strike - chain.underlyingPrice) ===
                  Math.min(...chain.calls.map(c => Math.abs(c.strike - chain.underlyingPrice)));

                return (
                  <tr
                    key={call.strike}
                    className={`border-b border-border/30 hover:bg-bg-hover/50 transition-colors ${
                      isATM ? 'bg-accent-cyan/[0.06] border-accent-cyan/20' : ''
                    } ${call.inTheMoney ? 'itm-row' : ''}`}
                  >
                    {/* Call side */}
                    <td className="px-2 py-1.5 text-right">
                      <span className={call.volume > 0 ? 'text-text-primary' : 'text-text-muted'}>
                        {call.volume > 0 ? formatNumber(call.volume, 0) : '—'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-text-secondary">
                      {formatNumber(call.openInterest, 0)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-accent-purple">
                      {call.impliedVolatility > 0 ? formatIV(call.impliedVolatility) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right text-text-secondary">
                      {formatDelta(call.delta)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-text-secondary">
                      {call.bid > 0 ? formatCurrency(call.bid) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right text-text-secondary">
                      {call.ask > 0 ? formatCurrency(call.ask) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium text-accent-green">
                      {call.last > 0 ? formatCurrency(call.last) : '—'}
                    </td>

                    {/* Strike */}
                    <td className={`px-3 py-1.5 text-center font-semibold bg-bg-tertiary/50 ${
                      isATM ? 'text-accent-cyan' : 'text-text-primary'
                    }`}>
                      {formatCurrency(call.strike)}
                      {isATM && <span className="ml-1 text-[9px] text-accent-cyan">ATM</span>}
                    </td>

                    {/* Put side */}
                    <td className="px-2 py-1.5 text-left font-medium text-accent-red">
                      {put?.last && put.last > 0 ? formatCurrency(put.last) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-left text-text-secondary">
                      {put?.bid && put.bid > 0 ? formatCurrency(put.bid) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-left text-text-secondary">
                      {put?.ask && put.ask > 0 ? formatCurrency(put.ask) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-left text-text-secondary">
                      {put ? formatDelta(put.delta) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-left text-accent-purple">
                      {put?.impliedVolatility && put.impliedVolatility > 0 ? formatIV(put.impliedVolatility) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-left text-text-secondary">
                      {put ? formatNumber(put.openInterest, 0) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-left">
                      <span className={put?.volume && put.volume > 0 ? 'text-text-primary' : 'text-text-muted'}>
                        {put?.volume && put.volume > 0 ? formatNumber(put.volume, 0) : '—'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
