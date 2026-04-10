// ============================================================
// Hunter Real Estate System — Shared Type Definitions
// Titan Universal AI / TUAI Architecture
// ============================================================

// ─── Lead & Property Core Types ─────────────────────────────

export type MarketSource = 'MLS' | 'COUNTY_RECORDS' | 'ZILLOW' | 'REDFIN' | 'LOOPNET' | 'CUSTOM';
export type PropertyType = 'SFR' | 'MFR' | 'COMMERCIAL' | 'LAND' | 'MIXED_USE';
export type LeadStatus = 'RAW' | 'EXTRACTED' | 'RANKED' | 'EXPORTED' | 'IN_ESCROW' | 'CLOSED';
export type DealTier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface RawLead {
  id: string;
  source: MarketSource;
  sourceUrl: string;
  rawHtml?: string;
  rawText?: string;
  crawledAt: Date;
  adapterVersion: string;
  marketRegion: string;
  batchId: string;
}

export interface PropertySpec {
  address: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
  parcelId?: string;
  propertyType: PropertyType;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
  lotSize?: number;
  yearBuilt?: number;
  listingPrice?: number;
  estimatedARV?: number;  // After Repair Value
  estimatedRepairCost?: number;
  daysOnMarket?: number;
  pricePerSqft?: number;
  zoning?: string;
  taxAssessedValue?: number;
  liens?: number;
  mlsId?: string;
}

export interface ContactInfo {
  ownerName?: string;
  ownerPhone?: string;
  ownerEmail?: string;
  agentName?: string;
  agentPhone?: string;
  agentEmail?: string;
  agentBrokerage?: string;
  isFSBO: boolean;
  isDistressed: boolean;
  absenteeOwner?: boolean;
  ownerMailingAddress?: string;
}

export interface ExtractedLead {
  id: string;
  rawLeadId: string;
  property: PropertySpec;
  contact: ContactInfo;
  extractedAt: Date;
  extractionModel: string;
  extractionConfidence: number; // 0-1
  status: LeadStatus;
}

// ─── DealRanker Types ────────────────────────────────────────

export interface InvestmentParameters {
  targetMaxPurchasePrice: number;
  targetMinROI: number;          // percentage
  targetMinCashOnCash: number;   // percentage
  maxRepairBudget: number;
  targetMarkets: string[];       // zip codes or regions
  preferredPropertyTypes: PropertyType[];
  dealStrategyWeights: DealStrategyWeights;
}

export interface DealStrategyWeights {
  equitySpread: number;      // (ARV - listPrice) / ARV
  distressSignals: number;   // liens, foreclosure, tax delinquent
  daysOnMarket: number;      // longer = more motivated seller
  contactability: number;    // has direct owner contact
  locationScore: number;     // target market match
  cashFlowPotential: number; // rent estimate vs PITI
}

export interface DealScore {
  leadId: string;
  totalScore: number;        // 0-1000
  tier: DealTier;
  breakdown: {
    equitySpread: number;
    distressSignals: number;
    daysOnMarket: number;
    contactability: number;
    locationScore: number;
    cashFlowPotential: number;
  };
  estimatedROI?: number;
  estimatedCashOnCash?: number;
  rankedAt: Date;
  flags: DealFlag[];
}

export type DealFlag =
  | 'MOTIVATED_SELLER'
  | 'BELOW_MARKET_20PCT'
  | 'LIENS_DETECTED'
  | 'PROBATE'
  | 'FORECLOSURE'
  | 'VACANT'
  | 'ABSENTEE_OWNER'
  | 'FSBO'
  | 'PRICE_REDUCED'
  | 'HIGH_DOM';

export interface RankedLead extends ExtractedLead {
  score: DealScore;
}

// ─── Adapter / Crawler Config Types ─────────────────────────

export interface AdapterConfig {
  id: string;
  market: MarketSource;
  name: string;
  version: string;
  baseUrl: string;
  searchUrl: string;
  rateLimit: RateLimitConfig;
  selectors: SelectorMap;
  pagination: PaginationConfig;
  auth?: AuthConfig;
  headers?: Record<string, string>;
  proxy?: ProxyConfig;
}

export interface SelectorMap {
  listingContainer: string;
  address?: string;
  price?: string;
  beds?: string;
  baths?: string;
  sqft?: string;
  daysOnMarket?: string;
  agentName?: string;
  agentPhone?: string;
  mlsId?: string;
  nextPage?: string;
  totalCount?: string;
  [key: string]: string | undefined;
}

export interface PaginationConfig {
  type: 'URL_PARAM' | 'CURSOR' | 'OFFSET' | 'SCROLL';
  paramName?: string;
  pageSize: number;
  maxPages: number;
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerHour: number;
  delayBetweenRequestsMs: number;
  jitterMs: number;
}

export interface AuthConfig {
  type: 'API_KEY' | 'OAUTH2' | 'SESSION_COOKIE' | 'BASIC';
  credentials: Record<string, string>; // pulled from env
}

export interface ProxyConfig {
  enabled: boolean;
  rotationStrategy: 'ROUND_ROBIN' | 'RANDOM' | 'STICKY';
  proxyListEnvKey: string;
}

// ─── Escrow / Wallet Types ───────────────────────────────────

export type WalletTxType = 'DEPOSIT' | 'ESCROW_LOCK' | 'DISBURSEMENT' | 'REFUND' | 'FEE';
export type EscrowStatus = 'PENDING' | 'FUNDED' | 'CONDITIONS_MET' | 'DISBURSED' | 'DISPUTED' | 'CANCELLED';

export interface TitanWallet {
  walletId: string;
  userId: string;
  balance: number;
  currency: 'USD';
  stripeCustomerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EscrowAgreement {
  escrowId: string;
  dealId: string;
  buyerWalletId: string;
  sellerWalletId: string;
  amount: number;
  currency: 'USD';
  conditions: EscrowCondition[];
  status: EscrowStatus;
  multiSigTokens: MultiSigToken[];
  createdAt: Date;
  disbursedAt?: Date;
  expiresAt: Date;
}

export interface EscrowCondition {
  conditionId: string;
  description: string;
  verificationMethod: 'MANUAL' | 'DOCUMENT_UPLOAD' | 'API_WEBHOOK' | 'ORACLE';
  isMet: boolean;
  metAt?: Date;
  metByUserId?: string;
}

export interface MultiSigToken {
  tokenId: string;
  signerUserId: string;
  signerRole: 'BUYER' | 'SELLER' | 'TITAN_ADMIN' | 'TITLE_CO';
  signature?: string;   // SHA-256 HMAC
  signedAt?: Date;
  required: boolean;
}

export interface WalletTransaction {
  txId: string;
  walletId: string;
  type: WalletTxType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  relatedEscrowId?: string;
  stripePaymentIntentId?: string;
  description: string;
  createdAt: Date;
}

// ─── Pipeline / Queue Types ──────────────────────────────────

export interface PipelineMessage<T = unknown> {
  messageId: string;
  topic: PipelineTopic;
  payload: T;
  metadata: {
    batchId: string;
    retryCount: number;
    producedAt: Date;
    source: string;
  };
}

export type PipelineTopic =
  | 'hunter.raw.leads'
  | 'hunter.extraction.queue'
  | 'hunter.ranking.queue'
  | 'hunter.ranked.leads'
  | 'hunter.export.queue'
  | 'hunter.escrow.events'
  | 'hunter.system.health';

// ─── Dashboard / Monitoring Types ───────────────────────────

export interface ContainerHealth {
  containerId: string;
  serviceName: string;
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  cpuPercent: number;
  memoryMb: number;
  uptimeSeconds: number;
  lastHeartbeat: Date;
  errorCount1h: number;
}

export interface LeadPipelineMetrics {
  windowStart: Date;
  windowEnd: Date;
  crawled: number;
  extracted: number;
  ranked: number;
  exported: number;
  inEscrow: number;
  closed: number;
  avgFindToCloseHours?: number;
  avgDealScore: number;
  topTierCount: number; // S + A tier
}

export interface ExportJob {
  jobId: string;
  format: 'CSV' | 'JSON' | 'HUBSPOT' | 'SALESFORCE' | 'FOLLOWUPBOSS' | 'PODIO';
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
  leadIds: string[];
  filters?: Partial<InvestmentParameters>;
  outputUrl?: string;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}
