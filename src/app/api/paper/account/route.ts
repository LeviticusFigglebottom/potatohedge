import { NextResponse } from 'next/server';
import { getBalances, getPositions, getGainLoss, parseOCCSymbol } from '@/lib/providers/tradierPaper';

/**
 * GET /api/paper/account — Full paper trading account snapshot:
 * balances, open positions (with parsed symbols), and recent gain/loss history.
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

    // Enrich positions with parsed OCC data
    const enrichedPositions = positions.map(p => {
      const parsed = parseOCCSymbol(p.symbol);
      return {
        ...p,
        parsed,
        costPerContract: p.quantity !== 0 ? p.cost_basis / (Math.abs(p.quantity) * 100) : 0,
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
