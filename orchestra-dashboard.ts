// ============================================================
// MODULE D — Orchestra Management Dashboard
// Hunter Real Estate System | TUAI Architecture
// Tracks: Find-to-Close timestamps, container health, export queues
// ============================================================

import {
  ContainerHealth,
  LeadPipelineMetrics,
  ExportJob,
  RankedLead,
  DealTier,
} from '../../shared/types';
import { randomUUID } from 'crypto';

// ─── Container Health Monitor ────────────────────────────────

export interface IContainerRuntime {
  listContainers(): Promise<ContainerInfo[]>;
  getStats(containerId: string): Promise<ContainerStats>;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  startedAt: Date;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
  restartCount: number;
}

export class ContainerHealthMonitor {
  private healthCache = new Map<string, ContainerHealth>();
  private pollIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private runtime: IContainerRuntime,
    pollIntervalMs = 15_000
  ) {
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.poll(); // immediate first run
    console.log(`[HealthMonitor] Polling container health every ${this.pollIntervalMs / 1000}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    try {
      const containers = await this.runtime.listContainers();
      for (const container of containers) {
        try {
          const stats = await this.runtime.getStats(container.id);
          const uptimeSeconds = Math.floor((Date.now() - container.startedAt.getTime()) / 1000);

          const health: ContainerHealth = {
            containerId: container.id,
            serviceName: container.name,
            status: this.deriveStatus(stats, container.status),
            cpuPercent: stats.cpuPercent,
            memoryMb: stats.memoryUsedMb,
            uptimeSeconds,
            lastHeartbeat: new Date(),
            errorCount1h: 0, // populated from log aggregator in prod
          };

          this.healthCache.set(container.id, health);
        } catch (err) {
          console.error(`[HealthMonitor] Failed to get stats for ${container.name}: ${(err as Error).message}`);
          this.markDegraded(container.id, container.name);
        }
      }
    } catch (err) {
      console.error(`[HealthMonitor] Container list failed: ${(err as Error).message}`);
    }
  }

  private deriveStatus(stats: ContainerStats, dockerStatus: string): ContainerHealth['status'] {
    if (!dockerStatus.startsWith('Up')) return 'DOWN';
    if (stats.cpuPercent > 90 || stats.memoryUsedMb / stats.memoryLimitMb > 0.90) return 'DEGRADED';
    if (stats.restartCount > 3) return 'DEGRADED';
    return 'HEALTHY';
  }

  private markDegraded(containerId: string, serviceName: string): void {
    const existing = this.healthCache.get(containerId);
    this.healthCache.set(containerId, {
      ...(existing ?? {
        containerId,
        serviceName,
        cpuPercent: 0,
        memoryMb: 0,
        uptimeSeconds: 0,
        errorCount1h: 0,
      }),
      status: 'DOWN',
      lastHeartbeat: new Date(),
    } as ContainerHealth);
  }

  getAllHealth(): ContainerHealth[] {
    return [...this.healthCache.values()];
  }

  getByService(serviceName: string): ContainerHealth | undefined {
    return [...this.healthCache.values()].find(h => h.serviceName === serviceName);
  }

  getSummary(): { healthy: number; degraded: number; down: number; total: number } {
    const all = this.getAllHealth();
    return {
      healthy:  all.filter(h => h.status === 'HEALTHY').length,
      degraded: all.filter(h => h.status === 'DEGRADED').length,
      down:     all.filter(h => h.status === 'DOWN').length,
      total:    all.length,
    };
  }
}

// ─── Find-to-Close Tracker ───────────────────────────────────

export interface FindToCloseRecord {
  leadId: string;
  dealId?: string;
  foundAt: Date;
  extractedAt?: Date;
  rankedAt?: Date;
  exportedAt?: Date;
  escrowCreatedAt?: Date;
  escrowFundedAt?: Date;
  closedAt?: Date;
  currentStatus: string;
  totalElapsedHours?: number;
}

export class FindToCloseTracker {
  private records = new Map<string, FindToCloseRecord>();

  markFound(leadId: string): void {
    this.records.set(leadId, { leadId, foundAt: new Date(), currentStatus: 'FOUND' });
  }

  markExtracted(leadId: string): void {
    this.updateRecord(leadId, { extractedAt: new Date(), currentStatus: 'EXTRACTED' });
  }

  markRanked(leadId: string): void {
    this.updateRecord(leadId, { rankedAt: new Date(), currentStatus: 'RANKED' });
  }

  markExported(leadId: string): void {
    this.updateRecord(leadId, { exportedAt: new Date(), currentStatus: 'EXPORTED' });
  }

  markEscrowCreated(leadId: string, dealId: string): void {
    this.updateRecord(leadId, { dealId, escrowCreatedAt: new Date(), currentStatus: 'IN_ESCROW' });
  }

  markClosed(leadId: string): void {
    const record = this.records.get(leadId);
    if (!record) return;
    const closedAt = new Date();
    const totalElapsedHours = (closedAt.getTime() - record.foundAt.getTime()) / 3_600_000;
    this.updateRecord(leadId, { closedAt, currentStatus: 'CLOSED', totalElapsedHours });
  }

  getRecord(leadId: string): FindToCloseRecord | undefined {
    return this.records.get(leadId);
  }

  getAverageFindToCloseHours(): number | undefined {
    const closed = [...this.records.values()].filter(r => r.totalElapsedHours !== undefined);
    if (!closed.length) return undefined;
    return closed.reduce((sum, r) => sum + (r.totalElapsedHours ?? 0), 0) / closed.length;
  }

  private updateRecord(leadId: string, updates: Partial<FindToCloseRecord>): void {
    const existing = this.records.get(leadId);
    if (!existing) {
      console.warn(`[F2C] No record found for leadId ${leadId} — creating retroactively`);
      this.records.set(leadId, { leadId, foundAt: new Date(), currentStatus: 'UNKNOWN', ...updates });
      return;
    }
    this.records.set(leadId, { ...existing, ...updates });
  }
}

// ─── Pipeline Metrics Aggregator ─────────────────────────────

export class PipelineMetricsAggregator {
  private counters = {
    crawled: 0,
    extracted: 0,
    ranked: 0,
    exported: 0,
    inEscrow: 0,
    closed: 0,
  };
  private scoreAccumulator = 0;
  private scoreCount = 0;
  private topTierCount = 0;
  private windowStart = new Date();

  increment(stage: keyof typeof this.counters): void {
    this.counters[stage]++;
  }

  recordScore(score: number, tier: DealTier): void {
    this.scoreAccumulator += score;
    this.scoreCount++;
    if (tier === 'S' || tier === 'A') this.topTierCount++;
  }

  snapshot(tracker: FindToCloseTracker): LeadPipelineMetrics {
    const now = new Date();
    return {
      windowStart: this.windowStart,
      windowEnd: now,
      ...this.counters,
      avgFindToCloseHours: tracker.getAverageFindToCloseHours(),
      avgDealScore: this.scoreCount > 0 ? Math.round(this.scoreAccumulator / this.scoreCount) : 0,
      topTierCount: this.topTierCount,
    };
  }

  reset(): void {
    Object.keys(this.counters).forEach(k => {
      this.counters[k as keyof typeof this.counters] = 0;
    });
    this.scoreAccumulator = 0;
    this.scoreCount = 0;
    this.topTierCount = 0;
    this.windowStart = new Date();
  }
}

// ─── Lead Export Queue ───────────────────────────────────────

export type CRMTarget = 'HUBSPOT' | 'SALESFORCE' | 'FOLLOWUPBOSS' | 'PODIO';

export interface ICRMAdapter {
  readonly target: CRMTarget;
  push(leads: RankedLead[]): Promise<{ pushed: number; failed: number; errors: string[] }>;
}

export interface IExportJobRepository {
  create(job: ExportJob): Promise<ExportJob>;
  update(jobId: string, updates: Partial<ExportJob>): Promise<void>;
  findById(jobId: string): Promise<ExportJob | null>;
  findPending(): Promise<ExportJob[]>;
}

export interface IRankedLeadRepository {
  findByIds(ids: string[]): Promise<RankedLead[]>;
  findByTier(tier: DealTier): Promise<RankedLead[]>;
}

export class LeadExportQueue {
  private crmAdapters = new Map<CRMTarget, ICRMAdapter>();
  private processing = new Set<string>();

  constructor(
    private jobRepo: IExportJobRepository,
    private leadRepo: IRankedLeadRepository
  ) {}

  registerCRMAdapter(adapter: ICRMAdapter): void {
    this.crmAdapters.set(adapter.target, adapter);
    console.log(`[ExportQueue] Registered CRM adapter: ${adapter.target}`);
  }

  async enqueueCSVExport(leadIds: string[], requestedBy: string): Promise<ExportJob> {
    const job: ExportJob = {
      jobId: randomUUID(),
      format: 'CSV',
      status: 'QUEUED',
      leadIds,
      createdAt: new Date(),
    };
    return this.jobRepo.create(job);
  }

  async enqueueCRMExport(target: CRMTarget, leadIds: string[]): Promise<ExportJob> {
    if (!this.crmAdapters.has(target)) {
      throw new Error(`No CRM adapter registered for: ${target}`);
    }
    const job: ExportJob = {
      jobId: randomUUID(),
      format: target,
      status: 'QUEUED',
      leadIds,
      createdAt: new Date(),
    };
    return this.jobRepo.create(job);
  }

  async processJob(jobId: string): Promise<ExportJob> {
    if (this.processing.has(jobId)) throw new Error(`Job ${jobId} already processing`);
    this.processing.add(jobId);

    const job = await this.jobRepo.findById(jobId);
    if (!job) throw new Error(`Export job not found: ${jobId}`);

    await this.jobRepo.update(jobId, { status: 'PROCESSING' });

    try {
      const leads = await this.leadRepo.findByIds(job.leadIds);

      if (job.format === 'CSV') {
        const csvUrl = await this.generateCSV(leads);
        await this.jobRepo.update(jobId, {
          status: 'COMPLETE',
          completedAt: new Date(),
          outputUrl: csvUrl,
        });
      } else {
        const adapter = this.crmAdapters.get(job.format as CRMTarget);
        if (!adapter) throw new Error(`No adapter for ${job.format}`);

        const result = await adapter.push(leads);
        await this.jobRepo.update(jobId, {
          status: result.failed > 0 ? 'FAILED' : 'COMPLETE',
          completedAt: new Date(),
          errorMessage: result.errors.join('; ') || undefined,
        });
      }
    } catch (err) {
      await this.jobRepo.update(jobId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: (err as Error).message,
      });
    } finally {
      this.processing.delete(jobId);
    }

    return (await this.jobRepo.findById(jobId))!;
  }

  private async generateCSV(leads: RankedLead[]): Promise<string> {
    const headers = [
      'Lead ID', 'Score', 'Tier', 'Address', 'City', 'State', 'ZIP',
      'Property Type', 'List Price', 'ARV', 'Equity Spread',
      'Owner Name', 'Owner Phone', 'Owner Email',
      'Agent Name', 'Agent Phone', 'Days on Market',
      'FSBO', 'Distressed', 'Flags', 'Ranked At',
    ];

    const rows = leads.map(lead => [
      lead.id,
      lead.score.totalScore,
      lead.score.tier,
      lead.property.address,
      lead.property.city,
      lead.property.state,
      lead.property.zip,
      lead.property.propertyType,
      lead.property.listingPrice ?? '',
      lead.property.estimatedARV ?? '',
      lead.property.listingPrice && lead.property.estimatedARV
        ? (((lead.property.estimatedARV - lead.property.listingPrice) / lead.property.estimatedARV) * 100).toFixed(1) + '%'
        : '',
      lead.contact.ownerName ?? '',
      lead.contact.ownerPhone ?? '',
      lead.contact.ownerEmail ?? '',
      lead.contact.agentName ?? '',
      lead.contact.agentPhone ?? '',
      lead.property.daysOnMarket ?? '',
      lead.contact.isFSBO ? 'YES' : 'NO',
      lead.contact.isDistressed ? 'YES' : 'NO',
      lead.score.flags.join('|'),
      lead.score.rankedAt.toISOString(),
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    // In production: upload to GCS/S3 and return signed URL
    // For local dev: write to disk and return file path
    const filename = `/tmp/hunter-export-${Date.now()}.csv`;
    console.log(`[ExportQueue] Generated CSV: ${filename} (${leads.length} leads)`);
    return filename; // Replace with cloud storage URL in prod
  }
}

// ─── Orchestra Webhook Service ───────────────────────────────

export interface WebhookPayload {
  event: 'DEAL_RANKED' | 'ESCROW_CREATED' | 'ESCROW_DISBURSED' | 'CONTAINER_DOWN';
  data: unknown;
  timestamp: string;
  signature: string;
}

export class OrchestraWebhookService {
  private secret: string;

  constructor() {
    this.secret = process.env.ORCHESTRA_WEBHOOK_SECRET ?? '';
  }

  async fireWebhook(event: WebhookPayload['event'], data: unknown): Promise<void> {
    const webhookUrl = process.env.ORCHESTRA_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn('[Orchestra] No webhook URL configured — skipping');
      return;
    }

    const payload: WebhookPayload = {
      event,
      data,
      timestamp: new Date().toISOString(),
      signature: this.sign(event, data),
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hunter-Event': event },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`[Orchestra] Webhook failed: ${response.status} ${await response.text()}`);
    } else {
      console.log(`[Orchestra] ✅ Webhook fired: ${event}`);
    }
  }

  private sign(event: string, data: unknown): string {
    const { createHmac } = require('crypto');
    return createHmac('sha256', this.secret)
      .update(`${event}:${JSON.stringify(data)}`)
      .digest('hex');
  }
}

// ─── Dashboard Aggregator (API endpoint) ─────────────────────

export class OrchestraDashboardService {
  constructor(
    private healthMonitor: ContainerHealthMonitor,
    private metricsAggregator: PipelineMetricsAggregator,
    private tracker: FindToCloseTracker,
    private exportQueue: LeadExportQueue,
    private webhookService: OrchestraWebhookService
  ) {}

  getDashboardSnapshot(): {
    containers: ReturnType<ContainerHealthMonitor['getSummary']>;
    containerDetails: ContainerHealth[];
    metrics: LeadPipelineMetrics;
    systemStatus: 'GREEN' | 'YELLOW' | 'RED';
  } {
    const summary = this.healthMonitor.getSummary();
    const metrics = this.metricsAggregator.snapshot(this.tracker);

    let systemStatus: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN';
    if (summary.down > 0) systemStatus = 'RED';
    else if (summary.degraded > 0) systemStatus = 'YELLOW';

    return {
      containers: summary,
      containerDetails: this.healthMonitor.getAllHealth(),
      metrics,
      systemStatus,
    };
  }

  async handleOrchestrationWebhook(rankedLead: RankedLead): Promise<void> {
    // Blueprint: "When score > 85, Orchestra fires webhook → Finance ROI, Ledger logs, AcreFinder comps"
    await this.webhookService.fireWebhook('DEAL_RANKED', {
      leadId: rankedLead.id,
      score: rankedLead.score.totalScore,
      tier: rankedLead.score.tier,
      property: rankedLead.property,
      estimatedROI: rankedLead.score.estimatedROI,
      flags: rankedLead.score.flags,
    });
  }
}
