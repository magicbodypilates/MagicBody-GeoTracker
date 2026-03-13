<p align="center">
  <img src="public/banner.svg" alt="GEO/AEO Tracker – Open-source AI visibility dashboard" width="100%"/>
</p>

<p align="center">
  <a href="https://brightdata.com/?utm_source=geo-tracker-os"><img src="https://img.shields.io/badge/Powered%20by-Bright%20Data-00d4aa?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0id2hpdGUiLz48L3N2Zz4=" alt="Powered by Bright Data"/></a>
  <a href="https://llm-tracker-three.vercel.app"><img src="https://img.shields.io/badge/Live%20Demo-▶-blue?style=for-the-badge" alt="Live Demo"/></a>
  <a href="#deploy-to-vercel"><img src="https://img.shields.io/badge/Deploy-Vercel-black?style=for-the-badge&logo=vercel" alt="Deploy to Vercel"/></a>
</p>

<h1 align="center">GEO/AEO Tracker</h1>

<p align="center">
  Open-source, local-first AI visibility intelligence dashboard.<br/>
  Track your brand across <strong>6 AI models</strong> with zero vendor lock-in.<br/>
  Now with <strong>SRO Analysis</strong> — deep cross-platform search result optimization.<br/>
  <strong>Mobile-responsive</strong> — works seamlessly on desktop, tablet, and phone.
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> · 
  <a href="#quick-start"><strong>Quick Start</strong></a> · 
  <a href="#deploy-to-vercel"><strong>Deploy</strong></a> · 
  <a href="#api-routes"><strong>API</strong></a>
</p>

---

> 🌐 **Built with [Bright Data](https://brightdata.com/?utm_source=geo-tracker-os)** — the world's leading web data platform.
> GEO/AEO Tracker uses Bright Data's AI Scraper API to reliably collect structured responses from 6 AI models.
> [Get your API key →](https://brightdata.com/?utm_source=geo-tracker-os)

---

## Why

AI models are replacing traditional search for millions of queries. If your brand isn't visible in ChatGPT, Perplexity, or Gemini responses, you're invisible to a growing audience.

Existing tools charge **$200–$500+/month**, lock you into closed ecosystems, and store your data on their servers.

**GEO/AEO Tracker** is the alternative:

- 🔑 **BYOK** (Bring Your Own Keys): your data never leaves your machine
- 🤖 **6 AI models** simultaneously: more coverage than paid tools
- 💸 **$0/month**: self-hosted, open-source, forever free
- 🛡️ **Local-first**: IndexedDB + localStorage, no external database

## Features

### 📋 13 Feature Tabs

| Tab | What it does |
|-----|-------------|
| ⚙️ **Project Settings** | Brand name, aliases, website, industry, keywords, description |
| 💬 **Prompt Hub** | Manage tracking prompts with `{brand}` injection. Run single or batch across models in parallel |
| 🎭 **Persona Fan-Out** | Generate persona-specific prompt variants (CMO, SEO Lead, Founder, etc.) |
| 🔍 **Niche Explorer** | AI-generated high-intent queries for your niche |
| 📝 **Responses** | Browse AI responses with brand/competitor highlighting, filters, and search |
| 📊 **Visibility Analytics** | Score trends over time via Recharts line charts. CSV export |
| 🔗 **Citations** | Domain-grouped citation frequency analysis |
| 🎯 **Citation Opportunities** | URLs where competitors get cited but you don't, with outreach briefs |
| ⚔️ **Competitor Battlecards** | AI-generated side-by-side competitor analysis with strengths/weaknesses |
| 🏥 **AEO Audit** | Site readiness check: llms.txt, Schema.org, BLUF density, heading structure |
| 📡 **SRO Analysis** | 6-stage deep pipeline: Gemini Grounding → Cross-Platform Citations → SERP → Page Scraping → Site Context → LLM Analysis. Produces SRO Score (0–100), prioritized recommendations, content gaps & competitor insights |
| ⏱️ **Automation** | Cron / GitHub Actions templates for scheduled runs |
| 📖 **Documentation** | Searchable 18-section guide covering every feature |

### 🚀 Core Capabilities

- 🤖 **Multi-model tracking** across ChatGPT, Perplexity, Gemini, Copilot, Google AI Overview, Grok
- � **SRO Analysis**: 6-stage pipeline scoring how well your page is optimized for AI search results
- 📈 **Visibility scoring** (0–100): brand mentions, position, frequency, citations, sentiment
- 🔔 **Drift alerts**: automatic notifications when your score changes significantly
- ⏰ **Scheduled auto-runs**: configurable interval-based batch scraping
- 🚀 **Fully parallel batch runs**: all prompt × provider combos execute simultaneously
- 📅 **Historical comparison**: delta tracking across time periods
- 🏢 **Multi-workspace**: manage multiple brands/projects independently
- 🎨 **Dark/light/system** theme with a polished sidebar UI
- 📱 **Mobile-responsive**: collapsible sidebar with hamburger menu, adaptive KPI grid, and scrollable model toolbar — works on any screen size

## Architecture

```
Next.js 16.1 + Turbopack
├── app/
│   ├── page.tsx                    # Main dashboard (or demo via env var)
│   ├── demo/page.tsx               # Standalone demo route
│   └── api/
│       ├── scrape/route.ts         # Bright Data AI Scrapers (Node runtime)
│       ├── analyze/route.ts        # OpenRouter LLM analysis (Edge runtime)
│       ├── audit/route.ts          # AEO site audit crawler
│       ├── sro-analyze/route.ts    # SRO final LLM analysis
│       ├── serp/route.ts           # Bright Data SERP results
│       ├── site-context/route.ts   # Homepage context extraction
│       ├── unlocker/route.ts       # Bright Data Web Unlocker (single/batch)
│       ├── brightdata-platforms/   # 6-platform AI citation polling
│       └── bulk-sro/route.ts       # SSE bulk SRO analysis
├── components/
│   ├── sovereign-dashboard.tsx     # Main shell — state, tabs, KPIs
│   └── dashboard/
│       ├── types.ts                # AppState, ScrapeRun, Provider, etc.
│       └── tabs/                   # 13 tab components
├── lib/
│   ├── client/sovereign-store.ts   # IndexedDB + localStorage persistence
│   ├── server/
│   │   ├── brightdata-scraper.ts   # Bright Data AI Scraper integration
│   │   ├── brightdata-platforms.ts # 6-platform citation scraper
│   │   ├── gemini-grounding.ts     # Gemini Grounding via Google Search
│   │   ├── openrouter-sro.ts       # SRO analysis via OpenRouter
│   │   ├── serp.ts                 # SERP data via Bright Data
│   │   ├── sro-types.ts            # SRO type definitions
│   │   └── unlocker.ts             # Web Unlocker scraping
│   └── demo-data.ts               # Deterministic seed data for demo mode
└── scripts/
    ├── test-scraper.js             # API validation script
    └── test-pillar.js              # Feature pillar tests
```

**Key decisions:**
- **IndexedDB** primary store (no size limit) with localStorage as best-effort cache
- **Edge runtime** for `/api/analyze` (Gemini Flash via OpenRouter) — fast global inference
- **Bright Data Web Scraper API** for AI model scraping — reliable, structured data
- **Bright Data SERP + Web Unlocker** for SRO pipeline data gathering
- **Google Gemini API** for grounding analysis in SRO pipeline
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

# OpenRouter (powers /api/analyze, /api/sro-analyze, /api/site-context)
OPENROUTER_KEY=your_openrouter_api_key

# Gemini API (powers Gemini Grounding in SRO Analysis)
GEMINI_API_KEY=your_gemini_api_key
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

> ✅ **The deploy button launches a fully functional production instance.** You'll be prompted for your API keys during setup. No demo mode, no restrictions.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdanishashko%2Fsovereign-aeo-tracker&env=BRIGHT_DATA_KEY,BRIGHT_DATA_DATASET_CHATGPT,BRIGHT_DATA_DATASET_PERPLEXITY,BRIGHT_DATA_DATASET_COPILOT,BRIGHT_DATA_DATASET_GEMINI,BRIGHT_DATA_DATASET_GOOGLE_AI,BRIGHT_DATA_DATASET_GROK,OPENROUTER_KEY,GEMINI_API_KEY)

1. Click the button above (or run `vercel --prod` from your clone)
2. Enter your [Bright Data](https://brightdata.com/?utm_source=geo-tracker-os) and [OpenRouter](https://openrouter.ai/) API keys when prompted
3. Done! Your tracker deploys automatically with full production capabilities

### 🧪 Demo-Only Mode (optional)

Want to deploy a read-only preview with sample data and no API keys?

1. Add env var `NEXT_PUBLIC_DEMO_ONLY` = `true` in Vercel → Project Settings → Environment Variables
2. Redeploy. The dashboard will load with pre-generated demo data instead of making live API calls

## API Routes

| Route | Runtime | Purpose |
|-------|---------|---------|
| `POST /api/scrape` | Node.js | Bright Data AI Scrapers — query AI models for brand mentions |
| `POST /api/analyze` | Edge | OpenRouter LLM inference — battlecards, niche queries |
| `POST /api/audit` | Node.js | AEO site audit — llms.txt, schema, BLUF, heading checks |
| `POST /api/sro-analyze` | Node.js | SRO final analysis — synthesizes all data into score + recommendations |
| `POST /api/serp` | Node.js | Bright Data SERP — organic search results for a keyword |
| `POST /api/site-context` | Node.js | Homepage scrape + context extraction via OpenRouter |
| `POST /api/unlocker` | Node.js | Bright Data Web Unlocker — single or batch URL scraping |
| `POST /api/brightdata-platforms` | Node.js | 6-platform AI citation polling via Bright Data datasets |
| `POST /api/bulk-sro` | Node.js | SSE streaming — bulk SRO analysis across multiple keywords |

All routes include input validation and error handling. Most routes use in-memory caching to minimize API costs.

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
| LLM Inference | OpenRouter (Gemini Flash) |
| SRO Grounding | Google Gemini API (`@google/genai`) |
| SERP Data | Bright Data SERP API |
| Web Scraping | Bright Data Web Unlocker |
| Deployment | Vercel |

## License

MIT — use it, fork it, ship it.

---

<p align="center">
  Built by <a href="https://www.linkedin.com/in/daniel-shashko/">Daniel Shashko</a><br/>
  <sub>Powered by <a href="https://brightdata.com/?utm_source=geo-tracker-os">Bright Data</a></sub>
</p>
