# Optix — Self-Hosted Options Analytics Dashboard

A comprehensive, self-hosted market data aggregation and options analytics platform. Search any ticker and get real-time price charts, full options chains, dealer positioning (GEX/DEX/Vanna/Charm), PCR, max pain, and auto-generated market interpretations.

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/options-dashboard.git
cd options-dashboard
npm install
```

### 2. Configure API keys

Copy the example env file and add your Tradier API key:

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:
```
TRADIER_API_KEY=your_key_here
TRADIER_SANDBOX=false
```

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Deploy to Vercel

```bash
npx vercel
# Add TRADIER_API_KEY as an environment variable in Vercel dashboard
```

Or connect your GitHub repo → Vercel will auto-deploy on push.

> **Important:** Add `TRADIER_API_KEY` in Vercel → Settings → Environment Variables.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Next.js Frontend                       │
│  ┌─────────┐ ┌──────────┐ ┌──────┐ ┌────────────────┐  │
│  │ TV Light │ │ Options  │ │ GEX  │ │ Analytics Cards│  │
│  │ Charts   │ │ Chain    │ │Chart │ │ & Interp Panel │  │
│  └─────────┘ └──────────┘ └──────┘ └────────────────┘  │
│                         │                                 │
│              Zustand State Management                     │
│                         │                                 │
│              Next.js API Routes (Proxy)                   │
│  ┌──────────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ /quote   │ │/history│ │ /chain   │ │ /greeks     │  │
│  └──────────┘ └────────┘ └──────────┘ └─────────────┘  │
└─────────────┬───────────────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    │   Data Providers    │
    │  ┌──────────────┐   │
    │  │   Tradier     │   │  ← Real-time chains + Greeks
    │  │  (+ Polygon)  │   │  ← Streaming quotes + history
    │  └──────────────┘   │
    └─────────────────────┘
              │
    ┌─────────┴──────────┐
    │   Math Engine (TS)  │
    │  Black-Scholes      │
    │  GEX / DEX / Vanna  │
    │  Charm / Max Pain   │
    │  IV Solver / PCR    │
    └─────────────────────┘
```

## Features

### Phase 1 (Current - MVP)
- [x] Real-time price charts (TradingView Lightweight Charts)
- [x] Multi-timeframe: 1m, 5m, 15m, daily, weekly, monthly
- [x] Full options chain with Greeks, IV, bid/ask
- [x] ITM highlighting, ATM identification
- [x] Put/Call Ratio (volume + OI based)
- [x] Max Pain calculation with distribution
- [x] GEX profile chart with key levels
- [x] Gamma Flip Point detection
- [x] Call Wall / Put Wall identification
- [x] Delta Exposure (DEX)
- [x] Vanna & Charm exposure computation
- [x] Auto-generated market interpretation
- [x] Dark terminal UI theme
- [x] Responsive layout
- [x] Ticker search with popular quick-picks

### Phase 2 (Planned)
- [ ] Polygon.io integration for WebSocket streaming
- [ ] IV Rank & IV Percentile (historical IV tracking)
- [ ] Volatility skew visualization
- [ ] IV term structure chart
- [ ] VIX term structure
- [ ] Historical GEX tracking
- [ ] Multiple expiration GEX aggregation

### Phase 3 (Planned)
- [ ] 3D Volatility surface (Plotly.js)
- [ ] Options flow feed (Unusual Whales integration)
- [ ] Dark pool volume (FINRA data)
- [ ] Volume profile by price level
- [ ] Custom alerts and notifications
- [ ] TimescaleDB for historical caching
- [ ] Redis pub/sub for real-time updates

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Next.js 15 + React 19 | App framework |
| State | Zustand 5 | Client state management |
| Charts | TradingView Lightweight Charts | Candlestick/price charts |
| Charts | Canvas 2D API | GEX profile bars |
| Styling | Tailwind CSS 3 | Utility-first CSS |
| Icons | Lucide React | UI icons |
| Math | Custom TypeScript engine | Black-Scholes, Greeks, GEX |
| Data | Tradier API | Options chains, quotes |
| Deploy | Vercel / Docker | Hosting |

## Self-Hosting (Docker)

```bash
docker compose up -d
```

Access at `http://localhost:3000`.

## Data Costs

| Provider | Cost | What You Get |
|----------|------|--------------|
| Tradier Pro | $10/mo | Real-time chains, Greeks (ORATS), streaming |
| Polygon Starter | $29/mo | WebSocket streaming, 2yr history |
| **Total MVP** | **$10–39/mo** | Everything needed for the dashboard |

## Math Engine

All options analytics computed in TypeScript — no Python dependency:

- **Black-Scholes** pricing (calls + puts)
- **All Greeks**: Delta, Gamma, Theta, Vega, Rho
- **Second-order Greeks**: Vanna (∂Δ/∂σ), Charm (∂Δ/∂t), Speed (∂Γ/∂S)
- **IV Solver**: Newton-Raphson with Brenner-Subrahmanyam initial guess
- **GEX**: Per-strike gamma exposure with dealer convention
- **DEX**: Delta exposure aggregation
- **Gamma Flip**: Zero-crossing detection via linear interpolation
- **Call/Put Walls**: Max absolute gamma strikes
- **Max Pain**: Exhaustive strike iteration
- **PCR**: Volume and OI-based ratios

## License

Private — personal use.
