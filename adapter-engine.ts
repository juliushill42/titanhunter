// ============================================================
// MODULE A — Crawler & Micro-Adapter Engine (Complete)
// Hunter Real Estate System | TUAI Architecture
// Pipeline: [WebCrawler] → [AI Parser] → [DealRanker]
// ============================================================

import { AdapterConfig, RawLead, MarketSource, PipelineMessage } from '../../shared/types';
import { randomUUID } from 'crypto';

// ─── Interfaces ──────────────────────────────────────────────

export interface IMarketAdapter {
  readonly config: AdapterConfig;
  readonly market: MarketSource;
  validate(): Promise<boolean>;
  buildSearchUrls(region: string, params: CrawlParams): string[];
  fetchPage(url: string, context: CrawlContext): Promise<PageResult>;
  extractListingUrls(html: string): string[];
  parseListingToRawLead(html: string, url: string, batchId: string): Promise<RawLead>;
  teardown(): Promise<void>;
}

export interface CrawlParams {
  region: string;
  maxListings: number;
  filters?: {
    minPrice?: number;
    maxPrice?: number;
    propertyTypes?: string[];
    minBeds?: number;
    daysOnMarket?: number;
  };
}

export interface CrawlContext {
  sessionId: string;
  batchId: string;
  requestCount: number;
  proxyUrl?: string;
  userAgent: string;
  cookies?: Record<string, string>;
}

export interface PageResult {
  url: string;
  html: string;
  statusCode: number;
  responseTimeMs: number;
  fetchedAt: Date;
  proxyUsed?: string;
}

export interface CrawlJob {
  jobId: string;
  adapterId: string;
  market: MarketSource;
  region: string;
  params: CrawlParams;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  leadCount: number;
  errorCount: number;
  errorLog: string[];
}

export interface ICrawlerPublisher {
  publish(message: PipelineMessage<RawLead>): Promise<void>;
}

// ─── Abstract Base Adapter ───────────────────────────────────

export abstract class BaseMarketAdapter implements IMarketAdapter {
  abstract readonly market: MarketSource;

  constructor(public readonly config: AdapterConfig) {}

  async validate(): Promise<boolean> {
    if (!this.config.baseUrl || !this.config.selectors.listingContainer) {
      throw new Error(`[${this.config.id}] Invalid config: missing baseUrl or listingContainer`);
    }
    return true;
  }

  abstract buildSearchUrls(region: string, params: CrawlParams): string[];
  abstract fetchPage(url: string, context: CrawlContext): Promise<PageResult>;
  abstract extractListingUrls(html: string): string[];
  abstract parseListingToRawLead(html: string, url: string, batchId: string): Promise<RawLead>;

  async teardown(): Promise<void> {
    console.log(`[${this.config.id}] teardown complete`);
  }

  protected computeDelay(): number {
    const { delayBetweenRequestsMs, jitterMs } = this.config.rateLimit;
    return delayBetweenRequestsMs + Math.random() * jitterMs;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected makeRawLead(
    partial: Pick<RawLead, 'sourceUrl' | 'rawHtml' | 'marketRegion'> & Partial<RawLead>,
    batchId: string
  ): RawLead {
    return {
      id: randomUUID(),
      source: this.market,
      crawledAt: new Date(),
      adapterVersion: this.config.version,
      batchId,
      ...partial,
    };
  }
}

// ─── Concrete: MLS Adapter ───────────────────────────────────

export class MLSAdapter extends BaseMarketAdapter {
  readonly market: MarketSource = 'MLS';

  buildSearchUrls(region: string, params: CrawlParams): string[] {
    const { searchUrl, pagination, rateLimit } = this.config;
    const pageSize = pagination.pageSize;
    const totalPages = Math.min(
      Math.ceil(params.maxListings / pageSize),
      pagination.maxPages
    );
    return Array.from({ length: totalPages }, (_, i) => {
      const url = new URL(searchUrl);
      url.searchParams.set('location', region);
      url.searchParams.set(pagination.paramName ?? 'page', String(i + 1));
      if (params.filters?.minPrice) url.searchParams.set('price_min', String(params.filters.minPrice));
      if (params.filters?.maxPrice) url.searchParams.set('price_max', String(params.filters.maxPrice));
      return url.toString();
    });
  }

  async fetchPage(url: string, context: CrawlContext): Promise<PageResult> {
    const start = Date.now();
    // Production: swap fetch() for Playwright page.goto() on JS-heavy MLS portals
    const response = await fetch(url, {
      headers: { 'User-Agent': context.userAgent, ...this.config.headers },
    });
    const html = await response.text();
    await this.sleep(this.computeDelay());
    return {
      url, html,
      statusCode: response.status,
      responseTimeMs: Date.now() - start,
      fetchedAt: new Date(),
      proxyUsed: context.proxyUrl,
    };
  }

  extractListingUrls(html: string): string[] {
    // Production: const $ = cheerio.load(html);
    // return $(this.config.selectors.listingContainer)
    //   .map((_, el) => new URL($(el).attr('href')!, this.config.baseUrl).toString()).get();
    return [];
  }

  async parseListingToRawLead(html: string, url: string, batchId: string): Promise<RawLead> {
    return this.makeRawLead({ sourceUrl: url, rawHtml: html, marketRegion: 'PENDING' }, batchId);
  }
}

// ─── Concrete: County Records Adapter ───────────────────────

export class CountyRecordsAdapter extends BaseMarketAdapter {
  readonly market: MarketSource = 'COUNTY_RECORDS';

  buildSearchUrls(region: string, params: CrawlParams): string[] {
    const pageSize = this.config.pagination.pageSize;
    const pages = Math.ceil(params.maxListings / pageSize);
    return Array.from({ length: pages }, (_, i) => {
      const url = new URL(this.config.searchUrl);
      url.searchParams.set('county', region);
      url.searchParams.set('offset', String(i * pageSize));
      url.searchParams.set('limit', String(pageSize));
      return url.toString();
    });
  }

  async fetchPage(url: string, context: CrawlContext): Promise<PageResult> {
    const start = Date.now();
    const apiKey = process.env[this.config.auth?.credentials?.envKey ?? 'COUNTY_API_KEY'];
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': context.userAgent },
    });
    const html = await response.text();
    await this.sleep(this.computeDelay());
    return { url, html, statusCode: response.status, responseTimeMs: Date.now() - start, fetchedAt: new Date() };
  }

  extractListingUrls(_html: string): string[] {
    return []; // County APIs return direct JSON — no listing URL extraction needed
  }

  async parseListingToRawLead(html: string, url: string, batchId: string): Promise<RawLead> {
    return this.makeRawLead({ sourceUrl: url, rawHtml: html, rawText: html, marketRegion: 'COUNTY' }, batchId);
  }
}

// ─── Concrete: Zillow Adapter (Playwright-based) ─────────────

export class ZillowAdapter extends BaseMarketAdapter {
  readonly market: MarketSource = 'ZILLOW';

  buildSearchUrls(region: string, params: CrawlParams): string[] {
    // Zillow uses URL-encoded region slugs
    const slug = region.replace(/\s+/g, '-').toLowerCase();
    return [`https://www.zillow.com/${slug}/`];
  }

  async fetchPage(url: string, context: CrawlContext): Promise<PageResult> {
    // PRODUCTION ONLY — requires Playwright + stealth plugin:
    // const browser = await chromium.launch({ proxy: { server: context.proxyUrl } });
    // const page = await browser.newPage();
    // await page.goto(url, { waitUntil: 'networkidle' });
    // const html = await page.content();
    // await browser.close();
    // For boilerplate, using fetch as placeholder:
    const start = Date.now();
    const response = await fetch(url, { headers: { 'User-Agent': context.userAgent } });
    const html = await response.text();
    await this.sleep(this.computeDelay());
    return { url, html, statusCode: response.status, responseTimeMs: Date.now() - start, fetchedAt: new Date() };
  }

  extractListingUrls(html: string): string[] {
    // Zillow embeds listing data in __NEXT_DATA__ JSON
    // const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    // if (!match) return [];
    // const data = JSON.parse(match[1]);
    // return data?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults
    //   ?.map((r: any) => r.detailUrl).filter(Boolean) ?? [];
    return [];
  }

  async parseListingToRawLead(html: string, url: string, batchId: string): Promise<RawLead> {
    return this.makeRawLead({ sourceUrl: url, rawHtml: html, marketRegion: 'ZILLOW' }, batchId);
  }
}

// ─── Adapter Registry ────────────────────────────────────────

export class AdapterRegistry {
  private adapters = new Map<string, IMarketAdapter>();

  register(adapter: IMarketAdapter): void {
    this.adapters.set(adapter.config.id, adapter);
    console.log(`[Registry] Registered: ${adapter.config.id} (${adapter.market})`);
  }

  get(adapterId: string): IMarketAdapter {
    const a = this.adapters.get(adapterId);
    if (!a) throw new Error(`No adapter: ${adapterId}`);
    return a;
  }

  list(): AdapterConfig[] {
    return [...this.adapters.values()].map(a => a.config);
  }
}

// ─── Crawler Orchestrator ────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36',
];

export class CrawlerOrchestrator {
  private activeJobs = new Map<string, CrawlJob>();

  constructor(
    private registry: AdapterRegistry,
    private publisher: ICrawlerPublisher
  ) {}

  async runJob(job: CrawlJob): Promise<CrawlJob> {
    const adapter = this.registry.get(job.adapterId);
    await adapter.validate();

    job.status = 'RUNNING';
    job.startedAt = new Date();
    this.activeJobs.set(job.jobId, job);

    const context: CrawlContext = {
      sessionId: randomUUID(),
      batchId: job.jobId,
      requestCount: 0,
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    };

    try {
      const searchUrls = adapter.buildSearchUrls(job.region, job.params);

      for (const searchUrl of searchUrls) {
        const searchPage = await adapter.fetchPage(searchUrl, context);
        context.requestCount++;

        const listingUrls = adapter.extractListingUrls(searchPage.html);

        for (const listingUrl of listingUrls) {
          try {
            const listingPage = await adapter.fetchPage(listingUrl, context);
            context.requestCount++;

            const rawLead = await adapter.parseListingToRawLead(
              listingPage.html,
              listingUrl,
              job.jobId
            );

            await this.publisher.publish({
              messageId: randomUUID(),
              topic: 'hunter.raw.leads',
              payload: rawLead,
              metadata: {
                batchId: job.jobId,
                retryCount: 0,
                producedAt: new Date(),
                source: adapter.config.id,
              },
            });

            job.leadCount++;

            if (job.leadCount >= job.params.maxListings) break;
          } catch (listingErr) {
            job.errorCount++;
            job.errorLog.push(`[${listingUrl}] ${(listingErr as Error).message}`);
          }
        }

        if (job.leadCount >= job.params.maxListings) break;
      }

      job.status = 'COMPLETE';
    } catch (err) {
      job.status = 'FAILED';
      job.errorLog.push((err as Error).message);
    } finally {
      job.completedAt = new Date();
      this.activeJobs.delete(job.jobId);
      await adapter.teardown();
    }

    return job;
  }

  getActiveJobs(): CrawlJob[] {
    return [...this.activeJobs.values()];
  }

  static createJob(
    adapterId: string,
    market: MarketSource,
    region: string,
    params: CrawlParams
  ): CrawlJob {
    return {
      jobId: randomUUID(),
      adapterId,
      market,
      region,
      params,
      status: 'QUEUED',
      createdAt: new Date(),
      leadCount: 0,
      errorCount: 0,
      errorLog: [],
    };
  }
}
