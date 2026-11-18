import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashDataset, simulate, buildPlanPayload, hashValue, canonicalJSON, normalizeParams } from './engine.js';

const nowIso = () => new Date().toISOString();

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null;
  return JSON.parse(value);
}

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS dataset_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      dataset_json TEXT NOT NULL,
      dataset_hash TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(dataset_hash)
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      params_json TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      input_hash TEXT,
      result_hash TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      result_json TEXT,
      snapshot_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      simulated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      scenario_id INTEGER REFERENCES scenarios(id),
      scenario_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL REFERENCES scenarios(id),
      scenario_name TEXT NOT NULL,
      base_plan_id INTEGER REFERENCES plans(id),
      diff_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      decision_by TEXT,
      decision_note TEXT NOT NULL DEFAULT '',
      plan_version INTEGER,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      detail_json TEXT
    );
  `);

  const stmt = {
    insertDataset: db.prepare(
      'INSERT INTO dataset_versions (name, start_date, dataset_json, dataset_hash, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    listDatasets: db.prepare(
      'SELECT id, name, start_date, dataset_hash, note, created_at FROM dataset_versions ORDER BY id DESC',
    ),
    getDataset: db.prepare('SELECT * FROM dataset_versions WHERE id = ?'),
    insertScenario: db.prepare(`
      INSERT INTO scenarios (name, description, dataset_version_id, params_json, params_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
    `),
    listScenarios: db.prepare(`
      SELECT s.*, d.name AS dataset_name, d.dataset_hash AS dataset_hash
      FROM scenarios s JOIN dataset_versions d ON d.id = s.dataset_version_id
      ORDER BY s.id ASC
    `),
    getScenario: db.prepare(`
      SELECT s.*, d.name AS dataset_name, d.dataset_hash AS dataset_hash, d.dataset_json AS dataset_json
      FROM scenarios s JOIN dataset_versions d ON d.id = s.dataset_version_id
      WHERE s.id = ?
    `),
    updateScenarioSimulation: db.prepare(`
      UPDATE scenarios SET status = 'simulated', result_json = ?, snapshot_json = ?, input_hash = ?,
        result_hash = ?, simulated_at = ?, updated_at = ? WHERE id = ?
    `),
    updateScenarioMeta: db.prepare('UPDATE scenarios SET name = ?, description = ?, params_json = ?, params_hash = ?, updated_at = ? WHERE id = ?'),
    updateScenarioStatus: db.prepare('UPDATE scenarios SET status = ?, updated_at = ? WHERE id = ?'),
    deleteScenario: db.prepare("DELETE FROM scenarios WHERE id = ? AND status IN ('draft','simulated')"),
    insertPlan: db.prepare(`
      INSERT INTO plans (version, status, scenario_id, scenario_name, input_hash, result_hash, payload_json, created_at)
      VALUES (?, 'active', ?, ?, ?, ?, ?, ?)
    `),
    supersedePlans: db.prepare("UPDATE plans SET status = 'superseded' WHERE status = 'active'"),
    listPlans: db.prepare('SELECT id, version, status, scenario_id, scenario_name, input_hash, result_hash, created_at FROM plans ORDER BY version DESC'),
    getPlan: db.prepare('SELECT * FROM plans WHERE id = ?'),
    getActivePlan: db.prepare("SELECT * FROM plans WHERE status = 'active' ORDER BY version DESC LIMIT 1"),
    insertApproval: db.prepare(`
      INSERT INTO approvals (scenario_id, scenario_name, base_plan_id, diff_json, status, requested_by, note, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `),
    listApprovals: db.prepare(`
      SELECT a.*, p.version AS resulting_plan_version
      FROM approvals a LEFT JOIN plans p ON p.version = a.plan_version
      ORDER BY a.id DESC
    `),
    getApproval: db.prepare('SELECT * FROM approvals WHERE id = ?'),
    pendingApprovalForScenario: db.prepare("SELECT * FROM approvals WHERE scenario_id = ? AND status = 'pending'"),
    decideApproval: db.prepare(`
      UPDATE approvals SET status = ?, decision_by = ?, decision_note = ?, plan_version = ?, decided_at = ? WHERE id = ?
    `),
    insertAudit: db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)'),
    listAudit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'),
  };

  const dbc = {
    raw: db,
    close: () => db.close(),
    audit(actor, action, entity, entityId, detail) {
      stmt.insertAudit.run(nowIso(), actor || 'system', action, entity, entityId ?? null, JSON.stringify(detail ?? {}));
    },
    addDataset({ name, dataset, note = '' }) {
      const hash = hashDataset(dataset);
      const existing = db.prepare('SELECT id FROM dataset_versions WHERE dataset_hash = ?').get(hash);
      if (existing) return { id: existing.id, hash, existing: true };
      const result = stmt.insertDataset.run(name, dataset.startDate, canonicalJSON(dataset), hash, note, nowIso());
      return { id: Number(result.lastInsertRowid), hash, existing: false };
    },
    listDatasets() {
      return stmt.listDatasets.all().map((row) => ({
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        hash: row.dataset_hash,
        note: row.note,
        createdAt: row.created_at,
      }));
    },
    getDataset(id) {
      let row = null;
      if (id) {
        row = stmt.getDataset.get(id) ?? null;
      } else {
        const latest = db.prepare('SELECT id FROM dataset_versions ORDER BY id DESC LIMIT 1').get();
        row = latest ? stmt.getDataset.get(latest.id) : null;
      }
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        dataset: parseJson(row.dataset_json),
        hash: row.dataset_hash,
        note: row.note,
        createdAt: row.created_at,
      };
    },
    createScenario({ name, description = '', datasetVersionId, params, actor = 'planner' }) {
      const dataset = dbc.getDataset(datasetVersionId);
      if (!dataset) return null;
      const paramsHash = hashValue(params);
      const timestamp = nowIso();
      const result = stmt.insertScenario.run(name, description, dataset.id, canonicalJSON(params), paramsHash, timestamp, timestamp);
      const id = Number(result.lastInsertRowid);
      dbc.audit(actor, 'scenario.create', 'scenario', id, { name, datasetVersionId: dataset.id, paramsHash });
      return dbc.getScenario(id);
    },
    getScenario(id) {
      const row = stmt.getScenario.get(id);
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        datasetVersionId: row.dataset_version_id,
        datasetName: row.dataset_name,
        datasetHash: row.dataset_hash,
        params: parseJson(row.params_json),
        paramsHash: row.params_hash,
        inputHash: row.input_hash,
        resultHash: row.result_hash,
        status: row.status,
        result: parseJson(row.result_json),
        snapshot: parseJson(row.snapshot_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        simulatedAt: row.simulated_at,
      };
    },
    listScenarios() {
      return stmt.listScenarios.all().map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        datasetVersionId: row.dataset_version_id,
        datasetName: row.dataset_name,
        datasetHash: row.dataset_hash,
        params: parseJson(row.params_json),
        paramsHash: row.params_hash,
        inputHash: row.input_hash,
        resultHash: row.result_hash,
        status: row.status,
        totals: row.result_json ? parseJson(row.result_json).totals : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        simulatedAt: row.simulated_at,
      }));
    },
    updateScenario(id, { name, description, params, datasetVersionId, actor = 'planner' }) {
      const scenario = dbc.getScenario(id);
      if (!scenario) return { error: 'not_found' };
      if (scenario.status === 'confirmed' || scenario.status === 'pending_approval') return { error: 'locked' };
      const dataset = datasetVersionId && datasetVersionId !== scenario.datasetVersionId
        ? dbc.getDataset(datasetVersionId)
        : null;
      if (datasetVersionId && !dataset) return { error: 'dataset_not_found' };
      // 数据版本变化会影响参数校验（安全库存按 SKU），必须重新规范化。
      const effectiveParams = params ?? scenario.params;
      const normalized = dataset ? normalizeParams(effectiveParams, dataset.dataset) : effectiveParams;
      const paramsHash = hashValue(normalized);
      const paramsChanged = paramsHash !== scenario.paramsHash;
      const datasetChanged = Boolean(dataset);
      stmt.updateScenarioMeta.run(
        name ?? scenario.name,
        description ?? scenario.description,
        canonicalJSON(normalized),
        paramsHash,
        nowIso(),
        id,
      );
      if (datasetChanged || paramsChanged) {
        db.prepare("UPDATE scenarios SET dataset_version_id = COALESCE(?, dataset_version_id), status = 'draft', result_json = NULL, snapshot_json = NULL, input_hash = NULL, result_hash = NULL WHERE id = ?")
          .run(dataset?.id ?? null, id);
      }
      dbc.audit(actor, 'scenario.update', 'scenario', id, {
        paramsHash,
        paramsChanged,
        datasetVersionId: dataset?.id ?? scenario.datasetVersionId,
      });
      return { scenario: dbc.getScenario(id) };
    },
    simulateScenario(id, actor = 'planner') {
      const scenario = dbc.getScenario(id);
      if (!scenario) return { error: 'not_found' };
      if (scenario.status === 'confirmed' || scenario.status === 'pending_approval') return { error: 'locked' };
      const fullDataset = dbc.getDataset(scenario.datasetVersionId);
      if (!fullDataset) return { error: 'dataset_not_found' };
      const result = simulate(fullDataset.dataset, scenario.params);
      const snapshot = {
        params: scenario.params,
        dataset: fullDataset.dataset,
        datasetVersion: {
          id: fullDataset.id,
          name: fullDataset.name,
          hash: fullDataset.hash,
          startDate: fullDataset.startDate,
        },
        paramsHash: scenario.paramsHash,
      };
      const timestamp = nowIso();
      stmt.updateScenarioSimulation.run(
        canonicalJSON(result),
        canonicalJSON(snapshot),
        result.inputHash,
        result.resultHash,
        timestamp,
        timestamp,
        id,
      );
      dbc.audit(actor, 'scenario.simulate', 'scenario', id, {
        inputHash: result.inputHash,
        resultHash: result.resultHash,
        datasetHash: result.datasetHash,
      });
      return { scenario: dbc.getScenario(id), result };
    },
    deleteScenario(id, actor = 'planner') {
      const scenario = dbc.getScenario(id);
      if (!scenario) return { error: 'not_found' };
      if (scenario.status === 'confirmed' || scenario.status === 'pending_approval') return { error: 'locked' };
      const changes = Number(stmt.deleteScenario.run(id).changes || 0);
      if (changes) dbc.audit(actor, 'scenario.delete', 'scenario', id, { name: scenario.name });
      return changes ? { ok: true } : { error: 'locked' };
    },
    listPlans() {
      return stmt.listPlans.all().map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status,
        scenarioId: row.scenario_id,
        scenarioName: row.scenario_name,
        inputHash: row.input_hash,
        resultHash: row.result_hash,
        createdAt: row.created_at,
      }));
    },
    getPlan(id) {
      const row = stmt.getPlan.get(id);
      if (!row) return null;
      return {
        id: row.id,
        version: row.version,
        status: row.status,
        scenarioId: row.scenario_id,
        scenarioName: row.scenario_name,
        inputHash: row.input_hash,
        resultHash: row.result_hash,
        payload: parseJson(row.payload_json),
        createdAt: row.created_at,
      };
    },
    getActivePlan() {
      const row = stmt.getActivePlan.get();
      return row ? dbc.getPlan(row.id) : null;
    },
    nextPlanVersion() {
      const row = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plans').get();
      return row.next;
    },
    createPlanFromScenario(scenario, { actor = 'approver' } = {}) {
      const version = dbc.nextPlanVersion();
      const payload = buildPlanPayload({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        result: scenario.result,
        planId: version,
        version,
        createdAt: nowIso(),
      });
      stmt.supersedePlans.run();
      const result = stmt.insertPlan.run(
        version,
        scenario.id,
        scenario.name,
        scenario.inputHash,
        scenario.resultHash,
        canonicalJSON(payload),
        nowIso(),
      );
      const planId = Number(result.lastInsertRowid);
      db.prepare("UPDATE scenarios SET status = 'confirmed', updated_at = ? WHERE id = ?").run(nowIso(), scenario.id);
      dbc.audit(actor, 'plan.create', 'plan', planId, { version, scenarioId: scenario.id, inputHash: scenario.inputHash });
      return dbc.getPlan(planId);
    },
    createApproval({ scenario, basePlan, diff, requestedBy, note = '' }) {
      const result = stmt.insertApproval.run(
        scenario.id,
        scenario.name,
        basePlan?.id ?? null,
        canonicalJSON(diff),
        requestedBy || 'planner',
        note,
        nowIso(),
      );
      const id = Number(result.lastInsertRowid);
      db.prepare("UPDATE scenarios SET status = 'pending_approval', updated_at = ? WHERE id = ?").run(nowIso(), scenario.id);
      dbc.audit(requestedBy || 'planner', 'approval.request', 'approval', id, {
        scenarioId: scenario.id,
        basePlanId: basePlan?.id ?? null,
        basePlanVersion: basePlan?.version ?? null,
      });
      return dbc.getApproval(id);
    },
    pendingApprovalForScenario: (scenarioId) => stmt.pendingApprovalForScenario.get(scenarioId) || null,
    listApprovals() {
      return stmt.listApprovals.all().map((row) => ({
        id: row.id,
        scenarioId: row.scenario_id,
        scenarioName: row.scenario_name,
        basePlanId: row.base_plan_id,
        diff: parseJson(row.diff_json),
        status: row.status,
        requestedBy: row.requested_by,
        note: row.note,
        decisionBy: row.decision_by,
        decisionNote: row.decision_note,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        resultingPlanVersion: row.resulting_plan_version ?? row.plan_version ?? null,
      }));
    },
    getApproval(id) {
      const row = stmt.getApproval.get(id);
      if (!row) return null;
      return {
        id: row.id,
        scenarioId: row.scenario_id,
        scenarioName: row.scenario_name,
        basePlanId: row.base_plan_id,
        diff: parseJson(row.diff_json),
        status: row.status,
        requestedBy: row.requested_by,
        note: row.note,
        decisionBy: row.decision_by,
        decisionNote: row.decision_note,
        planVersion: row.plan_version,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
      };
    },
    decideApproval(id, { status, decidedBy, note = '', scenario, actor = 'approver' }) {
      const approval = dbc.getApproval(id);
      if (!approval) return { error: 'not_found' };
      if (approval.status !== 'pending') return { error: 'already_decided' };
      let plan = null;
      if (status === 'approved') {
        plan = dbc.createPlanFromScenario(scenario, { actor: decidedBy });
      } else {
        db.prepare("UPDATE scenarios SET status = 'simulated', updated_at = ? WHERE id = ?").run(nowIso(), scenario.id);
      }
      stmt.decideApproval.run(
        status,
        decidedBy,
        note,
        plan?.version ?? null,
        nowIso(),
        id,
      );
      dbc.audit(decidedBy, status === 'approved' ? 'approval.approve' : 'approval.reject', 'approval', id, {
        scenarioId: scenario.id,
        planVersion: plan?.version ?? null,
        note,
      });
      return { approval: dbc.getApproval(id), plan };
    },
    auditLog: (limit = 100) => stmt.listAudit.all(limit).map((row) => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      detail: parseJson(row.detail_json),
    })),
  };

  return dbc;
}
