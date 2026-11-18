import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import {
  ValidationError,
  normalizeParams,
  simulate,
  verifyScenario,
  diffPlans,
  buildPlanLines,
  hashValue,
  hashDataset,
  METRIC_DEFINITIONS,
  ENGINE_VERSION,
} from './engine.js';
import { buildDataset, DEMO_PARAMS, DEMO_SCENARIOS } from './seed-data.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'inventory.db');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createApp({ dbPath = DB_PATH, seed = true } = {}) {
  const db = openDatabase(dbPath);
  if (seed) seedIfEmpty(db);

  async function handleApi(req, res, url) {
    const actor = String(req.headers['x-actor'] || 'planner').slice(0, 60);
    const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const method = req.method;
    const readBody = async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 5_000_000) throw new ValidationError('请求体过大');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch {
        throw new ValidationError('请求体不是合法 JSON');
      }
    };

    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };

    try {
      // ---- meta ----
      if (segments[0] === 'meta' && method === 'GET') {
        return send(200, {
          engineVersion: ENGINE_VERSION,
          metricDefinitions: METRIC_DEFINITIONS,
          actor,
        });
      }

      // ---- datasets ----
      if (segments[0] === 'datasets') {
        if (segments.length === 1 && method === 'GET') return send(200, { datasets: db.listDatasets() });
        if (segments.length === 1 && method === 'POST') {
          const body = await readBody();
          if (!body.dataset || !body.dataset.startDate || !Array.isArray(body.dataset.items)) {
            throw new ValidationError('dataset 必须包含 startDate 与 items');
          }
          const gained = db.addDataset({ name: String(body.name || '未命名数据版本'), dataset: body.dataset, note: String(body.note || '') });
          db.audit(actor, 'dataset.import', 'dataset', gained.id, { hash: gained.hash, existing: gained.existing });
          return send(gained.existing ? 200 : 201, { id: gained.id, hash: gained.hash, existing: gained.existing, datasets: db.listDatasets() });
        }
        if (segments[1] && method === 'GET') {
          const dataset = db.getDataset(Number(segments[1]));
          if (!dataset) return send(404, { error: '数据版本不存在' });
          return send(200, { dataset });
        }
      }

      // ---- scenarios ----
      if (segments[0] === 'scenarios') {
        if (segments.length === 1 && method === 'GET') {
          return send(200, { scenarios: db.listScenarios() });
        }
        if (segments.length === 1 && method === 'POST') {
          const body = await readBody();
          if (!body.name) throw new ValidationError('方案名称必填');
          const datasetId = Number(body.datasetVersionId || db.listDatasets()[0]?.id);
          const dataset = db.getDataset(datasetId);
          if (!dataset) throw new ValidationError('数据版本不存在');
          const params = normalizeParams(body.params ?? {}, dataset.dataset);
          const scenario = db.createScenario({
            name: String(body.name).slice(0, 120),
            description: String(body.description || '').slice(0, 500),
            datasetVersionId: datasetId,
            params,
            actor,
          });
          return send(201, { scenario });
        }
        const id = Number(segments[1]);
        if (segments.length === 2 && method === 'GET') {
          const scenario = db.getScenario(id);
          if (!scenario) return send(404, { error: '方案不存在' });
          return send(200, { scenario });
        }
        if (segments.length === 2 && method === 'PATCH') {
          const body = await readBody();
          const current = db.getScenario(id);
          if (!current) return send(404, { error: '方案不存在' });
          const datasetId = Number(body.datasetVersionId || current.datasetVersionId);
          const dataset = db.getDataset(datasetId);
          if (!dataset) throw new ValidationError('数据版本不存在');
          const params = body.params
            ? normalizeParams(body.params, dataset.dataset)
            : (Number(body.datasetVersionId) && Number(body.datasetVersionId) !== current.datasetVersionId
              ? normalizeParams(current.params, dataset.dataset)
              : undefined);
          const outcome = db.updateScenario(id, {
            name: body.name ? String(body.name).slice(0, 120) : undefined,
            description: body.description !== undefined ? String(body.description).slice(0, 500) : undefined,
            params,
            datasetVersionId: body.datasetVersionId ? Number(body.datasetVersionId) : undefined,
            actor,
          });
          if (outcome.error === 'not_found') return send(404, { error: '方案不存在' });
          if (outcome.error === 'locked') return send(409, { error: '方案已确认，不可修改；请另建情景' });
          return send(200, outcome);
        }
        if (segments.length === 2 && method === 'DELETE') {
          const outcome = db.deleteScenario(id, actor);
          if (outcome.error === 'not_found') return send(404, { error: '方案不存在' });
          if (outcome.error === 'locked') return send(409, { error: '方案已进入审批或确认阶段，不可删除' });
          return send(200, { ok: true });
        }
        if (segments[2] === 'simulate' && method === 'POST') {
          const outcome = db.simulateScenario(id, actor);
          if (outcome.error === 'not_found') return send(404, { error: '方案不存在' });
          if (outcome.error === 'locked') return send(409, { error: '方案已确认，不可重新模拟' });
          return send(200, outcome);
        }
        if (segments[2] === 'verify' && method === 'POST') {
          const scenario = db.getScenario(id);
          if (!scenario) return send(404, { error: '方案不存在' });
          if (!scenario.snapshot) throw new ValidationError('方案尚未模拟，无可复现记录');
          const verification = verifyScenario(scenario.snapshot, scenario.inputHash, scenario.resultHash);
          db.audit(actor, 'scenario.verify', 'scenario', id, verification);
          return send(200, { verification });
        }
        if (segments[2] === 'compare') {
          const scenario = db.getScenario(id);
          if (!scenario) return send(404, { error: '方案不存在' });
          if (!scenario.result) throw new ValidationError('方案尚未模拟');
          const otherId = Number(url.searchParams.get('against'));
          const other = otherId ? db.getScenario(otherId) : null;
          if (otherId && (!other || !other.result)) throw new ValidationError('对比方案不存在或尚未模拟');
          const base = other
            ? { totals: other.result.totals, items: other.result.items, lines: buildPlanLines(other.result) }
            : db.getActivePlan()?.payload ?? null;
          if (!base) throw new ValidationError('没有可对比的正式计划，请指定 against 参数');
          const candidate = { totals: scenario.result.totals, items: scenario.result.items, lines: buildPlanLines(scenario.result) };
          return send(200, {
            base: other
              ? { type: 'scenario', id: other.id, name: other.name, totals: base.totals }
              : { type: 'plan', ...base },
            candidate: { id: scenario.id, name: scenario.name, totals: candidate.totals },
            metrics: compareMetrics(base.totals, candidate.totals),
            items: compareItems(base.items, candidate.items),
            lines: diffPlans({ lines: base.lines ?? [] }, { lines: candidate.lines }).lines,
          });
        }
        if (segments[2] === 'request-approval' && method === 'POST') {
          const body = await readBody();
          const scenario = db.getScenario(id);
          if (!scenario) return send(404, { error: '方案不存在' });
          if (!scenario.result) throw new ValidationError('方案尚未模拟，不能提交审批');
          if (db.pendingApprovalForScenario(id)) return send(409, { error: '该方案已有待审批申请' });
          const activePlan = db.getActivePlan();
          const planForDiff = activePlan?.payload
            ?? (body.basePlanId ? db.getPlan(Number(body.basePlanId))?.payload : null);
          const diff = diffPlans(planForDiff, {
            totals: scenario.result.totals,
            lines: buildPlanLines(scenario.result),
            source: {
              scenarioId: scenario.id,
              scenarioName: scenario.name,
              inputHash: scenario.result.inputHash,
              resultHash: scenario.result.resultHash,
            },
          });
          const approval = db.createApproval({
            scenario,
            basePlan: activePlan,
            diff,
            requestedBy: body.requestedBy || actor,
            note: String(body.note || ''),
          });
          return send(201, { approval });
        }
      }

      // ---- plans ----
      if (segments[0] === 'plans') {
        if (segments.length === 1 && method === 'GET') {
          return send(200, { plans: db.listPlans(), activePlan: db.getActivePlan() });
        }
        const id = Number(segments[1]);
        if (segments.length === 2 && method === 'GET') {
          const plan = db.getPlan(id);
          if (!plan) return send(404, { error: '计划不存在' });
          return send(200, { plan });
        }
      }

      // ---- approvals ----
      if (segments[0] === 'approvals') {
        if (segments.length === 1 && method === 'GET') {
          return send(200, { approvals: db.listApprovals() });
        }
        const id = Number(segments[1]);
        if (segments.length === 2 && method === 'GET') {
          const approval = db.getApproval(id);
          if (!approval) return send(404, { error: '审批记录不存在' });
          return send(200, { approval });
        }
        if (segments[2] === 'decide' && method === 'POST') {
          const body = await readBody();
          const approval = db.getApproval(id);
          if (!approval) return send(404, { error: '审批记录不存在' });
          const scenario = db.getScenario(approval.scenarioId);
          if (!scenario) return send(404, { error: '关联方案不存在' });
          if (approval.status !== 'pending') return send(409, { error: '该审批已处理' });
          if (body.decision === 'approve') {
            if (scenario.inputHash !== scenario.result?.inputHash || scenario.resultHash !== scenario.result?.resultHash) {
              return send(409, { error: '方案哈希不一致，拒绝生成计划' });
            }
            if (!scenario.snapshot) return send(409, { error: '方案缺少快照，无法复现' });
            const verification = verifyScenario(scenario.snapshot, scenario.inputHash, scenario.resultHash);
            if (!verification.ok) {
              db.audit(actor, 'approval.verify_failed', 'approval', id, verification);
              return send(409, { error: '快照复现校验失败，结果与存档哈希不一致，拒绝生成计划' });
            }
          }
          if (!body.decision || !['approve', 'reject'].includes(body.decision)) {
            throw new ValidationError('decision 必须是 approve 或 reject');
          }
          if (!body.decidedBy) throw new ValidationError('审批人必填');
          if (body.decision === 'approve') {
            // 审批期间正式计划若已变化，差异记录就不再可信，必须重新提交。
            const activePlan = db.getActivePlan();
            if ((activePlan?.id ?? null) !== approval.basePlanId) {
              return send(409, {
                error: activePlan
                  ? `审批基线已变化：申请基于计划 ${approval.basePlanId ? `#${approval.basePlanId}` : '（无）'}，当前正式计划为 v${activePlan.version}，请重新提交审批`
                  : '审批基线已变化：正式计划已被移除，请重新提交审批',
              });
            }
          }
          const outcome = db.decideApproval(id, {
            status: body.decision === 'approve' ? 'approved' : 'rejected',
            decidedBy: String(body.decidedBy).slice(0, 60),
            note: String(body.decisionNote || ''),
            scenario,
          });
          if (outcome.error) return send(409, { error: outcome.error });
          return send(200, outcome);
        }
      }

      // ---- audit ----
      if (segments[0] === 'audit' && method === 'GET') {
        return send(200, { entries: db.auditLog(Number(url.searchParams.get('limit') || 60)) });
      }

      return send(404, { error: '接口不存在' });
    } catch (error) {
      if (error instanceof ValidationError) {
        return send(error.status || 400, { error: error.message, details: error.details ?? null });
      }
      console.error(error);
      return send(500, { error: '服务器内部错误' });
    }
  }

  async function handleStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return handleStatic(req, res, url);
  });

  return {
    server,
    db,
    listen: (port = PORT) => new Promise((resolvePromise) => {
      server.listen(port, () => resolvePromise(server.address().port));
    }),
    close: async () => {
      await new Promise((resolvePromise) => server.close(resolvePromise));
      db.close();
    },
  };
}

export function compareMetrics(baseTotals, candidateTotals) {
  return METRIC_DEFINITIONS.map((definition) => {
    const base = baseTotals?.[definition.key] ?? 0;
    const candidate = candidateTotals?.[definition.key] ?? 0;
    const delta = Math.round((candidate - base) * 100) / 100;
    return {
      ...definition,
      base,
      candidate,
      delta,
      direction: delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down',
      betterDirection: definition.better === 'neutral'
        ? 'neutral'
        : (delta === 0 ? 'flat' : (definition.better === 'higher') === (delta > 0) ? 'better' : 'worse'),
    };
  });
}

export function compareItems(baseItems, candidateItems) {
  const baseMap = new Map((baseItems || []).map((item) => [item.sku, item]));
  return (candidateItems || []).map((item) => {
    const base = baseMap.get(item.sku);
    const baseMetrics = base?.metrics ?? {};
    return {
      sku: item.sku,
      name: item.name,
      fillRate: item.metrics.fillRate,
      fillRateBase: baseMetrics.fillRate ?? null,
      lost: item.metrics.lost,
      lostBase: baseMetrics.lost ?? null,
      stockoutDays: item.metrics.stockoutDays,
      stockoutDaysBase: baseMetrics.stockoutDays ?? null,
      totalOrdered: item.metrics.totalOrdered,
      totalOrderedBase: baseMetrics.totalOrdered ?? null,
      substituteCovered: item.metrics.substituteCovered,
      lateOrders: item.metrics.lateOrders,
      firstStockoutDate: item.metrics.firstStockoutDate,
    };
  });
}

export function seedIfEmpty(db) {
  if (db.listDatasets().length === 0) {
    const dataset = buildDataset();
    db.addDataset({ name: '演示数据 v1（2026-11-02 起）', dataset, note: '内置演示：5 个 SKU，42 天销量预测' });
    const datasetId = db.listDatasets()[0].id;
    for (const scenario of DEMO_SCENARIOS) {
      const created = db.createScenario({
        name: scenario.name,
        description: scenario.description,
        datasetVersionId: datasetId,
        params: scenario.params,
        actor: 'seed',
      });
      db.simulateScenario(created.id, 'seed');
    }
    const baseline = db.listScenarios().find((scenario) => scenario.name === '基准方案');
    const full = db.getScenario(baseline.id);
    const plan = db.createPlanFromScenario(full, { actor: 'seed' });
    db.audit('seed', 'system.seed', 'plan', plan.id, { version: plan.version });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(PORT).then((port) => {
    console.log(`库存补货情景模拟已启动：http://localhost:${port}`);
  });
}
