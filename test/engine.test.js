import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, normalizeParams, hashDataset, hashValue, diffPlans, ENGINE_VERSION, ValidationError } from '../src/engine.js';
import { buildDataset, DEMO_PARAMS } from '../src/seed-data.js';

const dataset = buildDataset();
const baseParams = DEMO_PARAMS;

function run(params = baseParams, data = dataset) {
  return simulate(data, params);
}

test('同一输入重复模拟得到完全一致的哈希', () => {
  const a = run();
  const b = run();
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.resultHash, b.resultHash);
  assert.deepEqual(a.totals, b.totals);
});

test('参数变化会改变输入哈希，结果也随之不同', () => {
  const a = run();
  const b = run({ ...baseParams, leadTimeDays: 9 });
  assert.notEqual(a.inputHash, b.inputHash);
  assert.notEqual(a.resultHash, b.resultHash);
});

test('数据版本变化会改变数据哈希与结果', () => {
  const mutated = structuredClone(dataset);
  mutated.items[0].forecast[0] += 10;
  assert.notEqual(hashDataset(dataset), hashDataset(mutated));
  assert.notEqual(run(baseParams, mutated).resultHash, run().resultHash);
});

test('规范化参数的键顺序不影响哈希', () => {
  const reordered = {
    reviewPeriodDays: baseParams.reviewPeriodDays,
    inboundOverrides: [],
    disruption: { ...baseParams.disruption },
    substitution: { ...baseParams.substitution },
    returns: { ...baseParams.returns },
    safetyStockBySku: { ...baseParams.safetyStockBySku },
    orderMultiple: baseParams.orderMultiple,
    minOrderQty: baseParams.minOrderQty,
    leadTimeDays: baseParams.leadTimeDays,
    demandMultiplier: baseParams.demandMultiplier,
    horizonDays: baseParams.horizonDays,
  };
  assert.equal(run(reordered).inputHash, run().inputHash);
});

test('需求越大缺口越大、满足率越低', () => {
  const normal = run();
  const surge = run({ ...baseParams, demandMultiplier: 1.5 });
  assert.ok(surge.totals.demand > normal.totals.demand);
  assert.ok(surge.totals.lost >= normal.totals.lost);
  assert.ok(surge.totals.fillRate <= normal.totals.fillRate);
});

test('更大安全库存不会降低满足率，并提高平均在库', () => {
  const normal = run();
  const buffered = run({
    ...baseParams,
    safetyStockBySku: Object.fromEntries(Object.entries(baseParams.safetyStockBySku).map(([sku, qty]) => [sku, qty * 2])),
  });
  assert.ok(buffered.totals.fillRate >= normal.totals.fillRate - 0.001);
  assert.ok(buffered.totals.avgOnHand >= normal.totals.avgOnHand - 0.001);
});

test('最小批量与批量倍数被遵守', () => {
  const result = run({ ...baseParams, minOrderQty: 60, orderMultiple: 25 });
  const qtyList = result.items.flatMap((item) => item.orders.map((order) => order.qty));
  assert.ok(qtyList.length > 0);
  for (const qty of qtyList) {
    assert.ok(qty >= 60, `订单量 ${qty} 小于最小批量`);
    assert.equal(qty % 25, 0, `订单量 ${qty} 不是批量倍数`);
  }
});

test('关闭替代品后替代补足为 0，且不会虚增可供数量', () => {
  const withSub = run();
  const withoutSub = run({ ...baseParams, substitution: { enabled: false } });
  assert.ok(withSub.totals.substituteCovered > 0);
  assert.equal(withoutSub.totals.substituteCovered, 0);
  assert.ok(withoutSub.totals.lost >= withSub.totals.lost);
});

test('退货回流只来自已满足的主商品销量，并且按滞后到账', () => {
  const noReturns = run({ ...baseParams, returns: { enabled: false, ratePercent: 4, lagDays: 2 } });
  const withReturns = run();
  assert.equal(noReturns.totals.returnsDelivered, 0);
  assert.ok(withReturns.totals.returnsDelivered > 0);
  // 4% 退货率下回流件数应约为已满足主商品销量的 4%
  const servedPrimary = withReturns.items.reduce((sum, item) => sum + item.series.reduce((s, row) => s + row.servedPrimary, 0), 0);
  const expected = servedPrimary * 0.04;
  assert.ok(Math.abs(withReturns.totals.returnsDelivered - expected) < expected * 0.2 + 20);
});

test('供应中断延迟导致迟到订单，且到货日被推后', () => {
  const disrupted = run({
    ...baseParams,
    disruption: { enabled: true, fromDay: 10, toDay: 25, mode: 'delay', delayDays: 4 },
  });
  assert.ok(disrupted.totals.lateOrders > 0);
  assert.ok(disrupted.totals.lateDays >= disrupted.totals.lateOrders * 1);
  for (const item of disrupted.items) {
    for (const order of item.orders) {
      assert.ok(order.arrivalDay >= order.requestedArrivalDay);
    }
  }
});

test('暂停型中断会把到货推到中断结束之后', () => {
  const halted = run({
    ...baseParams,
    disruption: { enabled: true, fromDay: 10, toDay: 20, mode: 'halt', delayDays: 0 },
  });
  for (const item of halted.items) {
    for (const order of item.orders) {
      if (order.requestedArrivalDay >= 10 && order.requestedArrivalDay <= 20) {
        assert.ok(order.arrivalDay > 20, `到货日 ${order.arrivalDay} 应晚于中断结束`);
      }
    }
  }
});

test('取消在途订单会减少到货并可能加剧缺口', () => {
  const normal = run();
  const cancelled = run({
    ...baseParams,
    inboundOverrides: [{ sku: 'SKU-1001', poId: 'PO-8802', action: 'cancel', days: 0 }],
  });
  const item = cancelled.items.find((entry) => entry.sku === 'SKU-1001');
  assert.equal(item.metrics.cancelledOrders, 1);
  assert.equal(item.cancelledOrders[0].poId, 'PO-8802');
  const po8802 = item.receipts.find((receipt) => receipt.poId === 'PO-8802');
  assert.equal(po8802, undefined, '被取消的订单不应出现在到货里');
  const normalItem = normal.items.find((entry) => entry.sku === 'SKU-1001');
  assert.ok(normalItem.metrics.totalOrdered > 0);
  assert.ok(item.metrics.totalOrdered >= normalItem.metrics.totalOrdered - 1);
});

test('取消后恢复：补单替代被取消的订单', () => {
  const cancelled = run({
    ...baseParams,
    leadTimeDays: 5,
    inboundOverrides: [{ sku: 'SKU-1003', poId: 'PO-8821', action: 'cancel', days: 0 }],
  });
  const item = cancelled.items.find((entry) => entry.sku === 'SKU-1003');
  assert.equal(item.metrics.cancelledOrders, 1);
  assert.ok(item.metrics.orderCount > 0, '取消后应触发新的补货单');
  const firstPlanOrder = item.orders.find((order) => order.orderDay <= 6);
  assert.ok(firstPlanOrder, '应在取消后 6 天内补单');
  assert.ok(firstPlanOrder.arrivalDay >= firstPlanOrder.requestedArrivalDay);
});

test('延迟在途订单会体现在迟到统计中', () => {
  const delayed = run({
    ...baseParams,
    inboundOverrides: [{ sku: 'SKU-1002', poId: 'PO-8811', action: 'delay', days: 6 }],
  });
  const item = delayed.items.find((entry) => entry.sku === 'SKU-1002');
  assert.ok(item.metrics.lateOrders >= 1);
  const receipt = item.receipts.find((entry) => entry.poId === 'PO-8811');
  assert.equal(receipt.lateDays, 6);
});

test('缺口区间与实际缺货日一致', () => {
  const result = run({ ...baseParams, demandMultiplier: 1.6 });
  for (const item of result.items) {
    const daysFromGaps = item.gaps.shortage.reduce((sum, gap) => sum + gap.days, 0);
    const directDays = item.series.filter((row) => row.lost + row.servedBySubstitute > 0).length;
    assert.equal(daysFromGaps, directDays, `${item.sku} 缺口区间天数不一致`);
    for (const gap of item.gaps.shortage) {
      assert.ok(gap.lost + gap.substituteCovered > 0);
      assert.ok(gap.startDay <= gap.endDay);
    }
  }
});

test('库存守恒：期初 + 到货 - 满足 = 期末在库', () => {
  const result = run({ ...baseParams, demandMultiplier: 1.4 });
  for (const item of result.items) {
    const source = dataset.items.find((entry) => entry.sku === item.sku);
    const incoming = item.series.reduce((sum, row) => sum + row.receiptQty + row.returnQty, 0);
    const consumed = item.series.reduce((sum, row) => sum + row.servedPrimary, 0);
    const expected = source.onHand + incoming - consumed;
    assert.ok(Math.abs(expected - item.metrics.endingOnHand) < 0.01, `${item.sku} 库存不守恒：${expected} vs ${item.metrics.endingOnHand}`);
  }
});

test('负数或缺失参数被拒绝', () => {
  assert.throws(() => run({ ...baseParams, horizonDays: 3 }), ValidationError);
  assert.throws(() => run({ ...baseParams, leadTimeDays: 0 }), ValidationError);
  assert.throws(() => run({ ...baseParams, demandMultiplier: 0 }), ValidationError);
  assert.throws(() => run({ ...baseParams, returns: { enabled: true, ratePercent: 140, lagDays: 1 } }), ValidationError);
  assert.throws(() => run({ ...baseParams, safetyStockBySku: { NOPE: 1 } }), ValidationError);
  assert.throws(() => run({ ...baseParams, inboundOverrides: [{ sku: 'SKU-1001', poId: 'NOPE', action: 'cancel' }] }), ValidationError);
  assert.throws(() => normalizeParams(baseParams, { items: [] }), ValidationError);
});

test('引擎版本参与输入哈希', () => {
  const result = run();
  const expected = hashValue({ engineVersion: ENGINE_VERSION, datasetHash: hashDataset(dataset), parameters: normalizeParams(baseParams, dataset) });
  assert.equal(result.inputHash, expected);
});

test('diffPlans 识别新增、调整与移除的补货单', () => {
  const base = { lines: [
    { sku: 'A', orderDay: 1, qty: 10, arrivalDay: 8 },
    { sku: 'A', orderDay: 5, qty: 20, arrivalDay: 12 },
    { sku: 'B', orderDay: 1, qty: 30, arrivalDay: 8 },
  ], totals: { fillRate: 90, lost: 100 } };
  const candidate = { lines: [
    { sku: 'A', orderDay: 1, qty: 15, arrivalDay: 8 },
    { sku: 'C', orderDay: 2, qty: 40, arrivalDay: 9 },
    { sku: 'B', orderDay: 1, qty: 30, arrivalDay: 8 },
  ], totals: { fillRate: 95, lost: 40 } };
  const diff = diffPlans(base, candidate);
  assert.equal(diff.lines.added.length, 1);
  assert.equal(diff.lines.added[0].sku, 'C');
  assert.equal(diff.lines.changed.length, 1);
  assert.equal(diff.lines.changed[0].from.qty, 10);
  assert.equal(diff.lines.removed.length, 1);
  assert.equal(diff.lines.removed[0].orderDay, 5);
  const fill = diff.metrics.find((metric) => metric.key === 'fillRate');
  assert.equal(fill.delta, 5);
  assert.equal(fill.direction, 'up');
});

test('时间轴日期与模拟天数对齐', () => {
  const result = run();
  assert.equal(result.items[0].series[0].date, dataset.startDate);
  assert.equal(result.items[0].series.at(-1).date, '2026-12-27');
});
