import express from 'express';
import type { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Pool } from 'pg';
import { randomUUID, createHmac } from 'crypto';
import * as fs from 'fs';

// ============================================================
// 1. COMPREHENSIVE TUAI ARCHITECTURE SHARED TYPES
// ============================================================

export type MarketSource = 'MLS' | 'COUNTY_RECORDS' | 'ZILLOW' | 'REDFIN' | 'LOOPNET' | 'CUSTOM';
export type PropertyType = 'SFR' | 'MFR' | 'COMMERCIAL' | 'LAND' | 'MIXED_USE';
export type LeadStatus = 'RAW' | 'EXTRACTED' | 'RANKED' | 'EXPORTED' | 'IN_ESCROW' | 'CLOSED';
export type DealTier = 'S' | 'A' | 'B' | 'C' | 'D';
export type WalletTxType = 'DEPOSIT' | 'ESCROW_LOCK' | 'DISBURSEMENT' | 'REFUND' | 'FEE';
export type EscrowStatus = 'PENDING' | 'FUNDED' | 'CONDITIONS_MET' | 'DISBURSED' | 'DISPUTED' | 'CANCELLED';
export type PipelineTopic = 'hunter.raw.leads' | 'hunter.extraction.queue' | 'hunter.ranking.queue' | 'hunter.ranked.leads' | 'hunter.export.queue' | 'hunter.escrow.events' | 'hunter.system.health';
export type DealFlag = 'MOTIVATED_SELLER' | 'BELOW_MARKET_20PCT' | 'LIENS_DETECTED' | 'PROBATE' | 'FORECLOSURE' | 'VACANT' | 'ABSENTEE_OWNER' | 'FSBO' | 'PRICE_REDUCED' | 'HIGH_DOM';

export interface RawLead {
  id: string; source: MarketSource; sourceUrl: string; rawHtml?: string; rawText?: string;
  crawledAt: Date; adapterVersion: string; marketRegion: string; batchId: string;
}

export interface PropertySpec {
  address: string; city: string; state: string; zip: string; county?: string; parcelId?: string;
  propertyType: PropertyType; bedrooms?: number; bathrooms?: number; sqft?: number; lotSize?: number;
  yearBuilt?: number; listingPrice?: number; estimatedARV?: number; estimatedRepairCost?: number;
  daysOnMarket?: number; pricePerSqft?: number; zoning?: string; taxAssessedValue?: number; liens?: number; mlsId?: string;
}

export interface ContactInfo {
  ownerName?: string; ownerPhone?: string; ownerEmail?: string; agentName?: string; agentPhone?: string;
  agentEmail?: string; agentBrokerage?: string; isFSBO: boolean; isDistressed: boolean; absenteeOwner?: boolean; ownerMailingAddress?: string;
}

export interface ExtractedLead {
  id: string; rawLeadId: string; property: PropertySpec; contact: ContactInfo; extractedAt: Date;
  extractionModel: string; extractionConfidence: number; status: LeadStatus;
}

export interface DealStrategyWeights {
  equitySpread: number; distressSignals: number; daysOnMarket: number; contactability: number; locationScore: number; cashFlowPotential: number;
}

export interface InvestmentParameters {
  targetMaxPurchasePrice: number; targetMinROI: number; targetMinCashOnCash: number; maxRepairBudget: number;
  targetMarkets: string[]; preferredPropertyTypes: PropertyType[]; dealStrategyWeights: DealStrategyWeights;
}

export interface DealScore {
  leadId: string; totalScore: number; tier: DealTier; breakdown: DealStrategyWeights;
  estimatedROI?: number; estimatedCashOnCash?: number; rankedAt: Date; flags: DealFlag[];
}

export interface RankedLead extends ExtractedLead {
  score: DealScore;
}

export interface TitanWallet {
  walletId: string; userId: string; balance: number; currency: 'USD'; stripeCustomerId: string; createdAt: Date; updatedAt: Date;
}

export interface EscrowCondition {
  conditionId: string; description: string; verificationMethod: 'MANUAL' | 'DOCUMENT_UPLOAD' | 'API_WEBHOOK' | 'ORACLE'; isMet: boolean; metAt?: Date; metByUserId?: string;
}

export interface MultiSigToken {
  tokenId: string; signerUserId: string; signerRole: 'BUYER' | 'SELLER' | 'TITAN_ADMIN' | 'TITLE_CO'; signature?: string; signedAt?: Date; required: boolean;
}

export interface EscrowAgreement {
  escrowId: string; dealId: string; buyerWalletId: string; sellerWalletId: string; amount: number; currency: 'USD';
  conditions: EscrowCondition[]; status: EscrowStatus; multiSigTokens: MultiSigToken[]; createdAt: Date; disbursedAt?: Date; expiresAt: Date;
}

export interface WalletTransaction {
  txId: string; walletId: string; type: WalletTxType; amount: number; balanceBefore: number; balanceAfter: number;
  relatedEscrowId?: string; stripePaymentIntentId?: string; description: string; createdAt: Date;
}

export interface PipelineMessage<T = unknown> {
  messageId: string; topic: PipelineTopic; payload: T; metadata: { batchId: string; retryCount: number; producedAt: Date; source: string; };
}

export interface ContainerHealth {
  containerId: string; serviceName: string; status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; cpuPercent: number; memoryMb: number; uptimeSeconds: number; lastHeartbeat: Date; errorCount1h: number;
}

export interface LeadPipelineMetrics {
  windowStart: Date; windowEnd: Date; crawled: number; extracted: number; ranked: number; exported: number; inEscrow: number; closed: number; avgFindToCloseHours?: number; avgDealScore: number; topTierCount: number;
}

export interface ExportJob {
  jobId: string; format: 'CSV' | 'JSON' | 'HUBSPOT' | 'SALESFORCE' | 'FOLLOWUPBOSS' | 'PODIO'; status: 'QUEUED' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
  leadIds: string[]; filters?: Partial<InvestmentParameters>; outputUrl?: string; createdAt: Date; completedAt?: Date; errorMessage?: string;
}

// ============================================================
// 2. HIGH-PERFORMANCE DATABASE INFRASTRUCTURE CONFIGURATION
// ============================================================
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/hunter',
  max: 30,
  idleTimeoutMillis: 15000,
  connectionTimeoutMillis: 5000
});

// ============================================================
// 3. FULL CONCRETE POSTGRESQL DATA REPOSITORIES (MAPPED TO SCHEMA)
// ============================================================

export class PostgresWalletRepository {
  async findById(walletId: string): Promise<TitanWallet | null> {
    const res = await dbPool.query('SELECT * FROM titan_wallets WHERE wallet_id = $1', [walletId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return { walletId: r.wallet_id, userId: r.user_id, balance: Number(r.balance), currency: r.currency, stripeCustomerId: r.stripe_customer_id, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  async findByUserId(userId: string): Promise<TitanWallet | null> {
    const res = await dbPool.query('SELECT * FROM titan_wallets WHERE user_id = $1', [userId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return { walletId: r.wallet_id, userId: r.user_id, balance: Number(r.balance), currency: r.currency, stripeCustomerId: r.stripe_customer_id, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  async create(wallet: TitanWallet): Promise<TitanWallet> {
    await dbPool.query(
      `INSERT INTO titan_wallets (wallet_id, user_id, balance, currency, stripe_customer_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [wallet.walletId, wallet.userId, wallet.balance, wallet.currency, wallet.stripeCustomerId, wallet.createdAt, wallet.updatedAt]
    );
    return wallet;
  }

  async updateBalance(walletId: string, newBalance: number, updatedAt: Date): Promise<void> {
    await dbPool.query('UPDATE titan_wallets SET balance = $1, updated_at = $2 WHERE wallet_id = $3', [newBalance, updatedAt, walletId]);
  }
}

export class PostgresEscrowRepository {
  async findById(escrowId: string): Promise<EscrowAgreement | null> {
    const res = await dbPool.query('SELECT * FROM escrow_agreements WHERE escrow_id = $1', [escrowId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      escrowId: r.escrow_id, dealId: r.deal_id, buyerWalletId: r.buyer_wallet_id, sellerWalletId: r.seller_wallet_id,
      amount: Number(r.amount), currency: r.currency, conditions: r.conditions, status: r.status,
      multiSigTokens: r.multi_sig_tokens, createdAt: r.created_at, disbursedAt: r.disbursed_at ? r.disbursed_at : undefined, expiresAt: r.expires_at
    };
  }

  async create(agreement: EscrowAgreement): Promise<EscrowAgreement> {
    await dbPool.query(
      `INSERT INTO escrow_agreements (escrow_id, deal_id, buyer_wallet_id, seller_wallet_id, amount, currency, conditions, status, multi_sig_tokens, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [agreement.escrowId, agreement.dealId, agreement.buyerWalletId, agreement.sellerWalletId, agreement.amount, agreement.currency, JSON.stringify(agreement.conditions), agreement.status, JSON.stringify(agreement.multiSigTokens), agreement.createdAt, agreement.expiresAt]
    );
    return agreement;
  }

  async updateStatus(escrowId: string, status: EscrowStatus): Promise<void> {
    const disbursedAt = status === 'DISBURSED' ? new Date() : null;
    if (disbursedAt) {
      await dbPool.query('UPDATE escrow_agreements SET status = $1, disbursed_at = $2 WHERE escrow_id = $3', [status, disbursedAt, escrowId]);
    } else {
      await dbPool.query('UPDATE escrow_agreements SET status = $1 WHERE escrow_id = $2', [status, escrowId]);
    }
  }

  async updateCondition(escrowId: string, conditionId: string, isMet: boolean, metAt: Date, metByUserId: string): Promise<void> {
    const agreement = await this.findById(escrowId);
    if (!agreement) return;
    const updatedConditions = agreement.conditions.map(c => c.conditionId === conditionId ? { ...c, isMet, metAt, metByUserId } : c);
    await dbPool.query('UPDATE escrow_agreements SET conditions = $1 WHERE escrow_id = $2', [JSON.stringify(updatedConditions), escrowId]);
  }

  async addSignature(escrowId: string, tokenId: string, signature: string, signedAt: Date): Promise<void> {
    const agreement = await this.findById(escrowId);
    if (!agreement) return;
    const updatedTokens = agreement.multiSigTokens.map(t => t.tokenId === tokenId ? { ...t, signature, signedAt } : t);
    await dbPool.query('UPDATE escrow_agreements SET multi_sig_tokens = $1 WHERE escrow_id = $2', [JSON.stringify(updatedTokens), escrowId]);
  }
}

export class PostgresTransactionRepository {
  async create(tx: WalletTransaction): Promise<WalletTransaction> {
    await dbPool.query(
      `INSERT INTO wallet_transactions (tx_id, wallet_id, type, amount, balance_before, balance_after, related_escrow_id, stripe_payment_intent_id, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tx.txId, tx.walletId, tx.type, tx.amount, tx.balanceBefore, tx.balanceAfter, tx.relatedEscrowId, tx.stripePaymentIntentId, tx.description, tx.createdAt]
    );
    return tx;
  }

  async findByWalletId(walletId: string): Promise<WalletTransaction[]> {
    const res = await dbPool.query('SELECT * FROM wallet_transactions WHERE wallet_id = $1 ORDER BY created_at DESC', [walletId]);
    return res.rows.map(r => ({ txId: r.tx_id, walletId: r.wallet_id, type: r.type as WalletTxType, amount: Number(r.amount), balanceBefore: Number(r.balance_before), balanceAfter: Number(r.balance_after), relatedEscrowId: r.related_escrow_id, stripePaymentIntentId: r.stripe_payment_intent_id, description: r.description, createdAt: r.created_at }));
  }

  async findByEscrowId(escrowId: string): Promise<WalletTransaction[]> {
    const res = await dbPool.query('SELECT * FROM wallet_transactions WHERE related_escrow_id = $1 ORDER BY created_at DESC', [escrowId]);
    return res.rows.map(r => ({ txId: r.tx_id, walletId: r.wallet_id, type: r.type as WalletTxType, amount: Number(r.amount), balanceBefore: Number(r.balance_before), balanceAfter: Number(r.balance_after), relatedEscrowId: r.related_escrow_id, stripePaymentIntentId: r.stripe_payment_intent_id, description: r.description, createdAt: r.created_at }));
  }
}

export class PostgresExportJobRepository {
  async create(job: ExportJob): Promise<ExportJob> {
    await dbPool.query(
      `INSERT INTO export_jobs (job_id, format, status, lead_ids, output_url, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [job.jobId, job.format, job.status, job.leadIds, job.outputUrl, job.errorMessage, job.createdAt]
    );
    return job;
  }

  async update(jobId: string, updates: Partial<ExportJob>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const assignments = fields.map((f, i) => `${f.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)} = $${i + 2}`).join(', ');
    const values = Object.values(updates);
    await dbPool.query(`UPDATE export_jobs SET ${assignments} WHERE job_id = $1`, [jobId, ...values]);
  }

  async findById(jobId: string): Promise<ExportJob | null> {
    const res = await dbPool.query('SELECT * FROM export_jobs WHERE job_id = $1', [jobId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return { jobId: r.job_id, format: r.format, status: r.status, leadIds: r.lead_ids, outputUrl: r.output_url, errorMessage: r.error_message, createdAt: r.created_at, completedAt: r.completed_at };
  }

  async findPending(): Promise<ExportJob[]> {
    const res = await dbPool.query("SELECT * FROM export_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC");
    return res.rows.map(r => ({ jobId: r.job_id, format: r.format, status: r.status, leadIds: r.lead_ids, outputUrl: r.output_url, errorMessage: r.error_message, createdAt: r.created_at, completedAt: r.completed_at }));
  }
}

export class PostgresRankedLeadRepository {
  async findByIds(ids: string[]): Promise<RankedLead[]> {
    if (ids.length === 0) return [];
    const res = await dbPool.query(
      `SELECT r.*, e.raw_lead_id, e.property, e.contact, e.extracted_at, e.extraction_model, e.extraction_confidence, e.status as estatus
       FROM ranked_leads r JOIN extracted_leads e ON r.id = e.id WHERE r.id = ANY($1)`, [ids]
    );
    return res.rows.map(r => ({
      id: r.id, rawLeadId: r.raw_lead_id, property: r.property, contact: r.contact, extractedAt: r.extracted_at,
      extractionModel: r.extraction_model, extractionConfidence: Number(r.extraction_confidence), status: r.estatus as LeadStatus,
      score: { leadId: r.id, totalScore: r.total_score, tier: r.tier as DealTier, breakdown: r.score_breakdown, estimatedROI: r.estimated_roi ? Number(r.estimated_roi) : undefined, estimatedCashOnCash: r.estimated_coc ? Number(r.estimated_coc) : undefined, rankedAt: r.ranked_at, flags: r.flags }
    }));
  }

  async findByTier(tier: DealTier): Promise<RankedLead[]> {
    const res = await dbPool.query(
      `SELECT r.*, e.raw_lead_id, e.property, e.contact, e.extracted_at, e.extraction_model, e.extraction_confidence, e.status as estatus
       FROM ranked_leads r JOIN extracted_leads e ON r.id = e.id WHERE r.tier = $1 ORDER BY r.total_score DESC`, [tier]
    );
    return res.rows.map(r => ({
      id: r.id, rawLeadId: r.raw_lead_id, property: r.property, contact: r.contact, extractedAt: r.extracted_at,
      extractionModel: r.extraction_model, extractionConfidence: Number(r.extraction_confidence), status: r.estatus as LeadStatus,
      score: { leadId: r.id, totalScore: r.total_score, tier: r.tier as DealTier, breakdown: r.score_breakdown, estimatedROI: r.estimated_roi ? Number(r.estimated_roi) : undefined, estimatedCashOnCash: r.estimated_coc ? Number(r.estimated_coc) : undefined, rankedAt: r.ranked_at, flags: r.flags }
    }));
  }
}

// ============================================================
// 4. PRODUCTION THIRD-PARTY PRODUCTION CRM ADAPTERS
// ============================================================

export class HubSpotCRMAdapter {
  readonly target = 'HUBSPOT';
  private token = process.env.HUBSPOT_ACCESS_TOKEN ?? 'mock_hubspot_token';

  async push(leads: RankedLead[]) {
    let pushed = 0, failed = 0;
    const errors: string[] = [];
    for (const lead of leads) {
      try {
        const payload = {
          properties: {
            firstname: lead.contact.ownerName?.split(' ')[0] ?? 'Absentee',
            lastname: lead.contact.ownerName?.split(' ').slice(1).join(' ') ?? 'Owner',
            phone: lead.contact.ownerPhone ?? '',
            email: lead.contact.ownerEmail ?? '',
            address: lead.property.address,
            city: lead.property.city,
            state: lead.property.state,
            zip: lead.property.zip,
            titan_deal_score: String(lead.score.totalScore),
            titan_deal_tier: lead.score.tier
          }
        };
        const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`HubSpot API Failure: ${res.status} - ${await res.text()}`);
        pushed++;
      } catch (e) {
        failed++; errors.push((e as Error).message);
      }
    }
    return { pushed, failed, errors };
  }
}

export class SalesforceCRMAdapter {
  readonly target = 'SALESFORCE';
  private instanceUrl = process.env.SF_INSTANCE_URL ?? 'https://login.salesforce.com';
  private token = process.env.SF_OAUTH_TOKEN ?? 'mock_salesforce_token';

  async push(leads: RankedLead[]) {
    let pushed = 0, failed = 0;
    const errors: string[] = [];
    for (const lead of leads) {
      try {
        const payload = {
          LastName: lead.contact.ownerName ?? 'Titan Lead',
          Company: 'TitanHunter Pipeline Ingest',
          Phone: lead.contact.ownerPhone ?? '',
          Email: lead.contact.ownerEmail ?? '',
          Street: lead.property.address,
          City: lead.property.city,
          State: lead.property.state,
          PostalCode: lead.property.zip,
          Description: `Titan Analytics Engine Ingest: Score ${lead.score.totalScore} Tier ${lead.score.tier}`
        };
        const res = await fetch(`${this.instanceUrl}/services/data/v57.0/sobjects/Lead`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Salesforce API Failure: ${res.status} - ${await res.text()}`);
        pushed++;
      } catch (e) {
        failed++; errors.push((e as Error).message);
      }
    }
    return { pushed, failed, errors };
  }
}

// ============================================================
// 5. PRODUCTION STRIPE SETTLMENT RAIL IMPLEMENTATION
// ============================================================

export class StripePaymentRail {
  private key = process.env.STRIPE_SECRET_KEY ?? 'mock_stripe_key';
  private url = 'https://api.stripe.com/v1';

  private async post(endpoint: string, data: Record<string, string>): Promise<any> {
    const params = new URLSearchParams(data);
    const res = await fetch(`${this.url}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!res.ok) {
      const errorPayload = await res.json() as { error?: { message: string } };
      throw new Error(`Stripe Native Fail: ${errorPayload.error?.message ?? 'Unknown'}`);
    }
    return res.json();
  }

  async createCustomer(userId: string, email: string): Promise<string> {
    const data = await this.post('/customers', { email, 'metadata[titanUserId]': userId });
    return data.id;
  }

  async createPaymentIntent(amount: number, currency: string, customerId: string, metadata: Record<string, string>): Promise<{ id: string; clientSecret: string }> {
    const payload: Record<string, string> = { amount: String(Math.round(amount * 100)), currency, customer: customerId, capture_method: 'manual' };
    Object.entries(metadata).forEach(([k, v]) => { payload[`metadata[${k}]`] = v; });
    const data = await this.post('/payment_intents', payload);
    return { id: data.id, clientSecret: data.client_secret };
  }

  async capturePayment(paymentIntentId: string): Promise<void> {
    await this.post(`/payment_intents/${paymentIntentId}/capture`, {});
  }

  async refund(paymentIntentId: string, amount?: number): Promise<void> {
    const payload: Record<string, string> = { payment_intent: paymentIntentId };
    if (amount) payload.amount = String(Math.round(amount * 100));
    await this.post('/refunds', payload);
  }

  async transferToBank(amount: number, destinationAccountId: string, description: string): Promise<string> {
    const data = await this.post('/transfers', { amount: String(Math.round(amount * 100)), currency: 'usd', destination: destinationAccountId, description });
    return data.id;
  }
}

// ============================================================
// 6. CRYPTOGRAPHIC MULTI-SIG HMAC MANAGEMENT
// ============================================================

export class MultiSigManager {
  private secret = process.env.TITAN_MULTISIG_SECRET ?? 'titan_universal_secret_hmac';

  sign(escrowId: string, tokenId: string, signerUserId: string): string {
    const payload = `${escrowId}:${tokenId}:${signerUserId}:${Date.now().toString()}`;
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  verify(signature: string, escrowId: string, tokenId: string, signerUserId: string, timestamp: string): boolean {
    const payload = `${escrowId}:${tokenId}:${signerUserId}:${timestamp}`;
    const expected = createHmac('sha256', this.secret).update(payload).digest('hex');
    if (signature.length !== expected.length) return false;
    let match = 0;
    for (let i = 0; i < signature.length; i++) {
      match |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return match === 0;
  }

  allRequiredSignaturesPresent(tokens: MultiSigToken[]): boolean {
    return tokens.filter(t => t.required).every(t => !!t.signature);
  }
}

// ============================================================
// 7. CORE SETTLEMENT LAYER INTERFACE LOGICS
// ============================================================

export class TitanWalletService {
  constructor(
    private walletRepo: PostgresWalletRepository,
    private txRepo: PostgresTransactionRepository,
    private stripe: StripePaymentRail
  ) {}

  async createWallet(userId: string, email: string): Promise<TitanWallet> {
    const existing = await this.walletRepo.findByUserId(userId);
    if (existing) return existing;
    const stripeCustomerId = await this.stripe.createCustomer(userId, email);
    const wallet: TitanWallet = { walletId: randomUUID(), userId, balance: 0, currency: 'USD', stripeCustomerId, createdAt: new Date(), updatedAt: new Date() };
    return this.walletRepo.create(wallet);
  }

  async deposit(walletId: string, amount: number): Promise<WalletTransaction> {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) throw new Error(`Wallet node missing: ${walletId}`);
    const intent = await this.stripe.createPaymentIntent(amount, 'usd', wallet.stripeCustomerId, { walletId, type: 'DEPOSIT' });
    await this.stripe.capturePayment(intent.id);
    const newBalance = wallet.balance + amount;
    await this.walletRepo.updateBalance(walletId, newBalance, new Date());
    return this.txRepo.create({ txId: randomUUID(), walletId, type: 'DEPOSIT', amount, balanceBefore: wallet.balance, balanceAfter: newBalance, stripePaymentIntentId: intent.id, description: `Direct Deposit Authorization $${amount}`, createdAt: new Date() });
  }

  async lockForEscrow(walletId: string, escrowId: string, amount: number): Promise<WalletTransaction> {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) throw new Error(`Wallet node missing: ${walletId}`);
    if (wallet.balance < amount) throw new Error(`Deficit liquidity state: ${wallet.balance} < ${amount}`);
    const newBalance = wallet.balance - amount;
    await this.walletRepo.updateBalance(walletId, newBalance, new Date());
    return this.txRepo.create({ txId: randomUUID(), walletId, type: 'ESCROW_LOCK', amount: -amount, balanceBefore: wallet.balance, balanceAfter: newBalance, relatedEscrowId: escrowId, description: `Multi-sig capital retention lock for escrow ${escrowId}`, createdAt: new Date() });
  }

  async disburse(walletId: string, escrowId: string, amount: number, destinationAccountId: string): Promise<WalletTransaction> {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) throw new Error(`Wallet node missing: ${walletId}`);
    const transferId = await this.stripe.transferToBank(amount, destinationAccountId, `Auto clearing escrow payout ${escrowId}`);
    return this.txRepo.create({ txId: randomUUID(), walletId, type: 'DISBURSE