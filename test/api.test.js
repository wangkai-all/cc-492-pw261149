import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { buildDataset, DEMO_PARAMS } from '../src/seed-data.js';

async function withApp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-test-'));
  const app = createApp({ dbPath: join(dir, 'test.db'), seed: true });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}/api${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-actor': 'tester', ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };
  try {
    await run({ request, base, app });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('种子数据创建方案与一份正式计划', async () => {
  await withApp(async ({ request }) => {
    const scenarios = await request('/scenarios');
    assert.equal(scenarios.status, 200);
    assert.equal(scenarios.body.scenarios.length, 5);
    const statuses = scenarios.body.scenarios.map((scenario) => scenario.status);
    assert.equal(statuses.filter((status) => status === 'simulated').length, 4, '其余方案保持已模拟');
    assert.equal(statuses.filter((status) => status === 'confirmed').length, 1, '种子基线转为正式计划');
    const plans = await request('/plans');
    assert.equal(plans.body.plans.length, 1);
    assert.equal(plans.body.plans[0].status, 'active');
    assert.ok(plans.body.activePlan);
  });
});

test('模拟结果不覆盖正式计划', async () => {
  await withApp(async ({ request }) => {
    const before = await request('/plans');
    const activeBefore = before.body.activePlan;
    const planCountBefore = before.body.plans.length;

    // 修改一个方案参数并重跑模拟
    const scenario = await request('/scenarios/2');
    const params = { ...scenario.body.scenario.params, demandMultiplier: 1.8 };
    const patched = await request('/scenarios/2', { method: 'PATCH', body: JSON.stringify({ params }) });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.scenario.status, 'draft');
    assert.equal(patched.body.scenario.result, null, '参数变更后旧结果应清空');

    const simulated = await request('/scenarios/2/simulate', { method: 'POST' });
    assert.equal(simulated.status, 200);
    assert.equal(simulated.body.scenario.status, 'simulated');
    assert.ok(simulated.body.result.resultHash);

    const after = await request('/plans');
    assert.equal(after.body.plans.length, planCountBefore, '正式计划数量不应变化');
    assert.equal(after.body.activePlan.id, activeBefore.id);
    assert.equal(after.body.activePlan.version, activeBefore.version);
    assert.equal(after.body.activePlan.resultHash, activeBefore.resultHash, '正式计划内容不应被模拟覆盖');
  });
});

test('审批通过后生成新计划版本并替代旧版本', async () => {
  await withApp(async ({ request }) => {
    const request1 = await request('/scenarios/3/request-approval', {
      method: 'POST',
      body: JSON.stringify({ requestedBy: 'alice', note: '中断演练' }),
    });
    assert.equal(request1.status, 201);
    const approval = request1.body.approval;
    assert.equal(approval.status, 'pending');
    assert.ok(approval.diff.lines.added.length + approval.diff.lines.changed.length + approval.diff.lines.removed.length > 0);
    assert.ok(approval.diff.candidate.inputHash);
    assert.ok(approval.diff.candidate.resultHash);

    // 审批中方案不能再提交
    const duplicate = await request('/scenarios/3/request-approval', { method: 'POST', body: '{}' });
    assert.equal(duplicate.status, 409);

    // 待审批时不能修改参数
    const patch = await request('/scenarios/3', { method: 'PATCH', body: JSON.stringify({ name: '改名' }) });
    assert.notEqual(patch.status, 200, '审批中的方案不应允许改名');

    const decision = await request(`/approvals/${approval.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', decidedBy: 'bob', decisionNote: '同意' }),
    });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.approval.status, 'approved');
    assert.equal(decision.body.approval.decisionBy, 'bob');
    assert.equal(decision.body.plan.version, 2);
    assert.equal(decision.body.plan.status, 'active');

    const plans = await request('/plans');
    assert.equal(plans.body.plans.length, 2);
    assert.equal(plans.body.activePlan.version, 2);
    assert.equal(plans.body.plans.find((plan) => plan.version === 1).status, 'superseded');

    const scenarioAfter = await request('/scenarios/3');
    assert.equal(scenarioAfter.body.scenario.status, 'confirmed');
    // 已确认方案不可修改
    const lockedPatch = await request('/scenarios/3', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) });
    assert.equal(lockedPatch.status, 409);
    // 已确认方案不可重跑或删除
    assert.equal((await request('/scenarios/3/simulate', { method: 'POST' })).status, 409);
    assert.equal((await request('/scenarios/3', { method: 'DELETE' })).status, 409);
  });
});

test('驳回审批不会生成计划，方案回到已模拟', async () => {
  await withApp(async ({ request }) => {
    const plansBefore = (await request('/plans')).body.plans.length;
    const approval = (await request('/scenarios/4/request-approval', {
      method: 'POST',
      body: JSON.stringify({ requestedBy: 'carol' }),
    })).body.approval;
    const decision = await request(`/approvals/${approval.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject', decidedBy: 'dave', decisionNote: '数据不足' }),
    });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.approval.status, 'rejected');
    assert.equal(decision.body.plan, null);
    assert.equal((await request('/plans')).body.plans.length, plansBefore);
    assert.equal((await request('/scenarios/4')).body.scenario.status, 'simulated');
  });
});

test('方案可复现校验：快照重算哈希一致', async () => {
  await withApp(async ({ request }) => {
    for (const id of [1, 2, 3, 4, 5]) {
      const verification = await request(`/scenarios/${id}/verify`, { method: 'POST' });
      assert.equal(verification.status, 200);
      assert.equal(verification.body.verification.ok, true, `方案 ${id} 复现失败`);
      assert.equal(verification.body.verification.inputMatches, true);
      assert.equal(verification.body.verification.resultMatches, true);
    }
  });
});

test('参数校验错误返回 400 与可读信息', async () => {
  await withApp(async ({ request }) => {
    const scenario = (await request('/scenarios/2')).body.scenario;
    const bad = await request('/scenarios/2', {
      method: 'PATCH',
      body: JSON.stringify({ params: { ...scenario.params, leadTimeDays: 0 } }),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /供应周期/);

    const badOrder = await request('/scenarios/2', {
      method: 'PATCH',
      body: JSON.stringify({ params: { ...scenario.params, inboundOverrides: [{ sku: 'SKU-1001', poId: 'NOPE', action: 'cancel' }] } }),
    });
    assert.equal(badOrder.status, 400);
    assert.match(badOrder.body.error, /不存在的订单/);
  });
});

test('数据版本可导入并按哈希去重', async () => {
  await withApp(async ({ request }) => {
    const dataset = buildDataset();
    const first = await request('/datasets', { method: 'POST', body: JSON.stringify({ name: '导入 v1', dataset }) });
    assert.equal(first.status, 200);
    assert.equal(first.body.existing, true, '同一数据应命中已存在版本');

    const mutated = structuredClone(dataset);
    mutated.items[0].forecast[0] += 5;
    const second = await request('/datasets', { method: 'POST', body: JSON.stringify({ name: '导入 v2', dataset: mutated }) });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.hash, first.body.hash);

    const created = await request('/scenarios', {
      method: 'POST',
      body: JSON.stringify({ name: '新数据版方案', datasetVersionId: second.body.id, params: DEMO_PARAMS }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.scenario.datasetVersionId, second.body.id);
    assert.equal(created.body.scenario.datasetHash, second.body.hash);
  });
});

test('比较接口相对正式计划与相对方案均可用', async () => {
  await withApp(async ({ request }) => {
    const vsPlan = await request('/scenarios/3/compare');
    assert.equal(vsPlan.status, 200);
    assert.equal(vsPlan.body.base.type, 'plan');
    assert.equal(vsPlan.body.base.version, 1);
    assert.ok(vsPlan.body.metrics.length >= 8);
    assert.ok(Array.isArray(vsPlan.body.lines.added));
    assert.ok(vsPlan.body.items.length === 5);

    const vsScenario = await request('/scenarios/3/compare?against=2');
    assert.equal(vsScenario.status, 200);
    assert.equal(vsScenario.body.base.type, 'scenario');
    assert.equal(vsScenario.body.base.name, '促销增量 · 需求 +30%');
  });
});

test('审计日志记录模拟、审批与计划生成', async () => {
  await withApp(async ({ request }) => {
    const approval = (await request('/scenarios/5/request-approval', {
      method: 'POST',
      body: JSON.stringify({ requestedBy: 'erin' }),
    })).body.approval;
    await request(`/approvals/${approval.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', decidedBy: 'frank' }),
    });
    const audit = await request('/audit?limit=50');
    const actions = audit.body.entries.map((entry) => entry.action);
    assert.ok(actions.includes('scenario.simulate'));
    assert.ok(actions.includes('approval.request'));
    assert.ok(actions.includes('approval.approve'));
    assert.ok(actions.includes('plan.create'));
    const approveEntry = audit.body.entries.find((entry) => entry.action === 'approval.approve');
    assert.equal(approveEntry.actor, 'frank');
  });
});

test('正式计划载荷包含补货行与曲线，且哈希与方案一致', async () => {
  await withApp(async ({ request }) => {
    const plans = await request('/plans');
    const detail = await request(`/plans/${plans.body.activePlan.id}`);
    const payload = detail.body.plan.payload;
    assert.ok(payload.lines.length > 0);
    assert.ok(payload.result.items[0].series.length === 56);
    assert.equal(payload.source.inputHash, detail.body.plan.inputHash);
    assert.equal(payload.source.resultHash, detail.body.plan.resultHash);
  });
});

test('审批基线变化后拒绝批准，避免差异失真', async () => {
  await withApp(async ({ request }) => {
    // 申请 A 基于当前计划 v1
    const first = (await request('/scenarios/2/request-approval', {
      method: 'POST',
      body: JSON.stringify({ requestedBy: 'gina' }),
    })).body.approval;
    // 另一个方案先获批，正式计划变成 v2
    const second = (await request('/scenarios/3/request-approval', {
      method: 'POST',
      body: JSON.stringify({ requestedBy: 'hank' }),
    })).body.approval;
    const approved = await request(`/approvals/${second.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', decidedBy: 'ivy' }),
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.plan.version, 2);

    const stale = await request(`/approvals/${first.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', decidedBy: 'ivy' }),
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /审批基线已变化/);

    const plans = await request('/plans');
    assert.equal(plans.body.plans.length, 2, '过期审批不应生成新计划');
  });
});

test('参数未变化时保存不会清空已有模拟结果', async () => {
  await withApp(async ({ request }) => {
    const scenario = (await request('/scenarios/2')).body.scenario;
    const patched = await request('/scenarios/2', {
      method: 'PATCH',
      body: JSON.stringify({ name: '改名但参数不变', params: scenario.params }),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.scenario.status, 'simulated');
    assert.equal(patched.body.scenario.resultHash, scenario.resultHash);
    assert.equal(patched.body.scenario.name, '改名但参数不变');
  });
});
