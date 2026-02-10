import { NextResponse } from 'next/server';
import { getBalances, getPositions, getGainLoss, getOptionQuotes, parseOCCSymbol } from '@/lib/providers/tradierPaper';

/**
 * GET /api/paper/account — Full paper trading account snapshot:
 * balances, open positions (with parsed symbols + live quotes), and recent gain/loss history.
 */
export async function GET() {
  if (!process.env.TRADIER_SANDBOX_KEY) {
    return NextResponse.json({ error: 'Paper trading not configured — set TRADIER_SANDBOX_KEY' }, { status: 501 });
  }

  try {
    const [balances, positions, history] = await Promise.all([
      getBalances(),
      getPositions(),
      getGainLoss(30),
    ]);

    // Batch-fetch live quotes for all position symbols
    const optionSymbols = positions
      .map(p => p.symbol)
      .filter(s => /^[A-Z]+\d{6}[CP]\d{8}$/.test(s));
    const liveQuotes = optionSymbols.length > 0
      ? await getOptionQuotes(optionSymbols).catch(() => new Map())
      : new Map();

    // Enrich positions with parsed OCC data + live prices
    const enrichedPositions = positions.map(p => {
      const parsed = parseOCCSymbol(p.symbol);
      const quote = liveQuotes.get(p.symbol);
      const costPerContract = p.quantity !== 0 ? p.cost_basis / (Math.abs(p.quantity) * 100) : 0;
      const currentPrice = quote?.last ?? 0;
      const currentValue = currentPrice * Math.abs(p.quantity) * 100;
      const unrealizedPL = p.quantity > 0
        ? currentValue - p.cost_basis
        : p.cost_basis - currentValue; // short positions invert
      const unrealizedPLPct = p.cost_basis !== 0 ? (unrealizedPL / Math.abs(p.cost_basis)) * 100 : 0;

      return {
        ...p,
        parsed,
        costPerContract,
        currentPrice,
        currentValue,
        unrealizedPL,
        unrealizedPLPct,
        bid: quote?.bid ?? 0,
        ask: quote?.ask ?? 0,
      };
    });

    // Enrich history with parsed symbols
    const enrichedHistory = history.map(h => {
      const parsed = parseOCCSymbol(h.symbol);
      return { ...h, parsed };
    });

    return NextResponse.json({
      balances,
      positions: enrichedPositions,
      history: enrichedHistory,
    }, {
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
