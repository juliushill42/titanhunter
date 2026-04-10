// ============================================================
// MODULE B — AI Extraction & DealRanker Pipeline
// Hunter Real Estate System | TUAI Architecture
// Threshold: Score >= 850/1000 → Orchestra fires webhook
// ============================================================

import {
  RawLead,
  ExtractedLead,
  RankedLead,
  PropertySpec,
  ContactInfo,
  DealScore,
  DealTier,
  DealFlag,
  InvestmentParameters,
  DealStrategyWeights,
  PipelineMessage,
} from '../../shared/types';
import { randomUUID } from 'crypto';

// ─── Extraction Pipeline ─────────────────────────────────────

export interface ILLMClient {
  extract(prompt: string, systemPrompt: string): Promise<string>;
}

export interface IExtractionPublisher {
  publish(message: PipelineMessage<ExtractedLead | RankedLead>): Promise<void>;
}

/**
 * AI Extraction Pipeline
 * Consumes from: hunter.raw.leads
 * Produces to:   hunter.extraction.queue → hunter.ranking.queue
 *
 * Uses Claude 3.5 Sonnet (or GPT-4o) to parse raw HTML/text into
 * structured PropertySpec + ContactInfo records.
 */
export class AIExtractionPipeline {
  constructor(
    private llmClient: ILLMClient,
    private publisher: IExtractionPublisher
  ) {}

  private buildExtractionPrompt(raw: RawLead): string {
    const content = raw.rawText ?? this.stripHtml(raw.rawHtml ?? '');
    return `
Extract structured real estate listing data from the following content.
Return ONLY valid JSON matching the schema below. No markdown, no explanation.

CONTENT:
${content.slice(0, 8000)}

SCHEMA:
{
  "property": {
    "address": string,
    "city": string,
    "state": string,
    "zip": string,
    "county": string | null,
    "parcelId": string | null,
    "propertyType": "SFR" | "MFR" | "COMMERCIAL" | "LAND" | "MIXED_USE",
    "bedrooms": number | null,
    "bathrooms": number | null,
    "sqft": number | null,
    "lotSize": number | null,
    "yearBuilt": number | null,
    "listingPrice": number | null,
    "estimatedARV": number | null,
    "estimatedRepairCost": number | null,
    "daysOnMarket": number | null,
    "pricePerSqft": number | null,
    "zoning": string | null,
    "taxAssessedValue": number | null,
    "liens": number | null,
    "mlsId": string | null
  },
  "contact": {
    "ownerName": string | null,
    "ownerPhone": string | null,
    "ownerEmail": string | null,
    "agentName": string | null,
    "agentPhone": string | null,
    "agentEmail": string | null,
    "agentBrokerage": string | null,
    "isFSBO": boolean,
    "isDistressed": boolean,
    "absenteeOwner": boolean | null,
    "ownerMailingAddress": string | null
  },
  "extractionConfidence": number  // 0.0 - 1.0
}
`;
  }

  private buildSystemPrompt(): string {
    return `You are a real estate data extraction AI specialized in identifying investment opportunities.
Extract all available data precisely. If a field is not present in the content, return null.
Focus on signals of motivated sellers: distress, liens, vacancies, absentee ownership, price reductions.
Confidence score: 1.0 = all key fields present and unambiguous, 0.0 = minimal usable data.`;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  async process(rawLead: RawLead): Promise<ExtractedLead> {
    const prompt = this.buildExtractionPrompt(rawLead);
    const systemPrompt = this.buildSystemPrompt();

    let extracted: { property: PropertySpec; contact: ContactInfo; extractionConfidence: number };

    try {
      const response = await this.llmClient.extract(prompt, systemPrompt);
      extracted = JSON.parse(response);
    } catch (err) {
      throw new Error(`LLM extraction failed for ${rawLead.id}: ${(err as Error).message}`);
    }

    const extractedLead: ExtractedLead = {
      id: randomUUID(),
      rawLeadId: rawLead.id,
      property: extracted.property,
      contact: extracted.contact,
      extractedAt: new Date(),
      extractionModel: 'claude-sonnet-4-5',
      extractionConfidence: extracted.extractionConfidence ?? 0,
      status: 'EXTRACTED',
    };

    await this.publisher.publish({
      messageId: randomUUID(),
      topic: 'hunter.ranking.queue',
      payload: extractedLead,
      metadata: {
        batchId: rawLead.batchId,
        retryCount: 0,
        producedAt: new Date(),
        source: 'ai-extraction-pipeline',
      },
    });

    return extractedLead;
  }
}

// ─── Claude LLM Client (Production) ─────────────────────────

export class ClaudeLLMClient implements ILLMClient {
  private apiKey: string;
  private model: string;

  constructor(model = 'claude-sonnet-4-5') {
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    this.model = model;
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  }

  async extract(prompt: string, systemPrompt: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error ${response.status}: ${err}`);
    }

    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text block in Claude response');
    return textBlock.text;
  }
}

// ─── DealRanker Algorithm ────────────────────────────────────

/**
 * DealRanker — Titan's valuation model
 *
 * Scores each lead 0–1000 across 6 weighted dimensions.
 * Score >= 850 triggers Orchestra webhook (Finance ROI model,
 * Ledger logging, AcreFinder comp mapping).
 *
 * Based on: ARV spread, distress signals, DOM, contactability,
 * location match, and cash flow potential.
 */
export class DealRanker {
  // Orchestra webhook threshold — from blueprint
  static readonly ORCHESTRA_TRIGGER_SCORE = 850;

  constructor(private params: InvestmentParameters) {}

  /**
   * Primary scoring entry point.
   * Returns a fully scored RankedLead or null if below minimum viability.
   */
  rank(lead: ExtractedLead): RankedLead {
    const breakdown = this.computeBreakdown(lead);
    const weights = this.params.dealStrategyWeights;

    // Normalize weights to sum to 1.0
    const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
    const norm = (w: number) => w / totalWeight;

    const rawScore =
      breakdown.equitySpread     * norm(weights.equitySpread)     * 1000 +
      breakdown.distressSignals  * norm(weights.distressSignals)  * 1000 +
      breakdown.daysOnMarket     * norm(weights.daysOnMarket)     * 1000 +
      breakdown.contactability   * norm(weights.contactability)   * 1000 +
      breakdown.locationScore    * norm(weights.locationScore)    * 1000 +
      breakdown.cashFlowPotential * norm(weights.cashFlowPotential) * 1000;

    const totalScore = Math.round(Math.min(Math.max(rawScore, 0), 1000));
    const tier = this.scoreToDealTier(totalScore);
    const flags = this.detectFlags(lead);

    const score: DealScore = {
      leadId: lead.id,
      totalScore,
      tier,
      breakdown,
      estimatedROI: this.estimateROI(lead),
      estimatedCashOnCash: this.estimateCashOnCash(lead),
      rankedAt: new Date(),
      flags,
    };

    return {
      ...lead,
      score,
      status: 'RANKED',
    };
  }

  // ─── Dimension Scorers (0.0–1.0) ──────────────────────────

  private computeBreakdown(lead: ExtractedLead): DealScore['breakdown'] {
    return {
      equitySpread:      this.scoreEquitySpread(lead),
      distressSignals:   this.scoreDistressSignals(lead),
      daysOnMarket:      this.scoreDaysOnMarket(lead),
      contactability:    this.scoreContactability(lead),
      locationScore:     this.scoreLocation(lead),
      cashFlowPotential: this.scoreCashFlow(lead),
    };
  }

  /**
   * Equity Spread — (ARV - listingPrice) / ARV
   * 0.3+ spread = full score. Negative = 0.
   */
  private scoreEquitySpread(lead: ExtractedLead): number {
    const { listingPrice, estimatedARV } = lead.property;
    if (!listingPrice || !estimatedARV || estimatedARV <= 0) return 0.1;
    const spread = (estimatedARV - listingPrice) / estimatedARV;
    if (spread <= 0) return 0;
    if (spread >= 0.30) return 1.0;
    return spread / 0.30; // linear scale to 30%
  }

  /**
   * Distress Signals — liens, FSBO, distressed flag, absentee owner
   * Each signal adds weight.
   */
  private scoreDistressSignals(lead: ExtractedLead): number {
    let score = 0;
    const { contact, property } = lead;
    if (contact.isDistressed)         score += 0.35;
    if (contact.isFSBO)               score += 0.20;
    if (contact.absenteeOwner)        score += 0.20;
    if (property.liens && property.liens > 0) score += 0.15;
    if (property.taxAssessedValue &&
        property.listingPrice &&
        property.listingPrice < property.taxAssessedValue * 0.8) score += 0.10;
    return Math.min(score, 1.0);
  }

  /**
   * Days on Market — 0 DOM = 0 score (fresh listing, seller not motivated)
   * 90+ DOM = full score (highly motivated)
   */
  private scoreDaysOnMarket(lead: ExtractedLead): number {
    const dom = lead.property.daysOnMarket ?? 0;
    if (dom <= 0) return 0;
    if (dom >= 90) return 1.0;
    return dom / 90;
  }

  /**
   * Contactability — direct owner contact data present
   * Phone > email > agent only
   */
  private scoreContactability(lead: ExtractedLead): number {
    const { contact } = lead;
    let score = 0;
    if (contact.ownerPhone)  score += 0.50;
    if (contact.ownerEmail)  score += 0.30;
    if (contact.agentPhone)  score += 0.15;
    if (contact.agentEmail)  score += 0.05;
    return Math.min(score, 1.0);
  }

  /**
   * Location Score — is this ZIP/region in user's target markets?
   * Exact match = 1.0, partial state match = 0.5, no match = 0.1
   */
  private scoreLocation(lead: ExtractedLead): number {
    const { zip, state } = lead.property;
    const targets = this.params.targetMarkets;
    if (!targets.length) return 0.5; // No preference = neutral
    if (targets.includes(zip))   return 1.0;
    if (targets.some(t => t.toLowerCase() === state?.toLowerCase())) return 0.5;
    return 0.1;
  }

  /**
   * Cash Flow Potential — simplified GRM / rent estimate
   * Uses 1% rule: monthly rent should be >= 1% of purchase price
   * Rough estimate if no rental data: $1.25/sqft/month
   */
  private scoreCashFlow(lead: ExtractedLead): number {
    const { listingPrice, sqft } = lead.property;
    if (!listingPrice || listingPrice <= 0) return 0;
    const estimatedMonthlyRent = sqft ? sqft * 1.25 : listingPrice * 0.008;
    const onePercentRule = estimatedMonthlyRent / listingPrice;
    if (onePercentRule >= 0.01) return 1.0;
    if (onePercentRule <= 0.004) return 0;
    return (onePercentRule - 0.004) / 0.006;
  }

  // ─── ROI Estimators ────────────────────────────────────────

  private estimateROI(lead: ExtractedLead): number | undefined {
    const { listingPrice, estimatedARV, estimatedRepairCost } = lead.property;
    if (!listingPrice || !estimatedARV) return undefined;
    const totalCost = listingPrice + (estimatedRepairCost ?? 0);
    if (totalCost <= 0) return undefined;
    return ((estimatedARV - totalCost) / totalCost) * 100;
  }

  private estimateCashOnCash(lead: ExtractedLead): number | undefined {
    const { listingPrice, sqft } = lead.property;
    if (!listingPrice || !sqft) return undefined;
    const downPayment = listingPrice * 0.20;
    const closingCosts = listingPrice * 0.03;
    const totalCashIn = downPayment + closingCosts;
    const annualNOI = sqft * 1.25 * 12 * 0.65; // 65% expense ratio
    const annualDebtService = (listingPrice * 0.80) * (0.07 / 12) * 12; // 7% IO
    const annualCashFlow = annualNOI - annualDebtService;
    return (annualCashFlow / totalCashIn) * 100;
  }

  // ─── Flag Detection ────────────────────────────────────────

  private detectFlags(lead: ExtractedLead): DealFlag[] {
    const flags: DealFlag[] = [];
    const { property, contact } = lead;

    if (contact.isDistressed)   flags.push('MOTIVATED_SELLER');
    if (contact.isFSBO)         flags.push('FSBO');
    if (contact.absenteeOwner)  flags.push('ABSENTEE_OWNER');
    if (property.liens && property.liens > 0) flags.push('LIENS_DETECTED');
    if ((property.daysOnMarket ?? 0) >= 60)   flags.push('HIGH_DOM');

    if (property.listingPrice && property.estimatedARV) {
      const spread = (property.estimatedARV - property.listingPrice) / property.estimatedARV;
      if (spread >= 0.20) flags.push('BELOW_MARKET_20PCT');
    }

    return flags;
  }

  // ─── Tier Assignment ───────────────────────────────────────

  private scoreToDealTier(score: number): DealTier {
    if (score >= 850) return 'S'; // Orchestra webhook fires here
    if (score >= 700) return 'A';
    if (score >= 550) return 'B';
    if (score >= 400) return 'C';
    return 'D';
  }

  // ─── Batch Ranking ────────────────────────────────────────

  rankBatch(leads: ExtractedLead[]): RankedLead[] {
    return leads
      .map(l => this.rank(l))
      .sort((a, b) => b.score.totalScore - a.score.totalScore);
  }

  shouldTriggerOrchestra(rankedLead: RankedLead): boolean {
    return rankedLead.score.totalScore >= DealRanker.ORCHESTRA_TRIGGER_SCORE;
  }
}

// ─── DealRanker Pipeline Consumer ────────────────────────────

export interface IOrchestrator {
  fireWebhook(lead: RankedLead): Promise<void>;
}

export class RankingPipelineConsumer {
  constructor(
    private ranker: DealRanker,
    private publisher: IExtractionPublisher,
    private orchestrator: IOrchestrator
  ) {}

  async consume(message: PipelineMessage<ExtractedLead>): Promise<void> {
    const rankedLead = this.ranker.rank(message.payload);

    // Publish to ranked leads topic
    await this.publisher.publish({
      messageId: randomUUID(),
      topic: 'hunter.ranked.leads',
      payload: rankedLead,
      metadata: {
        ...message.metadata,
        producedAt: new Date(),
        source: 'deal-ranker',
      },
    });

    // Blueprint: score >= 85 (out of 100) triggers Orchestra
    // Our scale: 850/1000 = equivalent threshold
    if (this.ranker.shouldTriggerOrchestra(rankedLead)) {
      console.log(`[DealRanker] 🔥 S-Tier lead detected: ${rankedLead.id} (${rankedLead.score.totalScore})`);
      await this.orchestrator.fireWebhook(rankedLead);
    }
  }
}

// ─── Default Investment Parameters ───────────────────────────

export const DEFAULT_INVESTMENT_PARAMS: InvestmentParameters = {
  targetMaxPurchasePrice: 500_000,
  targetMinROI: 20,
  targetMinCashOnCash: 8,
  maxRepairBudget: 75_000,
  targetMarkets: [],
  preferredPropertyTypes: ['SFR', 'MFR'],
  dealStrategyWeights: {
    equitySpread:      0.30,
    distressSignals:   0.25,
    daysOnMarket:      0.15,
    contactability:    0.15,
    locationScore:     0.10,
    cashFlowPotential: 0.05,
  },
};
