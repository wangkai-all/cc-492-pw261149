/**
 * Deterministic demo dataset. All values fixed so seeds are reproducible.
 * `forecast` is the sales forecast per day starting at `startDate`.
 */

function wave(base, amplitude, phase, weekdayBoost) {
  return Array.from({ length: 42 }, (_, day) => {
    const weekday = day % 7;
    const weekdayFactor = weekday === 5 || weekday === 6 ? weekdayBoost : 0;
    const value = base + amplitude * Math.sin((day + phase) * (Math.PI / 7)) + weekdayFactor;
    return Math.max(1, Math.round(value));
  });
}

export function buildDataset() {
  return {
    startDate: '2026-11-02',
    items: [
      {
        sku: 'SKU-1001',
        name: '气泡矿泉水 500ml',
        unit: '箱',
        onHand: 850,
        safetyStock: 180,
        forecast: wave(86, 14, 0, 22),
        openOrders: [
          { id: 'PO-8801', qty: 600, expectedDay: 5 },
          { id: 'PO-8802', qty: 500, expectedDay: 18 },
        ],
        substitute: null,
      },
      {
        sku: 'SKU-1002',
        name: '冷萃咖啡 330ml',
        unit: '箱',
        onHand: 800,
        safetyStock: 120,
        forecast: wave(64, 18, 2, 26),
        openOrders: [
          { id: 'PO-8811', qty: 400, expectedDay: 9 },
        ],
        substitute: null,
      },
      {
        sku: 'SKU-1003',
        name: '燕麦能量棒 6 支装',
        unit: '箱',
        onHand: 220,
        safetyStock: 90,
        forecast: wave(38, 9, 4, 11),
        openOrders: [
          { id: 'PO-8821', qty: 260, expectedDay: 4 },
          { id: 'PO-8822', qty: 240, expectedDay: 26 },
        ],
        substitute: {
          sku: 'SKU-1004',
          name: '坚果能量棒 6 支装',
          onHand: 320,
          ratio: 1,
          maxShare: 0.6,
        },
      },
      {
        sku: 'SKU-1005',
        name: '低糖气泡茶 500ml',
        unit: '箱',
        onHand: 780,
        safetyStock: 140,
        forecast: wave(52, 11, 1, 16),
        openOrders: [
          { id: 'PO-8831', qty: 420, expectedDay: 12 },
        ],
        substitute: null,
      },
      {
        sku: 'SKU-1006',
        name: '每日坚果 20 包',
        unit: '箱',
        onHand: 280,
        safetyStock: 75,
        forecast: wave(30, 7, 3, 8),
        openOrders: [
          { id: 'PO-8841', qty: 200, expectedDay: 7 },
        ],
        substitute: null,
      },
    ],
  };
}

export const DEMO_PARAMS = {
  horizonDays: 56,
  demandMultiplier: 1,
  leadTimeDays: 7,
  minOrderQty: 50,
  orderMultiple: 10,
  reviewPeriodDays: 1,
  safetyStockBySku: {
    'SKU-1001': 180,
    'SKU-1002': 120,
    'SKU-1003': 90,
    'SKU-1005': 140,
    'SKU-1006': 75,
  },
  returns: { enabled: true, ratePercent: 4, lagDays: 2 },
  substitution: { enabled: true },
  disruption: { enabled: false, fromDay: 12, toDay: 20, mode: 'delay', delayDays: 5 },
  inboundOverrides: [],
};

export const DEMO_SCENARIOS = [
  {
    slug: 'baseline',
    name: '基准方案',
    description: '维持当前供应周期与安全库存，作为比较基线。',
    params: DEMO_PARAMS,
  },
  {
    slug: 'peak-promo',
    name: '促销增量 · 需求 +30%',
    description: '双周促销使销量预测整体上浮 30%，检验补货是否能兜住峰值。',
    params: {
      ...DEMO_PARAMS,
      demandMultiplier: 1.3,
    },
  },
  {
    slug: 'supplier-delay',
    name: '供应中断 · 延迟 5 天',
    description: '第 12–20 天的到货统一延迟 5 天，并叠加 4% 退货回流。',
    params: {
      ...DEMO_PARAMS,
      disruption: { enabled: true, fromDay: 12, toDay: 20, mode: 'delay', delayDays: 5 },
    },
  },
  {
    slug: 'cancel-recovery',
    name: '取消在途 · 恢复补单',
    description: '取消 PO-8821，并以更短供应周期（5 天）补单，观察恢复情况。',
    params: {
      ...DEMO_PARAMS,
      leadTimeDays: 5,
      inboundOverrides: [{ sku: 'SKU-1003', poId: 'PO-8821', action: 'cancel', days: 0 }],
    },
  },
  {
    slug: 'safety-buffer',
    name: '安全库存 +25% · 批量 100',
    description: '提高安全库存并加大最小批量，用库存换取更高满足率。',
    params: {
      ...DEMO_PARAMS,
      minOrderQty: 100,
      safetyStockBySku: {
        'SKU-1001': 225,
        'SKU-1002': 150,
        'SKU-1003': 113,
        'SKU-1005': 175,
        'SKU-1006': 94,
      },
      disruption: { enabled: true, fromDay: 12, toDay: 20, mode: 'delay', delayDays: 5 },
    },
  },
];
