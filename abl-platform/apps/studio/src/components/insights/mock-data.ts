/**
 * Mock data for the At a Glance insights page.
 * Delete this file when wiring to real APIs.
 */

// ── KPI data ────────────────────────────────────────────────────────────────

export interface KPIData {
  label: string;
  value: string;
  format: 'percent' | 'number' | 'currency' | 'score';
  trend: { value: number; period: string; favorable: 'up' | 'down' };
  sparkline: number[];
  status: 'healthy' | 'warning' | 'critical';
}

export const MOCK_KPIS: KPIData[] = [
  {
    label: 'Conversations',
    value: '12,847',
    format: 'number',
    trend: { value: 8.3, period: 'vs last month', favorable: 'up' },
    sparkline: [
      320, 380, 350, 410, 390, 450, 420, 480, 510, 490, 530, 520, 560, 540, 580, 570, 610, 590, 630,
      620, 650, 640, 670, 660, 690, 680, 710, 700, 730, 720,
    ],
    status: 'healthy',
  },
  {
    label: 'Containment Rate',
    value: '72.3%',
    format: 'percent',
    trend: { value: 5.2, period: 'vs last month', favorable: 'up' },
    sparkline: [
      62, 64, 63, 65, 67, 66, 68, 69, 68, 70, 69, 71, 70, 72, 71, 70, 72, 71, 73, 72, 74, 73, 72,
      74, 73, 72, 73, 72, 73, 72,
    ],
    status: 'healthy',
  },
  {
    label: 'Quality Score',
    value: '4.1',
    format: 'score',
    trend: { value: 0.3, period: 'vs last month', favorable: 'up' },
    sparkline: [
      3.5, 3.6, 3.7, 3.6, 3.8, 3.7, 3.9, 3.8, 4.0, 3.9, 3.8, 4.0, 3.9, 4.1, 4.0, 3.9, 4.1, 4.0, 4.2,
      4.1, 4.0, 4.1, 4.0, 4.2, 4.1, 4.0, 4.1, 4.0, 4.1, 4.1,
    ],
    status: 'healthy',
  },
  {
    label: 'Avg Sentiment',
    value: '0.72',
    format: 'score',
    trend: { value: -2.1, period: 'vs last month', favorable: 'up' },
    sparkline: [
      0.68, 0.7, 0.72, 0.71, 0.73, 0.72, 0.74, 0.73, 0.75, 0.74, 0.73, 0.72, 0.74, 0.73, 0.72, 0.71,
      0.73, 0.72, 0.71, 0.72, 0.73, 0.72, 0.71, 0.72, 0.73, 0.72, 0.71, 0.72, 0.72, 0.72,
    ],
    status: 'warning',
  },
  {
    label: 'Cost Savings',
    value: '$48,200',
    format: 'currency',
    trend: { value: 12.5, period: 'vs last month', favorable: 'up' },
    sparkline: [
      1200, 1300, 1400, 1350, 1500, 1450, 1600, 1550, 1700, 1650, 1600, 1700, 1650, 1800, 1750,
      1700, 1800, 1750, 1850, 1800, 1750, 1850, 1800, 1900, 1850, 1800, 1850, 1800, 1900, 1850,
    ],
    status: 'healthy',
  },
  {
    label: 'Escalation Rate',
    value: '18.4%',
    format: 'percent',
    trend: { value: -3.1, period: 'vs last month', favorable: 'down' },
    sparkline: [
      24, 23, 22, 23, 21, 22, 20, 21, 20, 19, 20, 19, 20, 19, 18, 19, 18, 19, 18, 19, 18, 19, 18,
      19, 18, 19, 18, 19, 18, 18,
    ],
    status: 'healthy',
  },
];

// ── Trend chart data ────────────────────────────────────────────────────────

export interface TrendPoint {
  date: string;
  conversations: number;
  containment: number;
  escalation: number;
  sentiment: number;
}

function generateTrends(): TrendPoint[] {
  const points: TrendPoint[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    points.push({
      date: d.toISOString().slice(5, 10), // MM-DD
      conversations: 350 + Math.round(Math.random() * 200 + i * 3),
      containment: 65 + Math.round((Math.random() * 10 + i * 0.2) * 10) / 10,
      escalation: 22 - Math.round((Math.random() * 5 + i * 0.1) * 10) / 10,
      sentiment: 0.65 + Math.round((Math.random() * 0.1 + i * 0.002) * 100) / 100,
    });
  }
  return points;
}

export const MOCK_TRENDS: TrendPoint[] = generateTrends();

// ── Outcome distribution ────────────────────────────────────────────────────

export interface OutcomePoint {
  date: string;
  resolved: number;
  escalated: number;
  abandoned: number;
}

export const MOCK_OUTCOMES: OutcomePoint[] = MOCK_TRENDS.map((t) => {
  const total = t.conversations;
  const resolved = Math.round(total * (t.containment / 100));
  const escalated = Math.round(total * (t.escalation / 100));
  return {
    date: t.date,
    resolved,
    escalated,
    abandoned: total - resolved - escalated,
  };
});

// ── Breakdown table ─────────────────────────────────────────────────────────

export interface BreakdownRow {
  dimension: string;
  conversations: number;
  confidence: number;
  qualityScore: number;
  avgSentiment: number;
  trend: number[]; // sparkline
}

export const MOCK_BREAKDOWN: BreakdownRow[] = [
  {
    dimension: 'Billing Inquiry',
    conversations: 3420,
    confidence: 81.2,
    qualityScore: 4.3,
    avgSentiment: 0.74,
    trend: [78, 79, 80, 79, 81, 80, 82, 81, 81],
  },
  {
    dimension: 'Technical Support',
    conversations: 2890,
    confidence: 58.4,
    qualityScore: 3.8,
    avgSentiment: 0.61,
    trend: [55, 56, 57, 56, 58, 57, 58, 58, 58],
  },
  {
    dimension: 'Account Management',
    conversations: 2150,
    confidence: 76.9,
    qualityScore: 4.1,
    avgSentiment: 0.71,
    trend: [73, 74, 75, 76, 76, 77, 76, 77, 77],
  },
  {
    dimension: 'Order Status',
    conversations: 1980,
    confidence: 92.1,
    qualityScore: 4.5,
    avgSentiment: 0.82,
    trend: [88, 89, 90, 91, 91, 92, 91, 92, 92],
  },
  {
    dimension: 'Returns & Refunds',
    conversations: 1340,
    confidence: 64.3,
    qualityScore: 3.6,
    avgSentiment: 0.55,
    trend: [60, 61, 62, 63, 63, 64, 63, 64, 64],
  },
];

// ROI data removed — now computed from real data in useAtAGlance hook
