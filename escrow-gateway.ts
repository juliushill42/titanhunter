// ============================================================
// MODULE C — Titan Settlement & Escrow Gateway
// Hunter Real Estate System | TUAI Architecture
// "Money moves at machine speed." — Titan Pay Blueprint
// ============================================================

import {
  TitanWallet,
  EscrowAgreement,
  EscrowCondition,
  MultiSigToken,
  WalletTransaction,
  EscrowStatus,
  WalletTxType,
} from '../../shared/types';
import { randomUUID, createHmac } from 'crypto';

// ─── Repository Interfaces (inject your DB layer) ────────────

export interface IWalletRepository {
  findById(walletId: string): Promise<TitanWallet | null>;
  findByUserId(userId: string): Promise<TitanWallet | null>;
  create(wallet: TitanWallet): Promise<TitanWallet>;
  updateBalance(walletId: string, newBalance: number, updatedAt: Date): Promise<void>;
}

export interface IEscrowRepository {
  findById(escrowId: string): Promise<EscrowAgreement | null>;
  create(agreement: EscrowAgreement): Promise<EscrowAgreement>;
  updateStatus(escrowId: string, status: EscrowStatus): Promise<void>;
  updateCondition(escrowId: string, conditionId: string, isMet: boolean, metAt: Date, metByUserId: string): Promise<void>;
  addSignature(escrowId: string, tokenId: string, signature: string, signedAt: Date): Promise<void>;
}

export interface ITransactionRepository {
  create(tx: WalletTransaction): Promise<WalletTransaction>;
  findByWalletId(walletId: string): Promise<WalletTransaction[]>;
  findByEscrowId(escrowId: string): Promise<WalletTransaction[]>;
}

// ─── Stripe Payment Rail Interface ───────────────────────────

export interface IPaymentRail {
  createCustomer(userId: string, email: string): Promise<string>; // returns customerId
  createPaymentIntent(amount: number, currency: string, customerId: string, metadata: Record<string, string>): Promise<{ id: string; clientSecret: string }>;
  capturePayment(paymentIntentId: string): Promise<void>;
  refund(paymentIntentId: string, amount?: number): Promise<void>;
  transferToBank(amount: number, destinationAccountId: string, description: string): Promise<string>; // returns transferId
}

// ─── Stripe Adapter ──────────────────────────────────────────

export class StripePaymentRail implements IPaymentRail {
  private stripeKey: string;
  private baseUrl = 'https://api.stripe.com/v1';

  constructor() {
    this.stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
    if (!this.stripeKey) throw new Error('STRIPE_SECRET_KEY not set');
  }

  private async post(endpoint: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(body);
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!response.ok) {
      const err = await response.json() as { error: { message: string } };
      throw new Error(`Stripe error: ${err.error?.message}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async createCustomer(userId: string, email: string): Promise<string> {
    const data = await this.post('/customers', { email, metadata: JSON.stringify({ titanUserId: userId }) }) as { id: string };
    return data.id;
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    customerId: string,
    metadata: Record<string, string>
  ): Promise<{ id: string; clientSecret: string }> {
    const data = await this.post('/payment_intents', {
      amount: String(Math.round(amount * 100)), // cents
      currency,
      customer: customerId,
      capture_method: 'manual',
      ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, v])),
    }) as { id: string; client_secret: string };
    return { id: data.id, clientSecret: data.client_secret };
  }

  async capturePayment(paymentIntentId: string): Promise<void> {
    await this.post(`/payment_intents/${paymentIntentId}/capture`, {});
  }

  async refund(paymentIntentId: string, amount?: number): Promise<void> {
    const body: Record<string, string> = { payment_intent: paymentIntentId };
    if (amount) body.amount = String(Math.round(amount * 100));
    await this.post('/refunds', body);
  }

  async transferToBank(amount: number, destinationAccountId: string, description: string): Promise<string> {
    const data = await this.post('/transfers', {
      amount: String(Math.round(amount * 100)),
      currency: 'usd',
      destination: destinationAccountId,
      description,
    }) as { id: string };
    return data.id;
  }
}

// ─── Multi-Sig Token Manager ─────────────────────────────────

export class MultiSigManager {
  private hmacSecret: string;

  constructor() {
    this.hmacSecret = process.env.TITAN_MULTISIG_SECRET ?? '';
    if (!this.hmacSecret) throw new Error('TITAN_MULTISIG_SECRET not set');
  }

  /**
   * Generate a deterministic SHA-256 HMAC signature for an escrow token.
   * Signs: escrowId + tokenId + signerUserId + timestamp
   */
  sign(escrowId: string, tokenId: string, signerUserId: string): string {
    const timestamp = Date.now().toString();
    const payload = `${escrowId}:${tokenId}:${signerUserId}:${timestamp}`;
    return createHmac('sha256', this.hmacSecret).update(payload).digest('hex');
  }

  verify(signature: string, escrowId: string, tokenId: string, signerUserId: string, timestamp: string): boolean {
    const payload = `${escrowId}:${tokenId}:${signerUserId}:${timestamp}`;
    const expected = createHmac('sha256', this.hmacSecret).update(payload).digest('hex');
    // Constant-time comparison to prevent timing attacks
    return this.constantTimeEqual(signature, expected);
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  allRequiredSignaturesPresent(tokens: MultiSigToken[]): boolean {
    return tokens
      .filter(t => t.required)
      .every(t => !!t.signature);
  }
}

// ─── Titan Wallet Service ────────────────────────────────────

export class TitanWalletService {
  constructor(
    private walletRepo: IWalletRepository,
    private txRepo: ITransactionRepository,
    private paymentRail: IPaymentRail
  ) {}

  async createWallet(userId: string, email: string): Promise<TitanWallet> {
    const existing = await this.walletRepo.findByUserId(userId);
    if (existing) return existing;

    const stripeCustomerId = await this.paymentRail.createCustomer(userId, email);

    const wallet: TitanWallet = {
      walletId: randomUUID(),
      userId,
      balance: 0,
      currency: 'USD',
      stripeCustomerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return this.walletRepo.create(wallet);
  }

  async deposit(walletId: string, amount: number): Promise<WalletTransaction> {
    const wallet = await this.requireWallet(walletId);

    const intent = await this.paymentRail.createPaymentIntent(
      amount,
      'usd',
      wallet.stripeCustomerId,
      { walletId, type: 'DEPOSIT' }
    );
    await this.paymentRail.capturePayment(intent.id);

    const newBalance = wallet.balance + amount;
    await this.walletRepo.updateBalance(walletId, newBalance, new Date());

    return this.recordTx({
      walletId,
      type: 'DEPOSIT',
      amount,
      balanceBefore: wallet.balance,
      balanceAfter: newBalance,
      stripePaymentIntentId: intent.id,
      description: `Deposit of $${amount.toFixed(2)}`,
    });
  }

  async lockForEscrow(walletId: string, escrowId: string, amount: number): Promise<WalletTransaction> {
    const wallet = await this.requireWallet(walletId);
    if (wallet.balance < amount) {
      throw new Error(`Insufficient balance: $${wallet.balance} < $${amount}`);
    }

    const newBalance = wallet.balance - amount;
    await this.walletRepo.updateBalance(walletId, newBalance, new Date());

    return this.recordTx({
      walletId,
      type: 'ESCROW_LOCK',
      amount: -amount,
      balanceBefore: wallet.balance,
      balanceAfter: newBalance,
      relatedEscrowId: escrowId,
      description: `Escrowed $${amount.toFixed(2)} for deal ${escrowId}`,
    });
  }

  async disburse(walletId: string, escrowId: string, amount: number, destinationAccountId: string): Promise<WalletTransaction> {
    const wallet = await this.requireWallet(walletId);
    const transferId = await this.paymentRail.transferToBank(amount, destinationAccountId, `Escrow disbursement ${escrowId}`);

    return this.recordTx({
      walletId,
      type: 'DISBURSEMENT',
      amount: -amount,
      balanceBefore: wallet.balance,
      balanceAfter: wallet.balance, // balance was already debited at escrow lock
      relatedEscrowId: escrowId,
      description: `Disbursement for escrow ${escrowId} → ${destinationAccountId} (transfer: ${transferId})`,
    });
  }

  private async requireWallet(walletId: string): Promise<TitanWallet> {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) throw new Error(`Wallet not found: ${walletId}`);
    return wallet;
  }

  private async recordTx(data: Omit<WalletTransaction, 'txId' | 'createdAt'>): Promise<WalletTransaction> {
    const tx: WalletTransaction = {
      txId: randomUUID(),
      createdAt: new Date(),
      stripePaymentIntentId: undefined,
      relatedEscrowId: undefined,
      ...data,
    };
    return this.txRepo.create(tx);
  }
}

// ─── Titan Escrow Service ────────────────────────────────────

export class TitanEscrowService {
  constructor(
    private escrowRepo: IEscrowRepository,
    private walletService: TitanWalletService,
    private multiSig: MultiSigManager
  ) {}

  async createEscrow(
    dealId: string,
    buyerWalletId: string,
    sellerWalletId: string,
    amount: number,
    conditions: Omit<EscrowCondition, 'isMet' | 'metAt' | 'metByUserId'>[],
    signerUserIds: Array<{ userId: string; role: MultiSigToken['signerRole']; required: boolean }>,
    expiresInDays = 30
  ): Promise<EscrowAgreement> {
    // Lock funds from buyer wallet immediately
    await this.walletService.lockForEscrow(buyerWalletId, dealId, amount);

    const agreement: EscrowAgreement = {
      escrowId: randomUUID(),
      dealId,
      buyerWalletId,
      sellerWalletId,
      amount,
      currency: 'USD',
      conditions: conditions.map(c => ({ ...c, isMet: false })),
      status: 'FUNDED',
      multiSigTokens: signerUserIds.map(s => ({
        tokenId: randomUUID(),
        signerUserId: s.userId,
        signerRole: s.role,
        required: s.required,
        signature: undefined,
        signedAt: undefined,
      })),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
    };

    return this.escrowRepo.create(agreement);
  }

  async sign(escrowId: string, signerUserId: string): Promise<void> {
    const agreement = await this.requireEscrow(escrowId);
    const token = agreement.multiSigTokens.find(t => t.signerUserId === signerUserId);
    if (!token) throw new Error(`User ${signerUserId} is not a signer for escrow ${escrowId}`);
    if (token.signature) throw new Error(`Already signed by ${signerUserId}`);

    const signature = this.multiSig.sign(escrowId, token.tokenId, signerUserId);
    await this.escrowRepo.addSignature(escrowId, token.tokenId, signature, new Date());

    // Check if all required conditions + signatures are now met → auto-disburse
    const updated = await this.requireEscrow(escrowId);
    await this.tryAutoDisbursement(updated);
  }

  async markConditionMet(escrowId: string, conditionId: string, verifierUserId: string): Promise<void> {
    const agreement = await this.requireEscrow(escrowId);
    const condition = agreement.conditions.find(c => c.conditionId === conditionId);
    if (!condition) throw new Error(`Condition ${conditionId} not found`);
    if (condition.isMet) throw new Error(`Condition ${conditionId} already met`);

    await this.escrowRepo.updateCondition(escrowId, conditionId, true, new Date(), verifierUserId);

    const updated = await this.requireEscrow(escrowId);
    await this.tryAutoDisbursement(updated);
  }

  /**
   * Instant disbursement — fires automatically when:
   * 1. All required multi-sig tokens are signed
   * 2. All escrow conditions are met
   */
  private async tryAutoDisbursement(agreement: EscrowAgreement): Promise<void> {
    if (agreement.status !== 'FUNDED') return;

    const allSigned = this.multiSig.allRequiredSignaturesPresent(agreement.multiSigTokens);
    const allConditionsMet = agreement.conditions.every(c => c.isMet);

    if (allSigned && allConditionsMet) {
      console.log(`[Escrow] ✅ All conditions met for ${agreement.escrowId} — initiating disbursement`);
      await this.escrowRepo.updateStatus(agreement.escrowId, 'CONDITIONS_MET');

      // Platform fee: 1% of deal
      const platformFee = agreement.amount * 0.01;
      const sellerProceeds = agreement.amount - platformFee;

      // In production: look up seller's bank account from their wallet record
      await this.walletService.disburse(
        agreement.buyerWalletId,
        agreement.escrowId,
        sellerProceeds,
        `seller_stripe_account_${agreement.sellerWalletId}` // resolved in prod
      );

      await this.escrowRepo.updateStatus(agreement.escrowId, 'DISBURSED');
      console.log(`[Escrow] 💸 Disbursed $${sellerProceeds.toFixed(2)} for deal ${agreement.dealId}`);
    }
  }

  async disputeEscrow(escrowId: string, reason: string): Promise<void> {
    const agreement = await this.requireEscrow(escrowId);
    if (!['FUNDED', 'CONDITIONS_MET'].includes(agreement.status)) {
      throw new Error(`Cannot dispute escrow in status: ${agreement.status}`);
    }
    await this.escrowRepo.updateStatus(escrowId, 'DISPUTED');
    console.warn(`[Escrow] ⚠️  Dispute filed for ${escrowId}: ${reason}`);
    // In production: trigger Titan admin review workflow + lock funds
  }

  async cancelAndRefund(escrowId: string): Promise<void> {
    const agreement = await this.requireEscrow(escrowId);
    if (agreement.status !== 'FUNDED') {
      throw new Error(`Cannot cancel escrow in status: ${agreement.status}`);
    }
    // Return funds to buyer wallet
    const wallet = await this.walletService['walletRepo'].findById(agreement.buyerWalletId);
    if (wallet) {
      await this.walletService['walletRepo'].updateBalance(
        agreement.buyerWalletId,
        wallet.balance + agreement.amount,
        new Date()
      );
    }
    await this.escrowRepo.updateStatus(escrowId, 'CANCELLED');
  }

  private async requireEscrow(escrowId: string): Promise<EscrowAgreement> {
    const e = await this.escrowRepo.findById(escrowId);
    if (!e) throw new Error(`Escrow not found: ${escrowId}`);
    return e;
  }
}

// ─── Escrow API Route Handlers (Express-compatible) ──────────

export interface EscrowRequest {
  body: Record<string, unknown>;
  params: Record<string, string>;
}

export interface EscrowResponse {
  status(code: number): EscrowResponse;
  json(data: unknown): void;
}

export class EscrowGatewayRoutes {
  constructor(
    private walletService: TitanWalletService,
    private escrowService: TitanEscrowService
  ) {}

  async createWallet(req: EscrowRequest, res: EscrowResponse): Promise<void> {
    try {
      const { userId, email } = req.body as { userId: string; email: string };
      const wallet = await this.walletService.createWallet(userId, email);
      res.status(201).json({ success: true, wallet });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  async deposit(req: EscrowRequest, res: EscrowResponse): Promise<void> {
    try {
      const { walletId } = req.params;
      const { amount } = req.body as { amount: number };
      const tx = await this.walletService.deposit(walletId, amount);
      res.status(200).json({ success: true, transaction: tx });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  async createEscrow(req: EscrowRequest, res: EscrowResponse): Promise<void> {
    try {
      const { dealId, buyerWalletId, sellerWalletId, amount, conditions, signers } =
        req.body as {
          dealId: string;
          buyerWalletId: string;
          sellerWalletId: string;
          amount: number;
          conditions: Omit<EscrowCondition, 'isMet' | 'metAt' | 'metByUserId'>[];
          signers: Array<{ userId: string; role: MultiSigToken['signerRole']; required: boolean }>;
        };

      const agreement = await this.escrowService.createEscrow(
        dealId, buyerWalletId, sellerWalletId, amount, conditions, signers
      );
      res.status(201).json({ success: true, escrow: agreement });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  async signEscrow(req: EscrowRequest, res: EscrowResponse): Promise<void> {
    try {
      const { escrowId } = req.params;
      const { userId } = req.body as { userId: string };
      await this.escrowService.sign(escrowId, userId);
      res.status(200).json({ success: true, message: 'Signature recorded' });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }

  async markConditionMet(req: EscrowRequest, res: EscrowResponse): Promise<void> {
    try {
      const { escrowId, conditionId } = req.params;
      const { verifierUserId } = req.body as { verifierUserId: string };
      await this.escrowService.markConditionMet(escrowId, conditionId, verifierUserId);
      res.status(200).json({ success: true, message: 'Condition marked met' });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  }
}
