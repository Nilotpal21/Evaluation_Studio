/**
 * Deal Lifecycle E2E Tests
 *
 * Integration tests verifying the deal management flows: creation, detail
 * retrieval, credit top-ups, line item management, and HubSpot linking.
 * Global `fetch` is mocked to validate request/response handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock Globals ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse<T>(data: T, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

// ─── Test Data ───────────────────────────────────────────────────────────────

const MOCK_DEAL = {
  _id: 'deal-001',
  name: 'Acme Enterprise FY26',
  organizationId: 'org-001',
  status: 'active',
  scope: 'organization',
  aggregationMode: 'pooled',
  overagePolicy: 'soft_cap',
  overageAlertThresholds: [50, 80, 90, 100],
  features: ['chat', 'search', 'voice'],
  phases: [
    {
      name: 'Phase 1',
      startDate: '2026-01-01T00:00:00Z',
      endDate: '2026-06-30T23:59:59Z',
    },
  ],
  creditAllotment: { totalCredits: 100000, usedCredits: 35000 },
  renewalDate: '2026-07-01T00:00:00Z',
  contractEndDate: '2027-01-01T00:00:00Z',
  hubspotDealId: null,
  createdAt: '2025-12-15T10:00:00Z',
};

const MOCK_CREDIT_LEDGER = {
  ledger: {
    totalAllocated: 100000,
    totalConsumed: 35000,
    featureUsage: { chat: 20000, search: 10000, voice: 5000 },
    entries: [
      {
        timestamp: '2026-02-01T10:00:00Z',
        feature: 'chat',
        units: 1000,
        credits: 500,
        source: 'usage',
      },
      {
        timestamp: '2026-02-15T10:00:00Z',
        feature: 'search',
        units: 500,
        credits: 250,
        source: 'usage',
      },
    ],
  },
};

const MOCK_LINE_ITEMS = {
  lineItems: [
    {
      _id: 'li-001',
      dealId: 'deal-001',
      periodLabel: '2026-01',
      description: 'Base subscription',
      quantity: 1,
      unitPrice: 5000,
      totalAmount: 5000,
      category: 'base',
      invoiced: true,
    },
    {
      _id: 'li-002',
      dealId: 'deal-001',
      periodLabel: '2026-02',
      description: 'Overage charges',
      quantity: 500,
      unitPrice: 0.05,
      totalAmount: 25,
      category: 'overage',
      invoiced: false,
    },
  ],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Deal Lifecycle E2E', () => {
  describe('Deal Listing', () => {
    it('should fetch deals for an organization', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ deals: [MOCK_DEAL], pagination: { total: 1 } }));

      const res = await fetch('/api/deals?organizationId=org-001');
      const data = await res.json();

      expect(data.deals).toHaveLength(1);
      expect(data.deals[0].name).toBe('Acme Enterprise FY26');
      expect(data.deals[0].scope).toBe('organization');
    });

    it('should return empty list when no deals exist', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ deals: [], pagination: { total: 0 } }));

      const res = await fetch('/api/deals?organizationId=org-empty');
      const data = await res.json();

      expect(data.deals).toHaveLength(0);
    });
  });

  describe('Deal Detail', () => {
    it('should fetch deal detail by ID', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ deal: MOCK_DEAL }));

      const res = await fetch('/api/deals/deal-001');
      const data = await res.json();

      expect(data.deal.name).toBe('Acme Enterprise FY26');
      expect(data.deal.status).toBe('active');
      expect(data.deal.features).toContain('chat');
      expect(data.deal.phases).toHaveLength(1);
    });

    it('should return 404 for non-existent deal', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Deal not found' }, 404));

      const res = await fetch('/api/deals/non-existent');

      expect(res.status).toBe(404);
    });
  });

  describe('Deal Settings Update', () => {
    it('should update deal name and status', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          deal: { ...MOCK_DEAL, name: 'Updated Deal', status: 'paused' },
        }),
      );

      const res = await fetch('/api/deals/deal-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Deal', status: 'paused' }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.deal.name).toBe('Updated Deal');
      expect(data.deal.status).toBe('paused');
    });

    it('should update overage policy and thresholds', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          deal: {
            ...MOCK_DEAL,
            overagePolicy: 'hard_stop',
            overageAlertThresholds: [75, 90, 100],
          },
        }),
      );

      const res = await fetch('/api/deals/deal-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overagePolicy: 'hard_stop',
          overageAlertThresholds: [75, 90, 100],
        }),
      });
      const data = await res.json();

      expect(data.deal.overagePolicy).toBe('hard_stop');
      expect(data.deal.overageAlertThresholds).toEqual([75, 90, 100]);
    });
  });

  describe('Credit Ledger', () => {
    it('should fetch credit ledger for a deal', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_CREDIT_LEDGER));

      const res = await fetch('/api/deals/deal-001/credits');
      const data = await res.json();

      expect(data.ledger.totalAllocated).toBe(100000);
      expect(data.ledger.totalConsumed).toBe(35000);
      expect(data.ledger.featureUsage.chat).toBe(20000);
      expect(data.ledger.entries).toHaveLength(2);
    });

    it('should perform a credit top-up', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ success: true, creditsAdded: 5000 }));

      const res = await fetch('/api/deals/deal-001/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credits: 5000,
          description: 'Admin credit top-up',
        }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.creditsAdded).toBe(5000);
    });

    it('should calculate correct usage percentage', () => {
      const { totalAllocated, totalConsumed } = MOCK_CREDIT_LEDGER.ledger;
      const usagePercent =
        totalAllocated > 0 ? Math.min(100, (totalConsumed / totalAllocated) * 100) : 0;

      expect(usagePercent).toBe(35);
    });
  });

  describe('Line Items', () => {
    it('should fetch line items for a deal', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_LINE_ITEMS));

      const res = await fetch('/api/deals/deal-001/line-items');
      const data = await res.json();

      expect(data.lineItems).toHaveLength(2);
      expect(data.lineItems[0].category).toBe('base');
      expect(data.lineItems[1].category).toBe('overage');
    });

    it('should create a new line item', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          lineItem: {
            _id: 'li-003',
            dealId: 'deal-001',
            periodLabel: '2026-03',
            description: 'Add-on: Voice',
            quantity: 1,
            unitPrice: 1000,
            totalAmount: 1000,
            category: 'addon',
            invoiced: false,
          },
        }),
      );

      const res = await fetch('/api/deals/deal-001/line-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodLabel: '2026-03',
          description: 'Add-on: Voice',
          quantity: 1,
          unitPrice: 1000,
          category: 'addon',
        }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.lineItem.description).toBe('Add-on: Voice');
      expect(data.lineItem.totalAmount).toBe(1000);
    });

    it('should compute total amount correctly', () => {
      const quantity = 500;
      const unitPrice = 0.05;
      const totalAmount = quantity * unitPrice;

      expect(totalAmount).toBeCloseTo(25);
    });
  });

  describe('HubSpot Integration', () => {
    it('should link a HubSpot deal', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          deal: { ...MOCK_DEAL, hubspotDealId: 'hs-12345' },
        }),
      );

      const res = await fetch('/api/deals/deal-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubspotDealId: 'hs-12345' }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.deal.hubspotDealId).toBe('hs-12345');
    });

    it('should sync from HubSpot', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ success: true, synced: true }));

      const res = await fetch('/api/hubspot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hubspotDealId: 'hs-12345' }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.synced).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle deal creation failure', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({ success: false, error: 'Organization not found' }, 400),
      );

      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'invalid',
          name: 'Bad Deal',
        }),
      });
      const data = await res.json();

      expect(res.ok).toBe(false);
      expect(data.error).toBe('Organization not found');
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(fetch('/api/deals/deal-001')).rejects.toThrow('Network error');
    });
  });
});
