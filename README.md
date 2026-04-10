# Hunter Real Estate Lead Generation System
## Technical Specification v1.0 | TUAI Architecture

```
hunter/
├── .env.example                          # Environment variable template
├── docker-compose.yml                    # Full local dev stack
├── package.json                          # Monorepo root
│
├── shared/
│   └── types/
│       └── index.ts                      # ALL shared TypeScript types
│
├── modules/
│   │
│   ├── crawler/                          # MODULE A
│   │   ├── adapter-engine.ts             # ← Core adapter pattern + orchestrator
│   │   ├── adapters.config.yaml          # ← Plug-and-play market configs
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── pipeline/                         # MODULE B
│   │   ├── deal-ranker.ts                # ← AI extraction + DealRanker (0-1000)
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── gateway/                          # MODULE C
│   │   ├── escrow-gateway.ts             # ← TitanWallet + TitanEscrow + multi-sig
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── dashboard/                        # MODULE D
│       ├── orchestra-dashboard.ts        # ← Health, F2C, export queue, webhooks
│       ├── Dockerfile
│       └── package.json
│
└── infra/
    ├── k8s/
    │   └── crawler-deployment.yaml       # K8s Deployment + HPA for Orchestra scaling
    └── docker/
        ├── postgres-init.sql             # Full DB schema (8 tables)
        └── nginx.conf                    # Reverse proxy config
```

---

## Architecture: The 3-Subsystem Pipeline

```
[WebCrawler] → [AI Parser] → [DealRanker]
     ↓               ↓              ↓
 Kafka Topic    Claude 3.5     Score 0-1000
 raw.leads      Extraction       Tier S-D
                               
                          Score ≥ 850 → Orchestra Webhook
                                     → Finance ROI model
                                     → Ledger log
                                     → AcreFinder comps
```

## Module Summary

| Module | Service | Port | Key Tech |
|--------|---------|------|----------|
| A - Crawler | `hunter-crawler` | 3001 | Node.js, Playwright, Cheerio, Kafka |
| B - Pipeline | `hunter-pipeline` | 3002 | Claude Sonnet, Kafka consumers |
| C - Gateway | `hunter-gateway` | 3003 | Stripe, SHA-256 multi-sig, Express |
| D - Dashboard | `hunter-dashboard` | 3004/3005 | WebSocket, Docker API, Kafka |
| - | Kafka UI | 8090 | Confluent |
| - | Postgres | 5432 | pg_trgm, JSONB |
| - | Redis | 6379 | Session + rate limit cache |

## DealRanker Score Breakdown (Default Weights)

| Dimension | Weight | Max Points | Signal |
|-----------|--------|------------|--------|
| Equity Spread (ARV vs price) | 30% | 300 | Below market value |
| Distress Signals | 25% | 250 | Liens, FSBO, absentee |
| Days on Market | 15% | 150 | Motivated seller |
| Contactability | 15% | 150 | Direct owner contact |
| Location Match | 10% | 100 | Target ZIP/market |
| Cash Flow Potential | 5% | 50 | 1% rule estimate |
| **Total** | **100%** | **1000** | |

**Tier thresholds:** S ≥ 850 · A ≥ 700 · B ≥ 550 · C ≥ 400 · D < 400

## Quick Start

```bash
# 1. Clone and install
git clone <repo>
cd hunter && npm install

# 2. Configure
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, STRIPE_SECRET_KEY, POSTGRES_PASSWORD

# 3. Launch full stack
docker-compose up --build

# 4. Verify services
curl http://localhost:3001/health   # Crawler
curl http://localhost:3002/health   # Pipeline
curl http://localhost:3003/health   # Gateway
curl http://localhost:3004/health   # Dashboard
open http://localhost:8090          # Kafka UI

# 5. Start a hunt
curl -X POST http://localhost:3001/jobs -H "Content-Type: application/json" -d '{
  "adapterId": "mls-national-v1",
  "market": "MLS",
  "region": "30301",
  "params": { "maxListings": 100, "filters": { "maxPrice": 300000 } }
}'
```

## Adding a New Market (Plug-and-Play)

1. Add a new entry to `modules/crawler/adapters.config.yaml`
2. If the site is CSS-selector based → zero code changes
3. If JS-rendered → subclass `BaseMarketAdapter` with Playwright logic
4. Register in `AdapterRegistry` on startup
5. K8s: Orchestra auto-spawns a new container per market

## Production K8s Deployment

```bash
kubectl create namespace hunter
kubectl apply -f infra/k8s/crawler-deployment.yaml
# HPA auto-scales to 43 containers for 43 markets
# Each container = one dedicated market crawler
```
