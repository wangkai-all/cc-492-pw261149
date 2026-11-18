import { createHash } from 'node:crypto';

export const ENGINE_VERSION = 'replenishment-engine/1.0.0';

export class ValidationError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.details = details;
  }
}

/** Deterministic JSON serialisation: sorted keys, no whitespace, stable numbers. */
export function canonicalJSON(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalise non-finite number');
    return JSON.stringify(value);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'undefined') return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalise value of type ${type}`);
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashValue(value) {
  return sha256(canonicalJSON(value));
}

/** Hash of the parts of a dataset that influence the simulation. */
export function hashDataset(dataset) {
  return hashValue({
    startDate: dataset.startDate,
    items: dataset.items,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function asNumber(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new ValidationError(`${label} 必须是数字`);
  }
  if (integer && !Number.isInteger(number)) throw new ValidationError(`${label} 必须是整数`);
  if (number < min || number > max) {
    throw new ValidationError(`${label} 必须在 ${min} 到 ${max} 之间`);
  }
  return number;
}

function asBool(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

/**
 * Validate and normalise scenario parameters. The returned object is what gets
 * hashed, so it is fully explicit (no hidden defaults at simulation time).
 */
export function normalizeParams(rawParams = {}, dataset) {
  if (!dataset || !Array.isArray(dataset.items) || dataset.items.length === 0) {
    throw new ValidationError('数据版本缺少商品明细');
  }
  const raw = rawParams || {};
  const horizonDays = asNumber(raw.horizonDays ?? 56, '模拟天数', { min: 7, max: 365, integer: true });
  const leadTimeDays = asNumber(raw.leadTimeDays ?? 7, '供应周期', { min: 1, max: 90, integer: true });
  const minOrderQty = asNumber(raw.minOrderQty ?? 1, '最小批量', { min: 1, max: 1000000 });
  const orderMultiple = asNumber(raw.orderMultiple ?? 1, '批量倍数', { min: 1, max: 1000000 });
  const reviewPeriodDays = asNumber(raw.reviewPeriodDays ?? 1, '复核周期', { min: 1, max: 60, integer: true });
  const demandMultiplier = asNumber(raw.demandMultiplier ?? 1, '需求系数', { min: 0.2, max: 3 });

  const returnsRaw = raw.returns || {};
  const returns = {
    enabled: asBool(returnsRaw.enabled, true),
    ratePercent: asNumber(returnsRaw.ratePercent ?? 0, '退货率', { min: 0, max: 100 }),
    lagDays: asNumber(returnsRaw.lagDays ?? 1, '退货回流天数', { min: 0, max: 60, integer: true }),
  };

  const substitution = {
    enabled: asBool((raw.substitution || {}).enabled, true),
  };

  const disruptionRaw = raw.disruption || {};
  const disruption = {
    enabled: asBool(disruptionRaw.enabled, false),
    fromDay: asNumber(disruptionRaw.fromDay ?? 0, '中断开始日', { min: 0, max: horizonDays - 1, integer: true }),
    toDay: asNumber(disruptionRaw.toDay ?? 0, '中断结束日', { min: 0, max: horizonDays - 1, integer: true }),
    mode: disruptionRaw.mode === 'halt' ? 'halt' : 'delay',
    delayDays: asNumber(disruptionRaw.delayDays ?? 0, '中断延迟天数', { min: 0, max: 90, integer: true }),
  };
  if (disruption.enabled && disruption.mode === 'delay' && disruption.delayDays < 1) {
    throw new ValidationError('延迟型供应中断至少需要 1 天延迟');
  }
  if (disruption.enabled && disruption.fromDay > disruption.toDay) {
    throw new ValidationError('中断开始日不能晚于结束日');
  }

  const safetyRaw = raw.safetyStockBySku || {};
  const safetyStockBySku = {};
  for (const item of dataset.items) {
    if (item.sku === undefined) throw new ValidationError('商品缺少 SKU');
    const value = safetyRaw[item.sku] ?? item.safetyStock ?? 0;
    safetyStockBySku[item.sku] = asNumber(value, `安全库存（${item.sku}）`, { min: 0, max: 10000000 });
  }
  const unknownSkus = Object.keys(safetyRaw).filter((sku) => !dataset.items.some((item) => item.sku === sku));
  if (unknownSkus.length) throw new ValidationError(`未知商品 SKU：${unknownSkus.join('、')}`);

  const overridesRaw = Array.isArray(raw.inboundOverrides) ? raw.inboundOverrides : [];
  const seen = new Set();
  const inboundOverrides = overridesRaw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new ValidationError(`在途调整 #${index + 1} 无效`);
    const sku = String(entry.sku || '');
    const item = dataset.items.find((candidate) => candidate.sku === sku);
    if (!item) throw new ValidationError(`在途调整引用了未知商品：${sku || '(空)'}`);
    const poId = String(entry.poId || '');
    const purchaseOrder = (item.openOrders || []).find((po) => po.id === poId);
    if (!purchaseOrder) throw new ValidationError(`在途调整引用了不存在的订单：${poId || '(空)'}`);
    const action = entry.action === 'cancel' ? 'cancel' : entry.action === 'delay' ? 'delay' : null;
    if (!action) throw new ValidationError(`在途调整动作必须是 delay 或 cancel：${poId}`);
    const key = `${sku}::${poId}`;
    if (seen.has(key)) throw new ValidationError(`订单 ${poId} 存在重复调整`);
    seen.add(key);
    const days = action === 'delay'
      ? asNumber(entry.days ?? 1, `订单 ${poId} 延迟天数`, { min: 1, max: 180, integer: true })
      : 0;
    return { sku, poId, action, days };
  });

  return {
    horizonDays,
    demandMultiplier,
    leadTimeDays,
    minOrderQty,
    orderMultiple,
    reviewPeriodDays,
    safetyStockBySku,
    returns,
    substitution,
    disruption,
    inboundOverrides,
  };
}

function applyDisruption(day, disruption) {
  if (!disruption.enabled) return day;
  if (day < disruption.fromDay || day > disruption.toDay) return day;
  if (disruption.mode === 'halt') return disruption.toDay + 1;
  return day + disruption.delayDays;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function sumPipeline(buckets, afterDay, { includeReturns = false } = {}) {
  let total = 0;
  for (const [day, entries] of buckets) {
    if (day <= afterDay) continue;
    for (const entry of entries) {
      if (!includeReturns && entry.source === 'return') continue;
      total += entry.qty;
    }
  }
  return round2(total);
}

function buildGaps(series) {
  const shortage = [];
  const safety = [];
  let currentShortage = null;
  let currentSafety = null;

  const flushShortage = () => {
    if (!currentShortage) return;
    currentShortage.lost = round2(currentShortage.lost);
    currentShortage.substituteCovered = round2(currentShortage.substituteCovered);
    shortage.push(currentShortage);
    currentShortage = null;
  };
  const flushSafety = () => {
    if (!currentSafety) return;
    safety.push(currentSafety);
    currentSafety = null;
  };

  for (const row of series) {
    const shortfall = row.lost + row.servedBySubstitute;
    if (shortfall > 0.0001) {
      if (!currentShortage) {
        currentShortage = {
          startDay: row.day,
          startDate: row.date,
          endDay: row.day,
          endDate: row.date,
          days: 0,
          lost: 0,
          substituteCovered: 0,
          minOnHand: row.onHand,
          type: row.lost > 0 ? 'stockout' : 'substitute',
        };
      }
      currentShortage.endDay = row.day;
      currentShortage.endDate = row.date;
      currentShortage.days += 1;
      currentShortage.lost += row.lost;
      currentShortage.substituteCovered += row.servedBySubstitute;
      currentShortage.minOnHand = Math.min(currentShortage.minOnHand, row.onHand);
      if (row.lost > 0) currentShortage.type = 'stockout';
    } else {
      flushShortage();
    }

    if (row.onHand < row.safetyStock) {
      if (!currentSafety) {
        currentSafety = {
          startDay: row.day,
          startDate: row.date,
          endDay: row.day,
          endDate: row.date,
          days: 0,
          minOnHand: row.onHand,
          maxDeficit: 0,
        };
      }
      currentSafety.endDay = row.day;
      currentSafety.endDate = row.date;
      currentSafety.days += 1;
      currentSafety.minOnHand = Math.min(currentSafety.minOnHand, row.onHand);
      currentSafety.maxDeficit = Math.max(currentSafety.maxDeficit, row.safetyStock - row.onHand);
    } else {
      flushSafety();
    }
  }
  flushShortage();
  flushSafety();
  return { shortage, safety };
}

function simulateItem(item, params, startDate) {
  const horizon = params.horizonDays;
  const safetyStock = params.safetyStockBySku[item.sku];
  const forecast = Array.isArray(item.forecast) ? item.forecast : [];
  if (forecast.length === 0) throw new ValidationError(`商品 ${item.sku} 缺少销量预测`);
  const fallback = forecast.reduce((sum, value) => sum + value, 0) / forecast.length;

  const demandSeries = [];
  for (let day = 0; day < horizon; day += 1) {
    const baseline = day < forecast.length ? forecast[day] : fallback;
    demandSeries.push(Math.max(0, Math.round(baseline * params.demandMultiplier)));
  }

  const buckets = new Map();
  const pushReceipt = (day, entry) => {
    if (!Number.isFinite(day) || day < 0) return;
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(entry);
  };

  const overrides = new Map(
    params.inboundOverrides
      .filter((entry) => entry.sku === item.sku)
      .map((entry) => [entry.poId, entry]),
  );

  const cancelledOrders = [];
  for (const po of item.openOrders || []) {
    const override = overrides.get(po.id);
    if (override && override.action === 'cancel') {
      cancelledOrders.push({ poId: po.id, qty: po.qty, expectedDay: po.expectedDay });
      continue;
    }
    const promisedDay = po.expectedDay;
    let requestedDay = promisedDay + (override && override.action === 'delay' ? override.days : 0);
    const arrivalDay = applyDisruption(requestedDay, params.disruption);
    pushReceipt(arrivalDay, {
      source: 'po',
      qty: po.qty,
      poId: po.id,
      requestedDay,
      originalPromisedDay: promisedDay,
      lateDays: Math.max(0, arrivalDay - promisedDay),
      overrideDelay: override && override.action === 'delay' ? override.days : 0,
    });
  }

  let onHand = Number(item.onHand) || 0;
  let substituteOnHand = item.substitute ? Number(item.substitute.onHand) || 0 : 0;
  const substituteRatio = item.substitute && item.substitute.ratio > 0 ? item.substitute.ratio : 1;
  const substituteMaxShare = item.substitute
    ? Math.min(1, Math.max(0, Number(item.substitute.maxShare ?? 1)))
    : 0;

  const series = [];
  const orders = [];
  const receipts = [];
  let plannedTotal = 0;
  let returnsDelivered = 0;
  let returnsScheduled = 0;
  let substituteCoveredTotal = 0;
  let substituteUnitsTotal = 0;
  let lateOrders = 0;
  let lateDaysTotal = 0;
  let demandTotal = 0;
  let servedTotal = 0;
  let lostTotal = 0;

  for (let day = 0; day < horizon; day += 1) {
    const arrivals = buckets.get(day) || [];
    let receivedQty = 0;
    let returnQty = 0;
    for (const receipt of arrivals) {
      onHand += receipt.qty;
      if (receipt.source === 'return') {
        returnQty += receipt.qty;
        returnsDelivered += receipt.qty;
      } else {
        receivedQty += receipt.qty;
        if (receipt.source === 'po' && receipt.lateDays > 0) {
          lateOrders += 1;
          lateDaysTotal += receipt.lateDays;
        }
        receipts.push({
          day,
          date: addDays(startDate, day),
          qty: round2(receipt.qty),
          source: receipt.source,
          poId: receipt.poId ?? null,
          lateDays: receipt.lateDays ?? 0,
          promisedDay: receipt.originalPromisedDay ?? null,
          delayFromOverride: receipt.overrideDelay ?? 0,
        });
      }
    }

    const demand = demandSeries[day];
    const servedPrimary = Math.min(onHand, demand);
    onHand -= servedPrimary;
    let shortfall = demand - servedPrimary;
    let substituteCovered = 0;
    let substituteUnits = 0;

    if (
      shortfall > 0
      && params.substitution.enabled
      && item.substitute
      && substituteMaxShare > 0
    ) {
      const coverableByPolicy = Math.floor(shortfall * substituteMaxShare);
      const coverableByStock = Math.floor(substituteOnHand / substituteRatio);
      substituteCovered = Math.max(0, Math.min(coverableByPolicy, coverableByStock));
      if (substituteCovered > 0) {
        substituteUnits = round2(substituteCovered * substituteRatio);
        substituteOnHand = round2(substituteOnHand - substituteUnits);
        shortfall -= substituteCovered;
        substituteCoveredTotal += substituteCovered;
        substituteUnitsTotal += substituteUnits;
      }
    }

    const lost = shortfall;
    const served = servedPrimary + substituteCovered;

    if (params.returns.enabled && params.returns.ratePercent > 0 && servedPrimary > 0) {
      const returnQty = Math.round((servedPrimary * params.returns.ratePercent) / 100);
      if (returnQty > 0) {
        const returnDay = day + Math.max(1, params.returns.lagDays);
        pushReceipt(returnDay, { source: 'return', qty: returnQty });
        returnsScheduled += returnQty;
      }
    }

    let orderedToday = 0;
    let reorderPoint = null;
    let position = null;
    if (day % params.reviewPeriodDays === 0) {
      let leadDemand = 0;
      for (let offset = 0; offset < params.leadTimeDays; offset += 1) {
        const index = day + offset;
        leadDemand += index < horizon ? demandSeries[index] : demandSeries[horizon - 1];
      }
      let reviewDemand = 0;
      for (let offset = 0; offset < params.reviewPeriodDays; offset += 1) {
        const index = day + offset;
        reviewDemand += index < horizon ? demandSeries[index] : demandSeries[horizon - 1];
      }
      reorderPoint = round2(leadDemand + safetyStock);
      const inTransit = sumPipeline(buckets, day);
      position = round2(onHand + inTransit);
      if (position <= reorderPoint) {
        const target = reorderPoint + reviewDemand;
        // 先补到目标水位，再向上取整到批量倍数；最小批量本身也要取整，
        // 否则最小批量与批量倍数会互相冲突。
        let qty = Math.max(target - position, params.minOrderQty);
        qty = Math.ceil(qty / params.orderMultiple) * params.orderMultiple;
        if (qty > 0) {
          const requestedArrival = day + params.leadTimeDays;
          const arrivalDay = applyDisruption(requestedArrival, params.disruption);
          pushReceipt(arrivalDay, { source: 'plan', qty, poId: null });
          orderedToday = qty;
          plannedTotal += qty;
          orders.push({
            orderDay: day,
            orderDate: addDays(startDate, day),
            requestedArrivalDay: requestedArrival,
            arrivalDay,
            arrivalDate: addDays(startDate, arrivalDay),
            qty,
            delayedBy: arrivalDay - requestedArrival,
          });
        }
      }
    }

    const onOrder = sumPipeline(buckets, day);
    const row = {
      day,
      date: addDays(startDate, day),
      demand,
      served,
      servedPrimary,
      servedBySubstitute: substituteCovered,
      substituteUnits,
      lost,
      onHand: round2(onHand),
      onOrder: round2(onOrder),
      safetyStock,
      reorderPoint,
      position,
      orderedToday,
      receiptQty: round2(receivedQty),
      returnQty: round2(returnQty),
    };
    series.push(row);
    demandTotal += demand;
    servedTotal += served;
    lostTotal += lost;
  }

  const pendingLateOrders = [];
  for (const day of [...buckets.keys()].sort((a, b) => a - b)) {
    if (day < horizon) continue;
    for (const receipt of buckets.get(day) || []) {
      if (receipt.source === 'po' && receipt.lateDays > 0) {
        pendingLateOrders.push({ poId: receipt.poId, qty: receipt.qty, arrivalDay: day, lateDays: receipt.lateDays });
      }
    }
  }

  const stockoutDays = series.filter((row) => row.lost > 0).length;
  const shortageDays = series.filter((row) => row.lost + row.servedBySubstitute > 0).length;
  const safetyBreachDays = series.filter((row) => row.onHand < safetyStock).length;
  const avgOnHand = round2(series.reduce((sum, row) => sum + row.onHand, 0) / horizon);
  const gaps = buildGaps(series);
  const firstStockout = series.find((row) => row.lost > 0);

  const metrics = {
    demand: demandTotal,
    served: round2(servedTotal),
    lost: round2(lostTotal),
    fillRate: demandTotal > 0 ? round2((servedTotal / demandTotal) * 100) : 100,
    stockoutDays,
    shortageDays,
    safetyBreachDays,
    firstStockoutDay: firstStockout ? firstStockout.day : null,
    firstStockoutDate: firstStockout ? firstStockout.date : null,
    totalOrdered: round2(plannedTotal),
    orderCount: orders.length,
    avgOnHand,
    endingOnHand: series.length ? series[series.length - 1].onHand : round2(onHand),
    peakOnHand: series.reduce((peak, row) => Math.max(peak, row.onHand), 0),
    endingOnOrder: sumPipeline(buckets, horizon - 1),
    endingSubstitute: round2(substituteOnHand),
    substituteCovered: round2(substituteCoveredTotal),
    substituteUnits: round2(substituteUnitsTotal),
    returnsDelivered: round2(returnsDelivered),
    returnsScheduled: round2(returnsScheduled),
    lateOrders,
    lateDays: lateDaysTotal,
    pendingLateOrders: pendingLateOrders.length,
    cancelledOrders: cancelledOrders.length,
    safetyStock,
  };

  return {
    sku: item.sku,
    name: item.name,
    unit: item.unit || '件',
    substitute: item.substitute
      ? {
        sku: item.substitute.sku,
        name: item.substitute.name,
        ratio: substituteRatio,
        maxShare: substituteMaxShare,
      }
      : null,
    series,
    metrics,
    gaps,
    orders,
    receipts,
    cancelledOrders,
    pendingLateOrders,
  };
}

function aggregate(items, params) {
  const sum = (selector) => items.reduce((total, item) => total + selector(item), 0);
  const demand = sum((item) => item.metrics.demand);
  const served = sum((item) => item.metrics.served);
  const lost = sum((item) => item.metrics.lost);
  const worst = items.reduce(
    (current, item) => (item.metrics.fillRate < current.fillRate
      ? { sku: item.sku, name: item.name, fillRate: item.metrics.fillRate }
      : current),
    { sku: null, name: null, fillRate: 100 },
  );
  return {
    skuCount: items.length,
    demand,
    served: round2(served),
    lost: round2(lost),
    fillRate: demand > 0 ? round2((served / demand) * 100) : 100,
    worstFillRate: worst.fillRate,
    worstFillRateSku: worst.sku,
    worstFillRateName: worst.name,
    stockoutDays: sum((item) => item.metrics.stockoutDays),
    shortageDays: sum((item) => item.metrics.shortageDays),
    safetyBreachDays: sum((item) => item.metrics.safetyBreachDays),
    stockoutItems: items.filter((item) => item.metrics.stockoutDays > 0).length,
    totalOrdered: round2(sum((item) => item.metrics.totalOrdered)),
    orderCount: sum((item) => item.metrics.orderCount),
    avgOnHand: round2(sum((item) => item.metrics.avgOnHand)),
    endingOnHand: round2(sum((item) => item.metrics.endingOnHand)),
    peakOnHand: round2(sum((item) => item.metrics.peakOnHand)),
    endingOnOrder: round2(sum((item) => item.metrics.endingOnOrder)),
    substituteCovered: round2(sum((item) => item.metrics.substituteCovered)),
    substituteUnits: round2(sum((item) => item.metrics.substituteUnits)),
    returnsDelivered: round2(sum((item) => item.metrics.returnsDelivered)),
    lateOrders: sum((item) => item.metrics.lateOrders),
    lateDays: sum((item) => item.metrics.lateDays),
    pendingLateOrders: sum((item) => item.metrics.pendingLateOrders),
    cancelledOrders: sum((item) => item.metrics.cancelledOrders),
    horizonDays: params.horizonDays,
    leadTimeDays: params.leadTimeDays,
    minOrderQty: params.minOrderQty,
    orderMultiple: params.orderMultiple,
    reviewPeriodDays: params.reviewPeriodDays,
    safetyStockTotal: Object.values(params.safetyStockBySku).reduce((total, value) => total + value, 0),
  };
}

/**
 * Run a deterministic simulation. The returned object is content-addressed:
 * inputHash covers engine version + dataset data + normalised parameters;
 * resultHash covers the complete simulation output.
 */
export function simulate(dataset, rawParams) {
  if (!dataset || typeof dataset !== 'object') throw new ValidationError('缺少数据版本');
  const params = normalizeParams(rawParams, dataset);
  const datasetHash = hashDataset(dataset);
  const items = dataset.items.map((item) => {
    if (!Number.isFinite(Number(item.onHand))) throw new ValidationError(`商品 ${item.sku} 缺少期初库存`);
    return simulateItem(item, params, dataset.startDate);
  });
  const totals = aggregate(items, params);
  const core = {
    engineVersion: ENGINE_VERSION,
    datasetHash,
    datasetStartDate: dataset.startDate,
    parameters: params,
    items,
    totals,
  };
  return {
    ...core,
    inputHash: hashValue({
      engineVersion: ENGINE_VERSION,
      datasetHash,
      parameters: params,
    }),
    resultHash: hashValue(core),
  };
}

export function buildPlanLines(result) {
  const lines = [];
  for (const item of result.items) {
    for (const order of item.orders) {
      lines.push({
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        orderDay: order.orderDay,
        orderDate: order.orderDate,
        arrivalDay: order.arrivalDay,
        arrivalDate: order.arrivalDate,
        qty: order.qty,
      });
    }
  }
  lines.sort((a, b) => (a.orderDay - b.orderDay) || a.sku.localeCompare(b.sku));
  return lines;
}

export function buildPlanPayload({ scenarioId, scenarioName, result, planId, version, createdAt }) {
  const lines = buildPlanLines(result);
  return {
    id: planId,
    version,
    status: 'active',
    createdAt,
    scenarioName,
    source: {
      scenarioId,
      scenarioName,
      inputHash: result.inputHash,
      resultHash: result.resultHash,
      engineVersion: result.engineVersion,
      datasetHash: result.datasetHash,
      datasetStartDate: result.datasetStartDate,
    },
    parameters: result.parameters,
    totals: result.totals,
    items: result.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      metrics: item.metrics,
      substitute: item.substitute,
      orderCount: item.orders.length,
      firstStockoutDate: item.metrics.firstStockoutDate,
    })),
    lines,
    result: {
      engineVersion: result.engineVersion,
      datasetHash: result.datasetHash,
      datasetStartDate: result.datasetStartDate,
      parameters: result.parameters,
      totals: result.totals,
      items: result.items,
    },
  };
}

export const METRIC_DEFINITIONS = [
  { key: 'fillRate', label: '综合满足率', unit: '%', better: 'higher', digits: 1 },
  { key: 'lost', label: '缺口件数', unit: '件', better: 'lower', digits: 0 },
  { key: 'stockoutDays', label: '缺货商品·天', unit: '商品·天', better: 'lower', digits: 0 },
  { key: 'safetyBreachDays', label: '低于安全库存·天', unit: '商品·天', better: 'lower', digits: 0 },
  { key: 'substituteCovered', label: '替代品补足', unit: '件', better: 'neutral', digits: 0 },
  { key: 'totalOrdered', label: '补货下单量', unit: '件', better: 'neutral', digits: 0 },
  { key: 'avgOnHand', label: '平均在库', unit: '件', better: 'neutral', digits: 1 },
  { key: 'endingOnHand', label: '期末在库', unit: '件', better: 'neutral', digits: 1 },
  { key: 'lateOrders', label: '迟到订单', unit: '单', better: 'lower', digits: 0 },
  { key: 'returnsDelivered', label: '退货回流', unit: '件', better: 'neutral', digits: 0 },
];

export function diffPlans(basePlan, candidatePlan) {
  const baseLines = basePlan?.lines || [];
  const candidateLines = candidatePlan?.lines || [];
  const keyOf = (line) => `${line.sku}@${line.orderDay}`;
  const baseMap = new Map(baseLines.map((line) => [keyOf(line), line]));
  const candidateMap = new Map(candidateLines.map((line) => [keyOf(line), line]));

  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, line] of candidateMap) {
    const base = baseMap.get(key);
    if (!base) {
      added.push(line);
    } else if (base.qty !== line.qty || base.arrivalDay !== line.arrivalDay) {
      changed.push({ ...line, from: { qty: base.qty, arrivalDay: base.arrivalDay, arrivalDate: base.arrivalDate } });
    }
  }
  for (const [key, line] of baseMap) {
    if (!candidateMap.has(key)) removed.push(line);
  }

  const metricRows = METRIC_DEFINITIONS.map((definition) => {
    const baseValue = basePlan?.totals?.[definition.key] ?? 0;
    const candidateValue = candidatePlan?.totals?.[definition.key] ?? 0;
    const delta = round2(candidateValue - baseValue);
    const pct = baseValue === 0 ? null : round2((delta / baseValue) * 100);
    return {
      ...definition,
      base: baseValue,
      candidate: candidateValue,
      delta,
      pct,
      direction: delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down',
    };
  });

  const summaryParts = [];
  if (added.length) summaryParts.push(`新增 ${added.length} 条补货单`);
  if (changed.length) summaryParts.push(`调整 ${changed.length} 条`);
  if (removed.length) summaryParts.push(`移除 ${removed.length} 条`);
  if (!summaryParts.length) summaryParts.push('补货单无变化');
  const fillDelta = round2((candidatePlan?.totals?.fillRate ?? 0) - (basePlan?.totals?.fillRate ?? 0));
  summaryParts.push(`满足率 ${fillDelta >= 0 ? '+' : ''}${fillDelta.toFixed(1)}pp`);

  return {
    basePlan: basePlan
      ? { id: basePlan.id, version: basePlan.version, inputHash: basePlan.source?.inputHash ?? null, createdAt: basePlan.createdAt }
      : null,
    candidate: {
      scenarioId: candidatePlan?.source?.scenarioId ?? null,
      scenarioName: candidatePlan?.source?.scenarioName ?? null,
      inputHash: candidatePlan?.source?.inputHash ?? null,
      resultHash: candidatePlan?.source?.resultHash ?? null,
    },
    lines: {
      added,
      removed,
      changed,
      unchanged: candidateLines.length - added.length - changed.length,
    },
    metrics: metricRows,
    summary: summaryParts.join('，'),
  };
}

export function verifyScenario(storedSnapshot, storedInputHash, storedResultHash) {
  const recomputed = simulate(storedSnapshot.dataset, storedSnapshot.params);
  return {
    ok: recomputed.inputHash === storedInputHash && recomputed.resultHash === storedResultHash,
    engineVersion: ENGINE_VERSION,
    storedInputHash,
    storedResultHash,
    recomputedInputHash: recomputed.inputHash,
    recomputedResultHash: recomputed.resultHash,
    inputMatches: recomputed.inputHash === storedInputHash,
    resultMatches: recomputed.resultHash === storedResultHash,
  };
}
