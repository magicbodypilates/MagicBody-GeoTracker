<p align="center">
  <h1 align="center">Sovereign AEO Tracker</h1>
  <p align="center">
    Open-source, local-first AI visibility intelligence dashboard.<br/>
    Track your brand across <strong>6 AI models</strong> — zero vendor lock-in.
  </p>
  <p align="center">
    <a href="https://llm-tracker-three.vercel.app"><strong>Live Demo</strong></a> · 
    <a href="#features"><strong>Features</strong></a> · 
    <a href="#quick-start"><strong>Quick Start</strong></a> · 
    <a href="#deploy-to-vercel"><strong>Deploy</strong></a>
  </p>
</p>

---

## Why

AI models are replacing traditional search for millions of queries. If your brand isn't visible in ChatGPT, Perplexity, or Gemini responses, you're invisible to a growing audience.

Existing tools charge **$200–$500+/month**, lock you into closed ecosystems, and store your data on their servers.

**Sovereign AEO Tracker** is the alternative:

- **BYOK** (Bring Your Own Keys) — your data never leaves your machine
- **6 AI models** simultaneously — more coverage than paid tools
- **$0/month** — self-hosted, open-source, forever free
- **Local-first** — IndexedDB + localStorage, no external database

## Features

### 12 Feature Tabs

| Tab | What it does |
|-----|-------------|
| **Project Settings** | Brand name, aliases, website, industry, keywords, description |
| **Prompt Hub** | Manage tracking prompts with `{brand}` injection. Run single or batch across models |
| **Persona Fan-Out** | Generate persona-specific prompt variants (CMO, SEO Lead, Founder, etc.) |
| **Niche Explorer** | AI-generated high-intent queries for your niche |
| **Responses** | Browse AI responses with brand/competitor highlighting, filters, and search |
| **Visibility Analytics** | Score trends over time via Recharts line charts. CSV export |
| **Citations** | Domain-grouped citation frequency analysis |
| **Citation Opportunities** | URLs where competitors get cited but you don't — with outreach briefs |
| **Competitor Battlecards** | AI-generated side-by-side competitor analysis with strengths/weaknesses |
| **AEO Audit** | Site readiness check — llms.txt, Schema.org, BLUF density, heading structure |
| **Automation** | Cron / GitHub Actions templates for scheduled runs |
| **Documentation** | Searchable 14-section guide covering every feature |

### Core Capabilities

- **Multi-model tracking** — ChatGPT, Perplexity, Gemini, Copilot, Google AI Overview, Grok
- **Visibility scoring** (0–100) — brand mentions, position, frequency, citations, sentiment
- **Drift alerts** — automatic notifications when your score changes significantly
- **Scheduled auto-runs** — configurable interval-based batch scraping
- **Historical comparison** — delta tracking across time periods
- **Multi-workspace** — manage multiple brands/projects independently
- **Dark/light/system** theme with a polished sidebar UI

## Architecture

```
Next.js 16.1 + Turbopack
├── app/
│   ├── page.tsx                    # Main dashboard (or demo via env var)
│   ├── demo/page.tsx               # Standalone demo route
│   └── api/
│       ├── scrape/route.ts         # Bright Data AI Scrapers (Node runtime)
│       ├── analyze/route.ts        # OpenRouter LLM analysis (Edge runtime)
│       └── audit/route.ts          # AEO site audit crawler
├── components/
│   ├── sovereign-dashboard.tsx     # Main shell — state, tabs, KPIs
│   └── dashboard/
│       ├── types.ts                # AppState, ScrapeRun, Provider, etc.
│       └── tabs/                   # 12 tab components
├── lib/
│   ├── client/sovereign-store.ts   # IndexedDB + localStorage persistence
│   ├── server/brightdata-scraper.ts # Bright Data API integration
│   └── demo-data.ts               # Deterministic seed data for demo mode
└── scripts/
    ├── test-scraper.js             # API validation script
    └── test-pillar.js              # Feature pillar tests
```

**Key decisions:**
- **IndexedDB** primary store (no size limit) with localStorage as best-effort cache
- **Edge runtime** for `/api/analyze` (Kimi K2.5 via OpenRouter) — fast global inference
- **Bright Data Web Scraper API** for AI model scraping — reliable, structured data
- **Zod** schema validation on all API routes
- **Recharts** for analytics visualizations
- **Tailwind CSS v4** with CSS custom properties for theming

## Quick Start

### Prerequisites

- Node.js 18+
- [Bright Data](https://brightdata.com/) API key + AI Scraper dataset IDs
- [OpenRouter](https://openrouter.ai/) API key

### Install & Run

```bash
git clone https://github.com/danishashko/sovereign-aeo-tracker.git
cd sovereign-aeo-tracker
npm install
```

Create `.env` in the project root:

```env
BRIGHT_DATA_KEY=your_bright_data_api_key

# AI Scraper dataset IDs (from Bright Data Scrapers Library)
BRIGHT_DATA_DATASET_CHATGPT=gd_xxx
BRIGHT_DATA_DATASET_PERPLEXITY=gd_xxx
BRIGHT_DATA_DATASET_COPILOT=gd_xxx
BRIGHT_DATA_DATASET_GEMINI=gd_xxx
BRIGHT_DATA_DATASET_GOOGLE_AI=gd_xxx
BRIGHT_DATA_DATASET_GROK=gd_xxx

# OpenRouter (powers /api/analyze — battlecards, niche generation)
OPENROUTER_KEY=your_openrouter_api_key
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Validate Setup

```bash
npm run test:scraper    # Test Bright Data API connection
npm run build           # Full production build check
npm run lint            # ESLint
```

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdanishashko%2Fsovereign-aeo-tracker&env=BRIGHT_DATA_KEY,BRIGHT_DATA_DATASET_CHATGPT,BRIGHT_DATA_DATASET_PERPLEXITY,BRIGHT_DATA_DATASET_COPILOT,BRIGHT_DATA_DATASET_GEMINI,BRIGHT_DATA_DATASET_GOOGLE_AI,BRIGHT_DATA_DATASET_GROK,OPENROUTER_KEY)

1. Click the button above or run `vercel --prod`
2. Set all `.env` variables in Vercel Project Settings → Environment Variables
3. That's it — the app builds and deploys automatically

### Demo-Only Deployment

To deploy a read-only demo (no API keys needed):

1. Add env var: `NEXT_PUBLIC_DEMO_ONLY` = `true` (Production environment)
2. Deploy — the root URL will show the demo with pre-loaded data

## API Routes

| Route | Runtime | Purpose |
|-------|---------|---------|
| `POST /api/scrape` | Node.js | Bright Data AI Scrapers — query AI models for brand mentions |
| `POST /api/analyze` | Edge | OpenRouter LLM inference — battlecards, niche queries |
| `POST /api/audit` | Node.js | AEO site audit — llms.txt, schema, BLUF, heading checks |

All routes include in-memory caching to minimize API costs.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.1 + Turbopack |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 with `@theme inline` |
| Charts | Recharts |
| Validation | Zod |
| Storage | IndexedDB (idb-keyval) + localStorage |
| AI Scraping | Bright Data Web Scraper API |
| LLM Inference | OpenRouter (Kimi K2.5) |
| Deployment | Vercel |

## License

MIT — use it, fork it, ship it.

---

<p align="center">
  Built by <a href="https://www.linkedin.com/in/daniel-shashko/">Daniel Shashko</a><br/>
  <sub>Powered by <a href="https://brightdata.com/?utm_source=sovereign-aeo-tracker">Bright Data</a></sub>
</p>
