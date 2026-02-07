/**
 * Stock Universe for Screener
 *
 * ~175 liquid US equities and ETFs with active options markets.
 * Every name here typically trades >1,000 option contracts/day,
 * making PCR, GEX, and flow signals meaningful.
 */

export interface UniverseStock {
  symbol: string;
  name: string;
  sector: string;
}

export const STOCK_UNIVERSE: UniverseStock[] = [
  // ── Major Index & Broad Market ETFs ──
  { symbol: 'SPY', name: 'S&P 500 ETF', sector: 'ETF' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', sector: 'ETF' },
  { symbol: 'IWM', name: 'Russell 2000 ETF', sector: 'ETF' },
  { symbol: 'DIA', name: 'Dow Jones ETF', sector: 'ETF' },

  // ── Sector & Thematic ETFs (liquid options only) ──
  { symbol: 'XLF', name: 'Financial Select Sector', sector: 'ETF' },
  { symbol: 'XLE', name: 'Energy Select Sector', sector: 'ETF' },
  { symbol: 'XLK', name: 'Technology Select Sector', sector: 'ETF' },
  { symbol: 'XLV', name: 'Healthcare Select Sector', sector: 'ETF' },
  { symbol: 'XLI', name: 'Industrial Select Sector', sector: 'ETF' },
  { symbol: 'XLC', name: 'Communication Services', sector: 'ETF' },
  { symbol: 'XLU', name: 'Utilities Select Sector', sector: 'ETF' },
  { symbol: 'XLP', name: 'Consumer Staples Select', sector: 'ETF' },
  { symbol: 'XLY', name: 'Consumer Discretionary', sector: 'ETF' },
  { symbol: 'GLD', name: 'Gold ETF', sector: 'ETF' },
  { symbol: 'SLV', name: 'Silver ETF', sector: 'ETF' },
  { symbol: 'TLT', name: '20+ Year Treasury ETF', sector: 'ETF' },
  { symbol: 'HYG', name: 'High Yield Bond ETF', sector: 'ETF' },
  { symbol: 'EEM', name: 'Emerging Markets ETF', sector: 'ETF' },
  { symbol: 'SMH', name: 'Semiconductor ETF', sector: 'ETF' },
  { symbol: 'ARKK', name: 'ARK Innovation ETF', sector: 'ETF' },
  { symbol: 'KWEB', name: 'China Internet ETF', sector: 'ETF' },
  { symbol: 'XBI', name: 'SPDR Biotech ETF', sector: 'ETF' },
  { symbol: 'KRE', name: 'Regional Banking ETF', sector: 'ETF' },
  { symbol: 'FXI', name: 'China Large-Cap ETF', sector: 'ETF' },
  { symbol: 'EWZ', name: 'Brazil ETF', sector: 'ETF' },
  { symbol: 'GDX', name: 'Gold Miners ETF', sector: 'ETF' },
  { symbol: 'IBIT', name: 'iShares Bitcoin Trust', sector: 'ETF' },
  { symbol: 'USO', name: 'United States Oil Fund', sector: 'ETF' },

  // ── Mega Cap Tech ──
  { symbol: 'AAPL', name: 'Apple', sector: 'Technology' },
  { symbol: 'MSFT', name: 'Microsoft', sector: 'Technology' },
  { symbol: 'GOOGL', name: 'Alphabet', sector: 'Technology' },
  { symbol: 'AMZN', name: 'Amazon', sector: 'Technology' },
  { symbol: 'NVDA', name: 'NVIDIA', sector: 'Technology' },
  { symbol: 'META', name: 'Meta Platforms', sector: 'Technology' },
  { symbol: 'TSLA', name: 'Tesla', sector: 'Technology' },

  // ── Large Cap Tech (active options) ──
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
  { symbol: 'SMCI', name: 'Super Micro Computer', sector: 'Technology' },
  { symbol: 'DELL', name: 'Dell Technologies', sector: 'Technology' },
  { symbol: 'NET', name: 'Cloudflare', sector: 'Technology' },
  { symbol: 'DDOG', name: 'Datadog', sector: 'Technology' },
  { symbol: 'SNAP', name: 'Snap Inc', sector: 'Technology' },
  { symbol: 'PINS', name: 'Pinterest', sector: 'Technology' },
  { symbol: 'RBLX', name: 'Roblox', sector: 'Technology' },
  { symbol: 'TTD', name: 'The Trade Desk', sector: 'Technology' },
  { symbol: 'ROKU', name: 'Roku', sector: 'Technology' },
  { symbol: 'ABNB', name: 'Airbnb', sector: 'Technology' },
  { symbol: 'SPOT', name: 'Spotify', sector: 'Technology' },
  { symbol: 'SQ', name: 'Block (Square)', sector: 'Technology' },
  { symbol: 'COIN', name: 'Coinbase', sector: 'Technology' },
  { symbol: 'AFRM', name: 'Affirm Holdings', sector: 'Technology' },
  { symbol: 'HOOD', name: 'Robinhood Markets', sector: 'Technology' },
  { symbol: 'AI', name: 'C3.ai', sector: 'Technology' },
  { symbol: 'UPST', name: 'Upstart Holdings', sector: 'Technology' },
  { symbol: 'APP', name: 'AppLovin', sector: 'Technology' },
  { symbol: 'DKNG', name: 'DraftKings', sector: 'Technology' },
  { symbol: 'RDDT', name: 'Reddit', sector: 'Technology' },
  { symbol: 'BABA', name: 'Alibaba', sector: 'Technology' },
  { symbol: 'JD', name: 'JD.com', sector: 'Technology' },
  { symbol: 'PDD', name: 'PDD Holdings', sector: 'Technology' },
  { symbol: 'MSTR', name: 'MicroStrategy', sector: 'Technology' },
  { symbol: 'ACN', name: 'Accenture', sector: 'Technology' },
  { symbol: 'IBM', name: 'IBM', sector: 'Technology' },
  { symbol: 'INTU', name: 'Intuit', sector: 'Technology' },
  { symbol: 'LRCX', name: 'Lam Research', sector: 'Technology' },
  { symbol: 'KLAC', name: 'KLA Corporation', sector: 'Technology' },
  { symbol: 'ON', name: 'ON Semiconductor', sector: 'Technology' },
  { symbol: 'TXN', name: 'Texas Instruments', sector: 'Technology' },
  { symbol: 'FSLR', name: 'First Solar', sector: 'Technology' },
  { symbol: 'ENPH', name: 'Enphase Energy', sector: 'Technology' },
  { symbol: 'SE', name: 'Sea Limited', sector: 'Technology' },

  // ── Finance (liquid options) ──
  { symbol: 'JPM', name: 'JPMorgan Chase', sector: 'Finance' },
  { symbol: 'BAC', name: 'Bank of America', sector: 'Finance' },
  { symbol: 'WFC', name: 'Wells Fargo', sector: 'Finance' },
  { symbol: 'GS', name: 'Goldman Sachs', sector: 'Finance' },
  { symbol: 'MS', name: 'Morgan Stanley', sector: 'Finance' },
  { symbol: 'V', name: 'Visa', sector: 'Finance' },
  { symbol: 'MA', name: 'Mastercard', sector: 'Finance' },
  { symbol: 'C', name: 'Citigroup', sector: 'Finance' },
  { symbol: 'SCHW', name: 'Charles Schwab', sector: 'Finance' },
  { symbol: 'AXP', name: 'American Express', sector: 'Finance' },
  { symbol: 'PYPL', name: 'PayPal', sector: 'Finance' },
  { symbol: 'SOFI', name: 'SoFi Technologies', sector: 'Finance' },
  { symbol: 'COF', name: 'Capital One Financial', sector: 'Finance' },
  { symbol: 'DFS', name: 'Discover Financial', sector: 'Finance' },
  { symbol: 'BLK', name: 'BlackRock', sector: 'Finance' },
  { symbol: 'ICE', name: 'Intercontinental Exchange', sector: 'Finance' },
  { symbol: 'CME', name: 'CME Group', sector: 'Finance' },
  { symbol: 'MARA', name: 'Marathon Digital', sector: 'Finance' },
  { symbol: 'RIOT', name: 'Riot Platforms', sector: 'Finance' },
  { symbol: 'NU', name: 'Nu Holdings', sector: 'Finance' },

  // ── Healthcare (liquid options) ──
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
  { symbol: 'ISRG', name: 'Intuitive Surgical', sector: 'Healthcare' },
  { symbol: 'VRTX', name: 'Vertex Pharmaceuticals', sector: 'Healthcare' },
  { symbol: 'REGN', name: 'Regeneron', sector: 'Healthcare' },
  { symbol: 'CVS', name: 'CVS Health', sector: 'Healthcare' },
  { symbol: 'NVO', name: 'Novo Nordisk', sector: 'Healthcare' },
  { symbol: 'HIMS', name: 'Hims & Hers Health', sector: 'Healthcare' },
  { symbol: 'TMO', name: 'Thermo Fisher', sector: 'Healthcare' },
  { symbol: 'ABT', name: 'Abbott Labs', sector: 'Healthcare' },
  { symbol: 'DHR', name: 'Danaher', sector: 'Healthcare' },

  // ── Consumer (liquid options) ──
  { symbol: 'WMT', name: 'Walmart', sector: 'Consumer' },
  { symbol: 'COST', name: 'Costco', sector: 'Consumer' },
  { symbol: 'HD', name: 'Home Depot', sector: 'Consumer' },
  { symbol: 'MCD', name: 'McDonald\'s', sector: 'Consumer' },
  { symbol: 'NKE', name: 'Nike', sector: 'Consumer' },
  { symbol: 'SBUX', name: 'Starbucks', sector: 'Consumer' },
  { symbol: 'TGT', name: 'Target', sector: 'Consumer' },
  { symbol: 'LOW', name: 'Lowe\'s', sector: 'Consumer' },
  { symbol: 'PG', name: 'Procter & Gamble', sector: 'Consumer' },
  { symbol: 'KO', name: 'Coca-Cola', sector: 'Consumer' },
  { symbol: 'PEP', name: 'PepsiCo', sector: 'Consumer' },
  { symbol: 'DIS', name: 'Walt Disney', sector: 'Consumer' },
  { symbol: 'LULU', name: 'Lululemon', sector: 'Consumer' },
  { symbol: 'BKNG', name: 'Booking Holdings', sector: 'Consumer' },
  { symbol: 'CMG', name: 'Chipotle', sector: 'Consumer' },
  { symbol: 'TJX', name: 'TJX Companies', sector: 'Consumer' },
  { symbol: 'BBY', name: 'Best Buy', sector: 'Consumer' },
  { symbol: 'ETSY', name: 'Etsy', sector: 'Consumer' },
  { symbol: 'W', name: 'Wayfair', sector: 'Consumer' },
  { symbol: 'RCL', name: 'Royal Caribbean', sector: 'Consumer' },
  { symbol: 'CCL', name: 'Carnival Corporation', sector: 'Consumer' },
  { symbol: 'WYNN', name: 'Wynn Resorts', sector: 'Consumer' },
  { symbol: 'MGM', name: 'MGM Resorts', sector: 'Consumer' },
  { symbol: 'CVNA', name: 'Carvana', sector: 'Consumer' },
  { symbol: 'PM', name: 'Philip Morris', sector: 'Consumer' },
  { symbol: 'MO', name: 'Altria Group', sector: 'Consumer' },

  // ── Energy (liquid options) ──
  { symbol: 'XOM', name: 'ExxonMobil', sector: 'Energy' },
  { symbol: 'CVX', name: 'Chevron', sector: 'Energy' },
  { symbol: 'COP', name: 'ConocoPhillips', sector: 'Energy' },
  { symbol: 'SLB', name: 'Schlumberger', sector: 'Energy' },
  { symbol: 'OXY', name: 'Occidental Petroleum', sector: 'Energy' },
  { symbol: 'MPC', name: 'Marathon Petroleum', sector: 'Energy' },
  { symbol: 'DVN', name: 'Devon Energy', sector: 'Energy' },
  { symbol: 'FANG', name: 'Diamondback Energy', sector: 'Energy' },

  // ── Industrial (liquid options) ──
  { symbol: 'BA', name: 'Boeing', sector: 'Industrial' },
  { symbol: 'CAT', name: 'Caterpillar', sector: 'Industrial' },
  { symbol: 'GE', name: 'GE Aerospace', sector: 'Industrial' },
  { symbol: 'RTX', name: 'RTX Corporation', sector: 'Industrial' },
  { symbol: 'UPS', name: 'United Parcel Service', sector: 'Industrial' },
  { symbol: 'FDX', name: 'FedEx', sector: 'Industrial' },
  { symbol: 'DE', name: 'Deere & Company', sector: 'Industrial' },
  { symbol: 'LMT', name: 'Lockheed Martin', sector: 'Industrial' },
  { symbol: 'HON', name: 'Honeywell', sector: 'Industrial' },
  { symbol: 'DAL', name: 'Delta Air Lines', sector: 'Industrial' },
  { symbol: 'UAL', name: 'United Airlines', sector: 'Industrial' },
  { symbol: 'AAL', name: 'American Airlines', sector: 'Industrial' },

  // ── Telecom / Media ──
  { symbol: 'T', name: 'AT&T', sector: 'Telecom' },
  { symbol: 'VZ', name: 'Verizon', sector: 'Telecom' },
  { symbol: 'CMCSA', name: 'Comcast', sector: 'Telecom' },
  { symbol: 'TMUS', name: 'T-Mobile', sector: 'Telecom' },

  // ── Materials (liquid options) ──
  { symbol: 'FCX', name: 'Freeport-McMoRan', sector: 'Materials' },
  { symbol: 'NEM', name: 'Newmont', sector: 'Materials' },
  { symbol: 'CLF', name: 'Cleveland-Cliffs', sector: 'Materials' },

  // ── Utilities (liquid options) ──
  { symbol: 'NEE', name: 'NextEra Energy', sector: 'Utilities' },
  { symbol: 'CEG', name: 'Constellation Energy', sector: 'Utilities' },
  { symbol: 'VST', name: 'Vistra', sector: 'Utilities' },

  // ── Automotive ──
  { symbol: 'F', name: 'Ford Motor', sector: 'Automotive' },
  { symbol: 'GM', name: 'General Motors', sector: 'Automotive' },
  { symbol: 'RIVN', name: 'Rivian', sector: 'Automotive' },
  { symbol: 'LCID', name: 'Lucid Group', sector: 'Automotive' },

  // ── High Vol / Meme (very active options) ──
  { symbol: 'GME', name: 'GameStop', sector: 'Retail' },
  { symbol: 'AMC', name: 'AMC Entertainment', sector: 'Entertainment' },
];

/** Get symbols only */
export function getUniverseSymbols(): string[] {
  return STOCK_UNIVERSE.map(s => s.symbol);
}

/** Lookup stock metadata */
export function getStockMeta(symbol: string): UniverseStock | undefined {
  return STOCK_UNIVERSE.find(s => s.symbol === symbol.toUpperCase());
}
