/**
 * Stock Universe for Screener
 *
 * Curated list of ~100 most actively traded US equities and ETFs,
 * sorted roughly by market cap / options liquidity.
 * These are the stocks with the deepest options markets — GEX/DEX
 * signals are most reliable where open interest and volume are highest.
 */

export interface UniverseStock {
  symbol: string;
  name: string;
  sector: string;
}

export const STOCK_UNIVERSE: UniverseStock[] = [
  // ── Major ETFs ──
  { symbol: 'SPY', name: 'S&P 500 ETF', sector: 'ETF' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', sector: 'ETF' },
  { symbol: 'IWM', name: 'Russell 2000 ETF', sector: 'ETF' },
  { symbol: 'DIA', name: 'Dow Jones ETF', sector: 'ETF' },
  { symbol: 'XLF', name: 'Financial Select Sector', sector: 'ETF' },
  { symbol: 'XLE', name: 'Energy Select Sector', sector: 'ETF' },
  { symbol: 'XLK', name: 'Technology Select Sector', sector: 'ETF' },
  { symbol: 'GLD', name: 'Gold ETF', sector: 'ETF' },
  { symbol: 'TLT', name: '20+ Year Treasury ETF', sector: 'ETF' },
  { symbol: 'HYG', name: 'High Yield Corporate Bond ETF', sector: 'ETF' },
  { symbol: 'EEM', name: 'Emerging Markets ETF', sector: 'ETF' },
  { symbol: 'SLV', name: 'Silver ETF', sector: 'ETF' },

  // ── Mega Cap Tech ──
  { symbol: 'AAPL', name: 'Apple', sector: 'Technology' },
  { symbol: 'MSFT', name: 'Microsoft', sector: 'Technology' },
  { symbol: 'GOOGL', name: 'Alphabet', sector: 'Technology' },
  { symbol: 'AMZN', name: 'Amazon', sector: 'Technology' },
  { symbol: 'NVDA', name: 'NVIDIA', sector: 'Technology' },
  { symbol: 'META', name: 'Meta Platforms', sector: 'Technology' },
  { symbol: 'TSLA', name: 'Tesla', sector: 'Technology' },
  { symbol: 'AVGO', name: 'Broadcom', sector: 'Technology' },
  { symbol: 'ORCL', name: 'Oracle', sector: 'Technology' },
  { symbol: 'CRM', name: 'Salesforce', sector: 'Technology' },
  { symbol: 'AMD', name: 'AMD', sector: 'Technology' },
  { symbol: 'INTC', name: 'Intel', sector: 'Technology' },
  { symbol: 'ADBE', name: 'Adobe', sector: 'Technology' },
  { symbol: 'NFLX', name: 'Netflix', sector: 'Technology' },
  { symbol: 'CSCO', name: 'Cisco', sector: 'Technology' },
  { symbol: 'QCOM', name: 'Qualcomm', sector: 'Technology' },
  { symbol: 'AMAT', name: 'Applied Materials', sector: 'Technology' },
  { symbol: 'MU', name: 'Micron', sector: 'Technology' },
  { symbol: 'NOW', name: 'ServiceNow', sector: 'Technology' },
  { symbol: 'UBER', name: 'Uber Technologies', sector: 'Technology' },
  { symbol: 'SHOP', name: 'Shopify', sector: 'Technology' },
  { symbol: 'SNOW', name: 'Snowflake', sector: 'Technology' },
  { symbol: 'PLTR', name: 'Palantir', sector: 'Technology' },
  { symbol: 'ARM', name: 'ARM Holdings', sector: 'Technology' },
  { symbol: 'MRVL', name: 'Marvell Technology', sector: 'Technology' },
  { symbol: 'PANW', name: 'Palo Alto Networks', sector: 'Technology' },
  { symbol: 'CRWD', name: 'CrowdStrike', sector: 'Technology' },

  // ── Finance ──
  { symbol: 'JPM', name: 'JPMorgan Chase', sector: 'Finance' },
  { symbol: 'BAC', name: 'Bank of America', sector: 'Finance' },
  { symbol: 'WFC', name: 'Wells Fargo', sector: 'Finance' },
  { symbol: 'GS', name: 'Goldman Sachs', sector: 'Finance' },
  { symbol: 'MS', name: 'Morgan Stanley', sector: 'Finance' },
  { symbol: 'V', name: 'Visa', sector: 'Finance' },
  { symbol: 'MA', name: 'Mastercard', sector: 'Finance' },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Finance' },
  { symbol: 'C', name: 'Citigroup', sector: 'Finance' },
  { symbol: 'SCHW', name: 'Charles Schwab', sector: 'Finance' },
  { symbol: 'AXP', name: 'American Express', sector: 'Finance' },
  { symbol: 'PYPL', name: 'PayPal', sector: 'Finance' },
  { symbol: 'SQ', name: 'Block (Square)', sector: 'Finance' },
  { symbol: 'COIN', name: 'Coinbase', sector: 'Finance' },

  // ── Healthcare ──
  { symbol: 'UNH', name: 'UnitedHealth', sector: 'Healthcare' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare' },
  { symbol: 'LLY', name: 'Eli Lilly', sector: 'Healthcare' },
  { symbol: 'PFE', name: 'Pfizer', sector: 'Healthcare' },
  { symbol: 'ABBV', name: 'AbbVie', sector: 'Healthcare' },
  { symbol: 'MRK', name: 'Merck', sector: 'Healthcare' },
  { symbol: 'BMY', name: 'Bristol-Myers Squibb', sector: 'Healthcare' },
  { symbol: 'AMGN', name: 'Amgen', sector: 'Healthcare' },
  { symbol: 'GILD', name: 'Gilead Sciences', sector: 'Healthcare' },
  { symbol: 'MRNA', name: 'Moderna', sector: 'Healthcare' },

  // ── Consumer ──
  { symbol: 'WMT', name: 'Walmart', sector: 'Consumer' },
  { symbol: 'COST', name: 'Costco', sector: 'Consumer' },
  { symbol: 'HD', name: 'Home Depot', sector: 'Consumer' },
  { symbol: 'MCD', name: "McDonald's", sector: 'Consumer' },
  { symbol: 'NKE', name: 'Nike', sector: 'Consumer' },
  { symbol: 'SBUX', name: 'Starbucks', sector: 'Consumer' },
  { symbol: 'TGT', name: 'Target', sector: 'Consumer' },
  { symbol: 'LOW', name: "Lowe's", sector: 'Consumer' },
  { symbol: 'PG', name: 'Procter & Gamble', sector: 'Consumer' },
  { symbol: 'KO', name: 'Coca-Cola', sector: 'Consumer' },
  { symbol: 'PEP', name: 'PepsiCo', sector: 'Consumer' },
  { symbol: 'DIS', name: 'Walt Disney', sector: 'Consumer' },

  // ── Energy ──
  { symbol: 'XOM', name: 'ExxonMobil', sector: 'Energy' },
  { symbol: 'CVX', name: 'Chevron', sector: 'Energy' },
  { symbol: 'COP', name: 'ConocoPhillips', sector: 'Energy' },
  { symbol: 'SLB', name: 'Schlumberger', sector: 'Energy' },
  { symbol: 'OXY', name: 'Occidental Petroleum', sector: 'Energy' },

  // ── Industrial / Other ──
  { symbol: 'BA', name: 'Boeing', sector: 'Industrial' },
  { symbol: 'CAT', name: 'Caterpillar', sector: 'Industrial' },
  { symbol: 'GE', name: 'GE Aerospace', sector: 'Industrial' },
  { symbol: 'RTX', name: 'RTX Corporation', sector: 'Industrial' },
  { symbol: 'UPS', name: 'United Parcel Service', sector: 'Industrial' },
  { symbol: 'FDX', name: 'FedEx', sector: 'Industrial' },
  { symbol: 'DE', name: 'Deere & Company', sector: 'Industrial' },
  { symbol: 'LMT', name: 'Lockheed Martin', sector: 'Industrial' },
  { symbol: 'HON', name: 'Honeywell', sector: 'Industrial' },

  // ── Telecom / Media ──
  { symbol: 'T', name: 'AT&T', sector: 'Telecom' },
  { symbol: 'VZ', name: 'Verizon', sector: 'Telecom' },
  { symbol: 'CMCSA', name: 'Comcast', sector: 'Telecom' },
  { symbol: 'TMUS', name: 'T-Mobile', sector: 'Telecom' },

  // ── Meme / High Vol ──
  { symbol: 'GME', name: 'GameStop', sector: 'Retail' },
  { symbol: 'AMC', name: 'AMC Entertainment', sector: 'Entertainment' },
  { symbol: 'RIVN', name: 'Rivian', sector: 'Automotive' },
  { symbol: 'LCID', name: 'Lucid Group', sector: 'Automotive' },
  { symbol: 'SOFI', name: 'SoFi Technologies', sector: 'Finance' },
  { symbol: 'SMCI', name: 'Super Micro Computer', sector: 'Technology' },
];

/** Get symbols only */
export function getUniverseSymbols(): string[] {
  return STOCK_UNIVERSE.map(s => s.symbol);
}

/** Lookup stock metadata */
export function getStockMeta(symbol: string): UniverseStock | undefined {
  return STOCK_UNIVERSE.find(s => s.symbol === symbol.toUpperCase());
}
