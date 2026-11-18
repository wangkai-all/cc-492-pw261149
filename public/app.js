/* Inventory replenishment scenario studio — front-end (no build step). */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const fmt = (value, digits = 0) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const pct = (value, digits = 1) => `${fmt(value, digits)}%`;
const shortHash = (hash) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : '—');
const fmtDate = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}-${day}`;
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const STATUS = {
  draft: { label: '草稿', cls: 'warn' },
  simulated: { label: '已模拟', cls: 'info' },
  pending_approval: { label: '审批中', cls: 'warn' },
  confirmed: { label: '已确认', cls: 'good' },
  active: { label: '生效中', cls: 'good' },
  superseded: { label: '已被替代', cls: '' },
  pending: { label: '待审批', cls: 'warn' },
  approved: { label: '已批准', cls: 'good' },
  rejected: { label: '已驳回', cls: 'bad' },
};

const state = {
  meta: null,
  datasets: [],
  scenarios: [],
  plans: [],
  approvals: [],
  activePlan: null,
  audit: [],
  selectedId: null,
  tab: 'workspace',
  sku: null,
  datasetCache: new Map(),
  compareA: null,
  compareB: null,
  planDetail: null,
  approvalOpen: null,
  approvalDiffExpanded: null,
  diffExpanded: false,
  busy: false,
};

const actor = () => $('#actor-input').value.trim() || 'planner';

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-actor': actor(),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function toast(message, kind = '') {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toast-stack').append(element);
  setTimeout(() => element.remove(), 4200);
}

/* ---------------- Data loading ---------------- */

async function refreshAll({ keepSelection = true } = {}) {
  const [datasets, scenarios, plans, approvals, audit] = await Promise.all([
    api('/datasets'),
    api('/scenarios'),
    api('/plans'),
    api('/approvals'),
    api('/audit?limit=40'),
  ]);
  state.datasets = datasets.datasets;
  state.scenarios = scenarios.scenarios;
  state.plans = plans.plans;
  state.activePlan = plans.activePlan;
  state.approvals = approvals.approvals;
  state.audit = audit.entries;
  if (!keepSelection || !state.scenarios.some((scenario) => scenario.id === state.selectedId)) {
    state.selectedId = state.scenarios[0]?.id ?? null;
  }
  if (state.compareA && !state.scenarios.some((scenario) => scenario.id === state.compareA)) {
    state.compareA = null;
  }
  if (state.compareB && !state.scenarios.some((scenario) => scenario.id === state.compareB)) {
    state.compareB = null;
  }
  if (!state.compareB) {
    state.compareB = state.scenarios.find((scenario) => scenario.id !== state.selectedId && scenario.status !== 'draft')?.id
      ?? state.scenarios.find((scenario) => scenario.id !== state.selectedId)?.id
      ?? null;
  }
  renderSidebar();
  renderTopbar();
}

async function loadDatasetDetail(id) {
  if (!id) return null;
  if (state.datasetCache.has(id)) return state.datasetCache.get(id);
  const body = await api(`/datasets/${id}`);
  state.datasetCache.set(id, body.dataset);
  return body.dataset;
}

async function loadScenarioDetail(id) {
  if (!id) return null;
  const body = await api(`/scenarios/${id}`);
  return body.scenario;
}

/* ---------------- Shell rendering ---------------- */

function renderTopbar() {
  const chip = $('#active-plan-chip');
  if (state.activePlan) {
    chip.innerHTML = `<span class="dot" style="background:var(--good)"></span> 正式计划 v${state.activePlan.version} · ${esc(state.activePlan.scenarioName)}`;
    chip.title = `计划 v${state.activePlan.version}，内容哈希 ${state.activePlan.resultHash}`;
  } else {
    chip.textContent = '暂无正式计划';
  }
  const pending = state.approvals.filter((approval) => approval.status === 'pending').length;
  const badge = $('#approval-badge');
  badge.hidden = pending === 0;
  badge.textContent = pending;
}

function renderSidebar() {
  const list = $('#scenario-list');
  if (!state.scenarios.length) {
    list.innerHTML = '<li class="empty-state"><strong>还没有情景</strong>新建一个以开始</li>';
    return;
  }
  list.innerHTML = state.scenarios.map((scenario) => {
    const status = STATUS[scenario.status] || STATUS.draft;
    const fill = scenario.totals ? `${pct(scenario.totals.fillRate)} 满足率` : '未模拟';
    return `
      <li class="scenario-item ${scenario.id === state.selectedId ? 'is-active' : ''}" data-id="${scenario.id}" tabindex="0" role="button">
        <span class="name"><span>${esc(scenario.name)}</span></span>
        <span class="sub">
          <span class="pill ${status.cls}">${status.label}</span>
          <span>${fill}</span>
        </span>
      </li>`;
  }).join('');

  $$('.scenario-item', list).forEach((item) => {
    const select = () => {
      state.selectedId = Number(item.dataset.id);
      state.sku = null;
      renderSidebar();
      // 从审批/计划页点击情景时直接回到工作台，避免看不到刚选中的方案
      if (state.tab !== 'workspace') {
        switchTab('workspace');
      } else {
        renderWorkspace();
      }
    };
    item.addEventListener('click', select);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
  });

  const select = $('#dataset-select');
  const previous = select.value;
  select.innerHTML = state.datasets.map((dataset) => (
    `<option value="${dataset.id}">${esc(dataset.name)}</option>`
  )).join('');
  if (previous && state.datasets.some((dataset) => String(dataset.id) === previous)) select.value = previous;
}

function renderTabs() {
  $$('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === state.tab);
  });
  $$('.tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === `panel-${state.tab}`);
  });
}

function switchTab(tab) {
  state.tab = tab;
  renderTabs();
  if (tab === 'workspace') renderWorkspace();
  if (tab === 'compare') renderCompare();
  if (tab === 'approval') renderApprovals();
  if (tab === 'plans') renderPlans();
}

/* ---------------- Chart ---------------- */

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / (10 ** exponent);
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * (10 ** exponent);
}

/**
 * Generic line/bar chart.
 * model = { dates, bars?: {values, color, label}, lines: [{values, color, dash, label, width}],
 *           bands?: [{from,to,color}], markers?: [{index,color,label}], height, valueDigits }
 */
const chartRegistry = [];

function renderChart(host, model) {
  // 使用容器实际宽度，避免在窄栏里整体缩放导致字号变小。
  const measured = Math.round(host.clientWidth || 0);
  const width = measured > 320 ? measured : 980;
  const height = model.height ?? 300;
  const padL = 56;
  const padR = 18;
  const padT = 20;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const count = model.dates.length;
  const existing = chartRegistry.find((entry) => entry.host === host);
  if (existing) existing.model = model;
  else chartRegistry.push({ host, model });

  if (!count) {
    host.innerHTML = '<div class="chart-empty">暂无可绘制的数据</div>';
    return;
  }

  const allValues = model.lines.flatMap((line) => line.values).filter(Number.isFinite);
  if (model.bars) allValues.push(...model.bars.values);
  const yMax = niceMax(Math.max(1, ...allValues) * 1.08);
  const x = (index) => padL + (count === 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const y = (value) => padT + plotH - (value / yMax) * plotH;
  const barSlot = plotW / Math.max(1, count);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ratio * yMax);

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(model.ariaLabel || '库存曲线')}" style="height:auto">`;

  // bands
  for (const band of model.bands || []) {
    const startX = Math.max(padL, x(band.from) - barSlot / 2);
    const endX = Math.min(padL + plotW, x(band.to) + barSlot / 2);
    svg += `<rect x="${startX.toFixed(1)}" y="${padT}" width="${Math.max(1, endX - startX).toFixed(1)}" height="${plotH}" fill="${band.color}" rx="2"></rect>`;
  }

  // gridlines + y labels
  for (const tick of ticks) {
    const yy = y(tick);
    svg += `<line x1="${padL}" x2="${width - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--border)" stroke-width="1" opacity="${tick === 0 ? 0.9 : 0.55}"></line>`;
    svg += `<text x="${padL - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="var(--text-muted)">${fmt(tick, 0)}</text>`;
  }

  // demand bars
  if (model.bars) {
    const barW = Math.max(1.5, barSlot * 0.55);
    model.bars.values.forEach((value, index) => {
      if (!(value > 0)) return;
      const barH = Math.max(0.8, (value / yMax) * plotH);
      svg += `<rect x="${(x(index) - barW / 2).toFixed(1)}" y="${(y(0) - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="${Math.min(2, barW / 2).toFixed(1)}" fill="${model.bars.color}" opacity="0.55"></rect>`;
    });
  }

  // lines
  for (const line of model.lines) {
    const points = line.values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    svg += `<polyline points="${points}" fill="none" stroke="${line.color}" stroke-width="${line.width ?? 2}" stroke-linejoin="round" stroke-linecap="round" ${line.dash ? `stroke-dasharray="${line.dash}"` : ''} opacity="${line.opacity ?? 1}"></polyline>`;
  }

  // markers (receipts)
  for (const marker of model.markers || []) {
    const cx = x(marker.index);
    const cy = padT + 4;
    svg += `<path d="M ${cx} ${cy - 4} L ${cx + 4} ${cy} L ${cx} ${cy + 4} L ${cx - 4} ${cy} Z" fill="${marker.color}" stroke="var(--surface-1)" stroke-width="1.5"></path>`;
  }

  // x labels — keep them readable by spacing ticks according to available width
  const maxTicks = Math.max(3, Math.floor(plotW / 58));
  const step = Math.max(1, Math.ceil(count / maxTicks));
  for (let index = 0; index < count; index += step) {
    svg += `<text x="${x(index).toFixed(1)}" y="${height - 12}" text-anchor="middle" font-size="10.5" fill="var(--text-muted)">${esc(fmtDate(model.dates[index]))}</text>`;
  }

  // crosshair layer
  svg += `<line class="crosshair" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="2 3" opacity="0"></line>`;
  svg += `<g class="hover-dots"></g>`;
  svg += `<rect class="hover-surface" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"></rect>`;
  svg += '</svg>';

  host.innerHTML = `${svg}<div class="chart-tip" role="status"></div>`;

  const svgEl = $('svg', host);
  const tip = $('.chart-tip', host);
  const crosshair = $('.crosshair', host);
  const dots = $('.hover-dots', host);
  const surface = $('.hover-surface', host);

  const valueDigits = model.valueDigits ?? 0;
  const showTip = (event) => {
    const rect = svgEl.getBoundingClientRect();
    const scale = rect.width / width;
    const localX = (event.clientX - rect.left) / scale;
    const ratio = (localX - padL) / plotW;
    const index = Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
    const px = x(index);

    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.setAttribute('opacity', '0.55');
    dots.innerHTML = model.lines.map((line) => (
      `<circle cx="${px}" cy="${y(line.values[index])}" r="3.6" fill="${line.color}" stroke="var(--surface-1)" stroke-width="1.5"></circle>`
    )).join('');

    const rows = [];
    if (model.bars) rows.push([model.bars.label, fmt(model.bars.values[index], valueDigits)]);
    for (const line of model.lines) rows.push([line.label, fmt(line.values[index], line.digits ?? valueDigits)]);
    tip.innerHTML = `<div class="tip-title">${esc(model.dates[index])}</div>${rows.map(([label, value]) => (
      `<div class="tip-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`
    )).join('')}`;
    const tipX = (px * scale);
    tip.style.left = `${Math.max(70, Math.min(rect.width - 70, tipX))}px`;
    tip.style.top = `${Math.max(52, y(Math.max(...model.lines.map((line) => line.values[index]))) * scale + 12)}px`;
    tip.classList.add('is-visible');
  };

  surface.addEventListener('pointermove', showTip);
  surface.addEventListener('pointerleave', () => {
    tip.classList.remove('is-visible');
    crosshair.setAttribute('opacity', '0');
    dots.innerHTML = '';
  });
}

// Re-render registered charts on viewport changes so width-derived layout stays correct.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (let index = chartRegistry.length - 1; index >= 0; index -= 1) {
      const entry = chartRegistry[index];
      if (!entry.host.isConnected) {
        chartRegistry.splice(index, 1);
        continue;
      }
      renderChart(entry.host, entry.model);
    }
  }, 160);
});

function inventoryModel(result, item, options = {}) {
  const series = item.series;
  const lines = [
    {
      values: series.map((row) => row.onHand),
      color: `var(${options.color ?? '--series-1'})`,
      label: `${item.name} 在库`,
    },
    {
      values: series.map((row) => row.safetyStock),
      color: 'var(--text-muted)',
      dash: '5 4',
      width: 1.5,
      label: '安全库存',
    },
  ];
  if (options.showReorder) {
    lines.push({
      values: series.map((row) => row.reorderPoint ?? 0),
      color: 'var(--text-muted)',
      dash: '2 4',
      width: 1,
      opacity: 0.7,
      label: '补货点',
    });
  }
  return {
    dates: series.map((row) => row.date),
    bars: {
      values: series.map((row) => row.demand),
      color: 'var(--series-1)',
      label: '当日需求',
    },
    lines,
    bands: series
      .filter((row) => row.lost > 0)
      .map((row) => ({ from: row.day, to: row.day, color: 'color-mix(in srgb, var(--critical) 13%, transparent)' })),
    markers: (item.receipts || []).map((receipt) => ({
      index: receipt.day,
      color: receipt.lateDays > 0 ? 'var(--critical)' : 'var(--series-3)',
      label: receipt.lateDays > 0 ? '迟到到货' : '到货',
    })),
    ariaLabel: `${item.name} 库存曲线`,
    height: 300,
  };
}

/* ---------------- Workspace ---------------- */

async function renderWorkspace() {
  const panel = $('#panel-workspace');
  const scenario = state.scenarios.find((entry) => entry.id === state.selectedId);
  if (!scenario) {
    panel.innerHTML = `<div class="empty-state"><strong>还没有情景</strong><span>点击左上角“新建”创建第一个补货情景。</span></div>`;
    return;
  }
  const detail = await loadScenarioDetail(scenario.id);
  const dataset = await loadDatasetDetail(detail.datasetVersionId);
  if (state.sku === null || !detail.result?.items.some((item) => item.sku === state.sku)) {
    state.sku = detail.result?.items[0]?.sku ?? dataset?.dataset.items[0]?.sku ?? null;
  }
  const status = STATUS[detail.status] || STATUS.draft;
  const editable = detail.status === 'draft' || detail.status === 'simulated';
  const totals = detail.result?.totals;
  const pendingApproval = state.approvals.find((approval) => approval.scenarioId === detail.id && approval.status === 'pending');

  panel.innerHTML = `
    <div class="ws-header">
      <div>
        <h2>${esc(detail.name)}</h2>
        <p>${esc(detail.description || '未填写说明')}</p>
      </div>
      <div class="ws-meta">
        <span class="pill ${status.cls}">${status.label}</span>
        <span class="pill">数据版本：${esc(detail.datasetName)}</span>
        <span class="pill info" title="输入哈希">输入 ${shortHash(detail.inputHash)}</span>
        ${editable ? '<button class="btn btn-sm" id="btn-duplicate">复制为新情景</button>' : ''}
      </div>
    </div>

    <div class="ws-grid">
      <form class="card" id="param-form">
        <div class="card-head">
          <h3>参数</h3>
          <span class="hint">${editable ? '草稿可调整' : '已锁定'}</span>
        </div>
        <div class="form-section">
          <h4>计划参数</h4>
          <div class="field-row">
            <div class="field">
              <label for="f-horizon">模拟天数</label>
              <input id="f-horizon" name="horizonDays" type="number" min="7" max="365" step="1" value="${detail.params.horizonDays}" ${editable ? '' : 'disabled'}>
            </div>
            <div class="field">
              <label for="f-lead">供应周期（天）</label>
              <input id="f-lead" name="leadTimeDays" type="number" min="1" max="90" step="1" value="${detail.params.leadTimeDays}" ${editable ? '' : 'disabled'}>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="f-moq">最小批量</label>
              <input id="f-moq" name="minOrderQty" type="number" min="1" step="1" value="${detail.params.minOrderQty}" ${editable ? '' : 'disabled'}>
            </div>
            <div class="field">
              <label for="f-mult">批量倍数</label>
              <input id="f-mult" name="orderMultiple" type="number" min="1" step="1" value="${detail.params.orderMultiple}" ${editable ? '' : 'disabled'}>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="f-review">复核周期（天）</label>
              <input id="f-review" name="reviewPeriodDays" type="number" min="1" max="60" step="1" value="${detail.params.reviewPeriodDays}" ${editable ? '' : 'disabled'}>
            </div>
            <div class="field">
              <label for="f-demand">需求系数</label>
              <input id="f-demand" name="demandMultiplier" type="number" min="0.2" max="3" step="0.05" value="${detail.params.demandMultiplier}" ${editable ? '' : 'disabled'}>
            </div>
          </div>
        </div>

        <div class="form-section">
          <h4>安全库存<span class="hint">按 SKU 设定</span></h4>
          ${(dataset?.dataset.items || []).map((item) => `
            <div class="sku-safety">
              <span>${esc(item.name)} <span class="muted mono">${esc(item.sku)}</span></span>
              <input name="safety-${esc(item.sku)}" type="number" min="0" step="1" value="${detail.params.safetyStockBySku[item.sku] ?? 0}" ${editable ? '' : 'disabled'} aria-label="${esc(item.name)} 安全库存">
            </div>`).join('')}
        </div>

        <div class="form-section">
          <h4>退货与替代</h4>
          <label class="check"><input type="checkbox" name="returns-enabled" ${detail.params.returns.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'}>计入退货回流</label>
          <div class="field-row" style="margin-top:8px">
            <div class="field">
              <label for="f-return-rate">退货率（%）</label>
              <input id="f-return-rate" name="returns-rate" type="number" min="0" max="100" step="0.5" value="${detail.params.returns.ratePercent}" ${editable ? '' : 'disabled'}>
            </div>
            <div class="field">
              <label for="f-return-lag">回流滞后（天）</label>
              <input id="f-return-lag" name="returns-lag" type="number" min="0" max="60" step="1" value="${detail.params.returns.lagDays}" ${editable ? '' : 'disabled'}>
            </div>
          </div>
          <label class="check" style="margin-top:8px"><input type="checkbox" name="sub-enabled" ${detail.params.substitution.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'}>允许替代品补足缺口</label>
        </div>

        <div class="form-section">
          <h4>供应中断</h4>
          <label class="check"><input type="checkbox" name="dis-enabled" ${detail.params.disruption.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'}>启用供应中断</label>
          <div class="field-row" style="margin-top:8px">
            <div class="field">
              <label for="f-dis-from">开始日</label>
              <input id="f-dis-from" name="dis-from" type="number" min="0" step="1" value="${detail.params.disruption.fromDay}" ${editable ? '' : 'disabled'}>
            </div>
            <div class="field">
              <label for="f-dis-to">结束日</label>
              <input id="f-dis-to" name="dis-to" type="number" min="0" step="1" value="${detail.params.disruption.toDay}" ${editable ? '' : 'disabled'}>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="f-dis-mode">中断方式</label>
              <select id="f-dis-mode" name="dis-mode" ${editable ? '' : 'disabled'}>
                <option value="delay" ${detail.params.disruption.mode === 'delay' ? 'selected' : ''}>延迟到货</option>
                <option value="halt" ${detail.params.disruption.mode === 'halt' ? 'selected' : ''}>暂停至结束日</option>
              </select>
            </div>
            <div class="field">
              <label for="f-dis-delay">延迟天数</label>
              <input id="f-dis-delay" name="dis-delay" type="number" min="0" max="90" step="1" value="${detail.params.disruption.delayDays}" ${editable ? '' : 'disabled'}>
            </div>
          </div>
        </div>

        <div class="form-section">
          <h4>在途订单<span class="hint">${(detail.params.inboundOverrides || []).length} 项调整</span></h4>
          ${(dataset?.dataset.items || []).flatMap((item) => (item.openOrders || []).map((order) => {
            const override = (detail.params.inboundOverrides || []).find((entry) => entry.sku === item.sku && entry.poId === order.id);
            return `
              <div class="override-row" data-sku="${esc(item.sku)}" data-po="${esc(order.id)}">
                <div>
                  <div>${esc(item.sku)} · <span class="mono">${esc(order.id)}</span></div>
                  <div class="muted" style="font-size:11px">${fmt(order.qty)} 件 · 第 ${order.expectedDay} 天到货</div>
                </div>
                <div style="display:flex;gap:5px;align-items:center">
                  <select class="ov-action" ${editable ? '' : 'disabled'} aria-label="${esc(order.id)} 调整">
                    <option value="none">不调整</option>
                    <option value="delay" ${override?.action === 'delay' ? 'selected' : ''}>延迟</option>
                    <option value="cancel" ${override?.action === 'cancel' ? 'selected' : ''}>取消</option>
                  </select>
                  <input class="ov-days" type="number" min="1" max="180" step="1" value="${override?.days ?? 3}" style="width:52px" ${editable && override?.action === 'delay' ? '' : 'disabled'} aria-label="延迟天数">
                </div>
              </div>`;
          })).join('') || '<div class="muted" style="font-size:12px">无在途订单</div>'}
        </div>

        <div class="form-section" style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="submit" class="btn btn-primary" ${editable ? '' : 'disabled'}>保存参数并模拟</button>
          <button type="button" class="btn" id="btn-simulate" ${editable ? '' : 'disabled'}>按已存参数重跑</button>
        </div>
      </form>

      <div class="section-stack">
        ${detail.result && totals ? renderResult(detail, totals, pendingApproval) : `
          <div class="card"><div class="empty-state">
            <strong>尚未模拟</strong>
            <span>调整左侧参数，点击“保存参数并模拟”生成库存曲线与缺口。</span>
          </div></div>`}
      </div>
    </div>`;

  bindForm(detail, dataset, editable);
  if (detail.result) bindResult(detail, pendingApproval);
}

function renderResult(detail, totals, pendingApproval) {
  const items = detail.result.items;
  const active = items.find((item) => item.sku === state.sku) || items[0];
  const status = STATUS[detail.status] || STATUS.draft;
  const canRequest = detail.status === 'simulated' && !pendingApproval;
  const deficit = totals.lost > 0;

  return `
    <div class="stat-strip">
      <div class="stat ${totals.fillRate >= 98 ? 'accent-good' : totals.fillRate >= 92 ? 'accent-warn' : 'accent-bad'}">
        <span class="label">综合满足率</span>
        <span class="value">${pct(totals.fillRate)}</span>
        <span class="sub">需求 ${fmt(totals.demand)} 件 · 缺口 ${fmt(totals.lost)} 件</span>
      </div>
      <div class="stat ${deficit ? 'accent-bad' : 'accent-good'}">
        <span class="label">缺口件数</span>
        <span class="value">${fmt(totals.lost)}<small>件</small></span>
        <span class="sub">${totals.stockoutItems} 个 SKU 出现缺货</span>
      </div>
      <div class="stat ${totals.stockoutDays > 0 ? 'accent-warn' : 'accent-good'}">
        <span class="label">缺货商品·天</span>
        <span class="value">${fmt(totals.stockoutDays)}</span>
        <span class="sub">最差 SKU ${pct(totals.worstFillRate)}</span>
      </div>
      <div class="stat">
        <span class="label">低于安全库存</span>
        <span class="value">${fmt(totals.safetyBreachDays)}<small>商品·天</small></span>
        <span class="sub">安全库存合计 ${fmt(totals.safetyStockTotal)} 件</span>
      </div>
      <div class="stat">
        <span class="label">补货下单量</span>
        <span class="value">${fmt(totals.totalOrdered)}<small>件</small></span>
        <span class="sub">${totals.orderCount} 张补货单</span>
      </div>
      <div class="stat">
        <span class="label">平均在库</span>
        <span class="value">${fmt(totals.avgOnHand, 1)}<small>件</small></span>
        <span class="sub">期末 ${fmt(totals.endingOnHand, 1)} · 在途 ${fmt(totals.endingOnOrder)}</span>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>库存曲线</h3>
        <div class="btn-row">
          <button class="btn btn-sm" id="btn-verify" title="用快照数据重算并比对哈希">校验可复现</button>
          <button class="btn btn-sm" id="btn-compare">与正式计划比较</button>
          ${canRequest ? '<button class="btn btn-sm btn-primary" id="btn-request-approval">提交审批</button>' : ''}
          ${pendingApproval ? '<span class="pill warn">已有待审批申请</span>' : ''}
          ${detail.status === 'confirmed' ? `<span class="pill good">已生成正式计划</span>` : ''}
        </div>
      </div>
      <div class="item-tabs" role="tablist">
        ${items.map((item) => `
          <button class="item-tab ${item.sku === active.sku ? 'is-active' : ''}" data-sku="${esc(item.sku)}" role="tab">
            ${esc(item.name)} <span class="sku">${esc(item.sku)}</span>
            ${item.metrics.stockoutDays > 0 ? `<span class="dot" style="background:var(--critical)"></span>` : ''}
          </button>`).join('')}
      </div>
      <div class="chart-wrap">
        <div class="chart-toolbar">
          <div class="legend">
            <span class="legend-item"><span class="legend-swatch" style="background:color-mix(in srgb, var(--series-1) 55%, transparent)"></span>当日需求</span>
            <span class="legend-item"><span class="legend-swatch line" style="background:var(--series-1)"></span>在库</span>
            <span class="legend-item"><span class="legend-swatch dash" style="color:var(--text-muted)"></span>安全库存</span>
            <span class="legend-item"><span class="legend-swatch" style="background:color-mix(in srgb, var(--critical) 30%, transparent)"></span>缺货日</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--series-3);transform:rotate(45deg);width:8px;height:8px;border-radius:1px"></span>到货</span>
            <span class="legend-item"><span class="legend-swatch" style="background:var(--critical);transform:rotate(45deg);width:8px;height:8px;border-radius:1px"></span>迟到到货</span>
          </div>
          <button class="btn btn-sm btn-ghost" id="toggle-table" aria-expanded="false">数据表</button>
        </div>
        <div class="chart-host" id="inventory-chart"></div>
        <div class="table-wrap" id="inventory-table" hidden style="max-height:280px;overflow:auto;border-top:1px solid var(--border);margin-top:8px">
          <table class="data">
            <thead><tr><th>日期</th><th>需求</th><th>满足</th><th>其中替代</th><th>缺口</th><th>在库</th><th>在途</th><th>到货</th></tr></thead>
            <tbody>${active.series.map((row) => `
              <tr class="${row.lost > 0 ? 'is-short' : ''}">
                <td>${esc(row.date)}</td><td>${fmt(row.demand)}</td><td>${fmt(row.served)}</td>
                <td>${row.servedBySubstitute ? fmt(row.servedBySubstitute) : '—'}</td>
                <td>${row.lost ? fmt(row.lost) : '—'}</td>
                <td>${fmt(row.onHand)}</td><td>${fmt(row.onOrder)}</td>
                <td>${row.receiptQty ? fmt(row.receiptQty) : '—'}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <div class="kv-grid" style="border-top:1px solid var(--border)">
        <div class="kv"><span class="k">SKU</span><span class="v mono">${esc(active.sku)}</span></div>
        <div class="kv"><span class="k">满足率</span><span class="v">${pct(active.metrics.fillRate)}</span></div>
        <div class="kv"><span class="k">缺口</span><span class="v">${fmt(active.metrics.lost)} 件</span></div>
        <div class="kv"><span class="k">安全库存</span><span class="v">${fmt(active.metrics.safetyStock)} 件</span></div>
        <div class="kv"><span class="k">补货下单</span><span class="v">${fmt(active.metrics.totalOrdered)} 件 / ${active.metrics.orderCount} 单</span></div>
        <div class="kv"><span class="k">替代品补足</span><span class="v">${fmt(active.metrics.substituteCovered)} 件${active.substitute ? `（耗用 ${fmt(active.metrics.substituteUnits)}）` : ''}</span></div>
        <div class="kv"><span class="k">退货回流</span><span class="v">${fmt(active.metrics.returnsDelivered)} 件</span></div>
        <div class="kv"><span class="k">迟到订单</span><span class="v">${fmt(active.metrics.lateOrders)} 单${active.metrics.pendingLateOrders ? `（${active.metrics.pendingLateOrders} 单未到）` : ''}</span></div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-head">
          <h3>缺口区间</h3>
          <span class="hint">${active.gaps.shortage.length} 段缺货 · ${active.gaps.safety.length} 段低于安全库存</span>
        </div>
        ${active.gaps.shortage.length ? `<div class="gap-list">${active.gaps.shortage.map((gap) => `
          <div class="gap-item">
            <span class="gap-bar" style="background:${gap.type === 'stockout' ? 'var(--critical)' : 'var(--series-3)'}"></span>
            <div>
              <div class="gap-title">${esc(gap.startDate)} → ${esc(gap.endDate)} · ${gap.days} 天</div>
              <div class="gap-sub">${gap.type === 'stockout' ? '未满足需求' : '由替代品补足'}${gap.substituteCovered ? ` · 替代 ${fmt(gap.substituteCovered)} 件` : ''}</div>
            </div>
            <div class="gap-num"><div>${fmt(gap.lost)} 件</div><div class="muted" style="font-size:11px">最低 ${fmt(gap.minOnHand)}</div></div>
          </div>`).join('')}</div>` : '<div class="chart-empty">没有缺货区间</div>'}
      </div>

      <div class="card">
        <div class="card-head">
          <h3>在途与到货</h3>
          <span class="hint">迟到 / 取消订单</span>
        </div>
        ${renderReceipts(active)}
      </div>
    </div>`;
}

function renderReceipts(item) {
  const late = item.receipts.filter((receipt) => receipt.lateDays > 0);
  const cancelled = item.cancelledOrders || [];
  const pending = item.pendingLateOrders || [];
  const rows = [];
  for (const receipt of late) {
    rows.push(`<tr>
      <td><span class="pill bad">迟到 ${receipt.lateDays} 天</span></td>
      <td class="mono">${esc(receipt.poId || '计划单')}</td>
      <td>${fmt(receipt.qty)}</td>
      <td>${fmtDate(item.series[receipt.promisedDay]?.date)}</td>
      <td>${esc(receipt.date)}</td>
    </tr>`);
  }
  for (const order of cancelled) {
    rows.push(`<tr>
      <td><span class="pill warn">已取消</span></td>
      <td class="mono">${esc(order.poId)}</td>
      <td>${fmt(order.qty)}</td>
      <td>${item.series[order.expectedDay]?.date ?? '—'}</td>
      <td>—</td>
    </tr>`);
  }
  for (const order of pending) {
    rows.push(`<tr>
      <td><span class="pill bad">未在期内到达</span></td>
      <td class="mono">${esc(order.poId || '计划单')}</td>
      <td>${fmt(order.qty)}</td>
      <td>—</td>
      <td>第 ${order.arrivalDay} 天</td>
    </tr>`);
  }
  // plain on-time receipts count
  const onTime = item.receipts.filter((receipt) => receipt.lateDays === 0);
  if (!rows.length) {
    return `<div class="kv-grid">
      <div class="kv"><span class="k">按时到货</span><span class="v">${onTime.length} 批 / ${fmt(onTime.reduce((sum, receipt) => sum + receipt.qty, 0))} 件</span></div>
      <div class="kv"><span class="k">迟到</span><span class="v">0 单</span></div>
      <div class="kv"><span class="k">取消</span><span class="v">0 单</span></div>
    </div>`;
  }
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>状态</th><th>订单</th><th>数量</th><th>承诺到货</th><th>实际到货</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>
  <div class="kv-grid" style="border-top:1px solid var(--border)">
    <div class="kv"><span class="k">按时到货</span><span class="v">${onTime.length} 批 / ${fmt(onTime.reduce((sum, receipt) => sum + receipt.qty, 0))} 件</span></div>
    <div class="kv"><span class="k">迟到</span><span class="v">${late.length} 单</span></div>
    <div class="kv"><span class="k">取消</span><span class="v">${cancelled.length} 单</span></div>
  </div>`;
}

function bindResult(detail, pendingApproval) {
  $$('.item-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.sku = tab.dataset.sku;
      renderWorkspace();
    });
  });

  const active = detail.result.items.find((item) => item.sku === state.sku) || detail.result.items[0];
  const host = $('#inventory-chart');
  if (host) renderChart(host, inventoryModel(detail.result, active));

  $('#toggle-table')?.addEventListener('click', (event) => {
    const table = $('#inventory-table');
    table.hidden = !table.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!table.hidden));
  });

  $('#btn-verify')?.addEventListener('click', async () => {
    try {
      const { verification } = await api(`/scenarios/${detail.id}/verify`, { method: 'POST' });
      toast(verification.ok
        ? '复现校验通过：快照重算结果与存储哈希一致'
        : '复现校验失败：结果哈希不一致', verification.ok ? 'good' : 'bad');
    } catch (error) {
      toast(error.message, 'bad');
    }
  });

  $('#btn-compare')?.addEventListener('click', () => {
    state.compareB = detail.id;
    if (!state.compareA) state.compareA = state.activePlan?.id ?? null;
    switchTab('compare');
  });

  $('#btn-request-approval')?.addEventListener('click', () => openApprovalModal(detail));
}

function bindForm(detail, dataset, editable) {
  $('#btn-duplicate')?.addEventListener('click', () => openScenarioModal(detail));

  const ovSelects = $$('.ov-action');
  ovSelects.forEach((select) => {
    select.addEventListener('change', () => {
      const row = select.closest('.override-row');
      const days = $('.ov-days', row);
      days.disabled = select.value !== 'delay';
    });
  });

  const form = $('#param-form');
  const collectParams = () => {
    const value = (name) => form.querySelector(`[name="${name}"]`);
    const number = (name) => Number(value(name).value);
    const safetyStockBySku = {};
    for (const item of dataset.dataset.items) {
      safetyStockBySku[item.sku] = number(`safety-${item.sku}`);
    }
    const inboundOverrides = [];
    $$('.override-row').forEach((row) => {
      const action = $('.ov-action', row).value;
      if (action === 'none') return;
      inboundOverrides.push({
        sku: row.dataset.sku,
        poId: row.dataset.po,
        action,
        days: action === 'delay' ? Number($('.ov-days', row).value) : 0,
      });
    });
    return {
      horizonDays: number('horizonDays'),
      leadTimeDays: number('leadTimeDays'),
      minOrderQty: number('minOrderQty'),
      orderMultiple: number('orderMultiple'),
      reviewPeriodDays: number('reviewPeriodDays'),
      demandMultiplier: number('demandMultiplier'),
      safetyStockBySku,
      returns: {
        enabled: value('returns-enabled').checked,
        ratePercent: number('returns-rate'),
        lagDays: number('returns-lag'),
      },
      substitution: { enabled: value('sub-enabled').checked },
      disruption: {
        enabled: value('dis-enabled').checked,
        fromDay: number('dis-from'),
        toDay: number('dis-to'),
        mode: value('dis-mode').value,
        delayDays: number('dis-delay'),
      },
      inboundOverrides,
    };
  };

  const saveAndSimulate = async (params, event) => {
    if (event) event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    try {
      await api(`/scenarios/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ params }),
      });
      await api(`/scenarios/${detail.id}/simulate`, { method: 'POST' });
      await refreshAll();
      await renderWorkspace();
      toast('参数已保存，模拟完成', 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      state.busy = false;
    }
  };

  form.addEventListener('submit', (event) => saveAndSimulate(collectParams(), event));
  $('#btn-simulate')?.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      await api(`/scenarios/${detail.id}/simulate`, { method: 'POST' });
      await refreshAll();
      await renderWorkspace();
      toast('已按已存参数重新模拟', 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      state.busy = false;
    }
  });
}

/* ---------------- Approval modal ---------------- */

function closeModal() {
  $('#modal-root').innerHTML = '';
  state.approvalOpen = null;
}

async function openApprovalModal(detail) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div class="modal-head"><h3 id="approval-title">提交审批 · ${esc(detail.name)}</h3><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body">
          <div class="muted" style="font-size:12.5px">提交前将生成相对当前正式计划的差异。审批通过后才会生成新的正式计划版本。</div>
          <div id="approval-preview"><div class="chart-empty">正在生成差异…</div></div>
          <div class="field">
            <label for="approval-note">提交说明</label>
            <textarea id="approval-note" rows="2" placeholder="例如：促销前补货，覆盖 11 月峰值"></textarea>
          </div>
          <div class="form-error" id="approval-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close>取消</button>
          <button class="btn btn-primary" id="confirm-approval">提交审批</button>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeModal));
  root.querySelector('.modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });

  try {
    const preview = await api(`/scenarios/${detail.id}/compare`);
    $('#approval-preview').innerHTML = renderCompareSummary(preview);
  } catch (error) {
    $('#approval-preview').innerHTML = `<div class="verify-banner bad">无法生成差异：${esc(error.message)}</div>`;
  }

  $('#confirm-approval').addEventListener('click', async () => {
    const button = $('#confirm-approval');
    button.disabled = true;
    try {
      const { approval } = await api(`/scenarios/${detail.id}/request-approval`, {
        method: 'POST',
        body: JSON.stringify({ requestedBy: actor(), note: $('#approval-note').value }),
      });
      closeModal();
      await refreshAll();
      await renderWorkspace();
      switchTab('approval');
      toast(`审批申请 #${approval.id} 已提交`, 'good');
    } catch (error) {
      $('#approval-error').textContent = error.message;
      button.disabled = false;
    }
  });
}

function openScenarioModal(source) {
  const root = $('#modal-root');
  const datasetOptions = state.datasets.map((dataset) => (
    `<option value="${dataset.id}" ${source?.datasetVersionId === dataset.id ? 'selected' : ''}>${esc(dataset.name)}</option>`
  )).join('');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="scenario-title">
        <div class="modal-head"><h3 id="scenario-title">新建情景</h3><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body">
          <div class="field"><label for="scenario-name">名称</label><input id="scenario-name" type="text" maxlength="60" value="${source ? `复制 · ${esc(source.name)}` : ''}" placeholder="例如：双十一备货"></div>
          <div class="field"><label for="scenario-desc">说明</label><textarea id="scenario-desc" rows="2">${source ? '基于已有情景复制参数，可独立修改。' : ''}</textarea></div>
          <div class="field"><label for="scenario-dataset">数据版本</label><select id="scenario-dataset">${datasetOptions}</select></div>
          <div class="form-error" id="scenario-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close>取消</button>
          <button class="btn btn-primary" id="confirm-scenario">创建</button>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeModal));
  root.querySelector('.modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });

  $('#confirm-scenario').addEventListener('click', async () => {
    const name = $('#scenario-name').value.trim();
    if (!name) {
      $('#scenario-error').textContent = '请填写名称';
      return;
    }
    const button = $('#confirm-scenario');
    button.disabled = true;
    try {
      const datasetVersionId = Number($('#scenario-dataset').value);
      const dataset = await loadDatasetDetail(datasetVersionId);
      const baseParams = source
        ? source.params
        : { horizonDays: 56, leadTimeDays: 7, minOrderQty: 50, orderMultiple: 10, reviewPeriodDays: 1, demandMultiplier: 1, returns: { enabled: true, ratePercent: 0, lagDays: 1 }, substitution: { enabled: true }, disruption: { enabled: false, fromDay: 0, toDay: 0, mode: 'delay', delayDays: 0 }, inboundOverrides: [] };
      const params = { ...baseParams, safetyStockBySku: { ...(baseParams.safetyStockBySku || {}) } };
      for (const item of dataset.dataset.items) {
        if (params.safetyStockBySku[item.sku] === undefined) params.safetyStockBySku[item.sku] = item.safetyStock ?? 0;
      }
      params.inboundOverrides = (baseParams.inboundOverrides || []).filter((entry) => (
        dataset.dataset.items.some((item) => item.sku === entry.sku
          && (item.openOrders || []).some((order) => order.id === entry.poId))
      ));
      const { scenario } = await api('/scenarios', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: $('#scenario-desc').value,
          datasetVersionId,
          params,
        }),
      });
      closeModal();
      await refreshAll({ keepSelection: false });
      state.selectedId = scenario.id;
      state.sku = null;
      renderSidebar();
      switchTab('workspace');
      toast('情景已创建，调整参数后运行模拟', 'good');
    } catch (error) {
      $('#scenario-error').textContent = error.message;
      button.disabled = false;
    }
  });
}

/* ---------------- Compare ---------------- */

function renderCompareSummary(preview) {
  const rows = preview.metrics.filter((metric) => ['fillRate', 'lost', 'stockoutDays', 'safetyBreachDays', 'totalOrdered', 'avgOnHand'].includes(metric.key));
  const lines = preview.lines;
  return `
    <div class="diff-summary" style="margin-bottom:10px">${esc(preview.candidate.name || '候选方案')} 对比 ${esc(preview.base.name || (preview.base.type === 'plan' ? `正式计划 v${preview.base.version}` : '基线'))}</div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>指标</th><th>基线</th><th>候选</th><th>变化</th></tr></thead>
      <tbody>${rows.map((metric) => {
        const good = metric.betterDirection === 'better' ? 'delta-up' : metric.betterDirection === 'worse' ? 'delta-down' : '';
        return `<tr><td>${metric.label}</td><td>${fmt(metric.base, metric.digits)}${metric.unit === '%' ? '%' : ''}</td>
          <td>${fmt(metric.candidate, metric.digits)}${metric.unit === '%' ? '%' : ''}</td>
          <td class="${good}">${metric.delta > 0 ? '+' : ''}${fmt(metric.delta, metric.digits)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <div class="btn-row" style="margin-top:10px;font-size:12px">
      <span class="pill">新增 ${lines.added.length}</span>
      <span class="pill">调整 ${lines.changed.length}</span>
      <span class="pill">移除 ${lines.removed.length}</span>
      <span class="pill">不变 ${Math.max(0, lines.unchanged)}</span>
    </div>`;
}

async function renderCompare() {
  const panel = $('#panel-compare');
  const simulated = state.scenarios.filter((scenario) => scenario.status !== 'draft');
  const scenarioOptions = simulated.map((scenario) => (
    `<option value="scenario:${scenario.id}" ${String(state.compareB) === String(scenario.id) ? 'selected' : ''}>${esc(scenario.name)}</option>`
  )).join('');
  const planOptions = state.plans.map((plan) => (
    `<option value="plan">正式计划 v${plan.version}（${plan.status === 'active' ? '生效中' : '已替代'}）</option>`
  )).join('');
  const baseOptions = state.activePlan
    ? `<option value="plan">当前正式计划 v${state.activePlan.version}</option>${simulated.map((scenario) => `<option value="scenario:${scenario.id}" ${String(state.compareA) === String(scenario.id) ? 'selected' : ''}>方案 · ${esc(scenario.name)}</option>`).join('')}`
    : `${planOptions}${simulated.map((scenario) => `<option value="scenario:${scenario.id}" ${String(state.compareA) === String(scenario.id) ? 'selected' : ''}>方案 · ${esc(scenario.name)}</option>`).join('')}`;

  panel.innerHTML = `
    <div class="compare-controls">
      <div class="field">
        <label for="cmp-base">基线</label>
        <select id="cmp-base">${baseOptions}</select>
      </div>
      <div class="field">
        <label for="cmp-cand">候选方案</label>
        <select id="cmp-cand">${scenarioOptions || '<option value="">暂无已模拟方案</option>'}</select>
      </div>
      <button class="btn" id="cmp-reload">刷新比较</button>
    </div>
    <div id="cmp-output"><div class="chart-empty">选择两个方案后展示比较</div></div>`;

  if (!state.compareB) {
    const first = simulated[0];
    state.compareB = first?.id ?? null;
    $('#cmp-cand').value = first ? `scenario:${first.id}` : '';
  }

  const reload = async () => {
    const baseValue = $('#cmp-base').value;
    state.compareA = baseValue.startsWith('scenario:') ? Number(baseValue.slice(9)) : null;
    const candValue = $('#cmp-cand').value;
    state.compareB = candValue ? Number(candValue.slice(9)) : null;
    if (!state.compareB) return;
    await renderCompareOutput();
  };
  $('#cmp-base').addEventListener('change', reload);
  $('#cmp-cand').addEventListener('change', reload);
  $('#cmp-reload').addEventListener('click', reload);
  if (state.compareB) await reload();
}

async function renderCompareOutput() {
  const output = $('#cmp-output');
  const candidateId = state.compareB;
  if (!candidateId) return;
  output.innerHTML = '<div class="chart-empty">正在计算比较…</div>';
  try {
    const query = state.compareA ? `?against=${state.compareA}` : '';
    const preview = await api(`/scenarios/${candidateId}/compare${query}`);
    const candidateDetail = await loadScenarioDetail(candidateId);

    let baseItems = [];
    let baseLabel = '正式计划';
    let baseSeriesSource = null;
    if (state.compareA) {
      const baseDetail = await loadScenarioDetail(state.compareA);
      baseItems = baseDetail.result?.items ?? [];
      baseLabel = baseDetail.name;
    } else if (state.activePlan) {
      const planDetail = await api(`/plans/${state.activePlan.id}`);
      const payload = planDetail.plan.payload;
      baseItems = payload.result?.items ?? payload.items;
      baseSeriesSource = payload.result ?? null;
      baseLabel = `正式计划 v${state.activePlan.version}`;
    }

    const candidateItems = candidateDetail.result.items;
    const sku = candidateItems.find((item) => item.sku === state.sku)?.sku ?? candidateItems[0].sku;
    const baseItem = baseItems.find((item) => item.sku === sku);
    const candItem = candidateItems.find((item) => item.sku === sku);
    if (baseSeriesSource) {
      const withSeries = baseSeriesSource.items.find((item) => item.sku === sku);
      if (withSeries) baseItem.series = withSeries.series;
    }
    state.sku = sku;

    output.innerHTML = `
      <div class="compare-grid">
        <div class="section-stack">
          <div class="card">
            <div class="card-head">
              <h3>关键指标对比</h3>
              <span class="hint">${esc(baseLabel)} → ${esc(candidateDetail.name)}</span>
            </div>
            <div class="card-pad">${renderMetricBars(preview.metrics)}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>分 SKU 对比</h3><span class="hint">满足率 / 缺口</span></div>
            <div class="table-wrap"><table class="data">
              <thead><tr><th>商品</th><th>满足率</th><th>基线</th><th>缺口</th><th>基线缺口</th><th>缺货天数</th><th>补货量</th></tr></thead>
              <tbody>${preview.items.map((item) => `
                <tr class="${item.sku === sku ? 'is-selected' : ''}" data-cmp-sku="${esc(item.sku)}" style="cursor:pointer">
                  <td>${esc(item.name)} <span class="sub mono">${esc(item.sku)}</span></td>
                  <td>${pct(item.fillRate)}</td>
                  <td class="sub">${item.fillRateBase === null ? '—' : pct(item.fillRateBase)}</td>
                  <td>${fmt(item.lost)}</td>
                  <td class="sub">${item.lostBase === null ? '—' : fmt(item.lostBase)}</td>
                  <td>${fmt(item.stockoutDays)} <span class="sub">/ ${item.stockoutDaysBase === null ? '—' : fmt(item.stockoutDaysBase)}</span></td>
                  <td>${fmt(item.totalOrdered)}</td>
                </tr>`).join('')}</tbody>
            </table></div>
          </div>
        </div>
        <div class="section-stack">
          <div class="card">
            <div class="card-head">
              <h3>在库曲线叠加</h3>
              <select id="cmp-sku" style="font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--surface-1)">
                ${candidateItems.map((item) => `<option value="${esc(item.sku)}" ${item.sku === sku ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
              </select>
            </div>
            <div class="chart-wrap">
              <div class="chart-toolbar"><div class="legend">
                <span class="legend-item"><span class="legend-swatch line" style="background:var(--series-1)"></span>候选</span>
                <span class="legend-item"><span class="legend-swatch line" style="background:var(--series-2)"></span>基线</span>
                <span class="legend-item"><span class="legend-swatch dash" style="color:var(--text-muted)"></span>安全库存</span>
              </div></div>
              <div class="chart-host" id="cmp-chart"></div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h3>补货单差异</h3><span class="hint">相对 ${esc(baseLabel)}</span></div>
            ${renderLineDiff(preview.lines, { expanded: state.diffExpanded })}
          </div>
        </div>
      </div>`;

    const baseSeries = baseItem?.series ?? null;
    renderChart($('#cmp-chart'), {
      dates: candItem.series.map((row) => row.date),
      lines: [
        { values: candItem.series.map((row) => row.onHand), color: 'var(--series-1)', label: '候选 在库' },
        {
          values: baseSeries ? baseSeries.map((row) => row.onHand) : candItem.series.map((row) => row.onHand),
          color: 'var(--series-2)',
          label: baseSeries ? '基线 在库' : '基线（无曲线数据）',
          opacity: 0.85,
        },
        { values: candItem.series.map((row) => row.safetyStock), color: 'var(--text-muted)', dash: '5 4', width: 1.5, label: '安全库存' },
      ],
      bands: candItem.series.filter((row) => row.lost > 0).map((row) => ({ from: row.day, to: row.day, color: 'color-mix(in srgb, var(--critical) 13%, transparent)' })),
      ariaLabel: '候选与基线在库曲线对比',
      height: 280,
    });

    const selectSku = (value) => {
      state.sku = value;
      renderCompareOutput();
    };
    $('#cmp-sku').addEventListener('change', (event) => selectSku(event.target.value));
    $$('[data-cmp-sku]').forEach((row) => row.addEventListener('click', () => selectSku(row.dataset.cmpSku)));
    $('[data-expand-diff]')?.addEventListener('click', () => {
      state.diffExpanded = true;
      renderCompareOutput();
    });
  } catch (error) {
    output.innerHTML = `<div class="verify-banner bad">比较失败：${esc(error.message)}</div>`;
  }
}

function renderMetricBars(metrics) {
  const selected = metrics.filter((metric) => ['fillRate', 'lost', 'stockoutDays', 'safetyBreachDays', 'totalOrdered', 'avgOnHand'].includes(metric.key));
  const maxOf = (key) => Math.max(1, ...selected.map((metric) => Math.max(metric.base, metric.candidate)));
  return `<div class="table-wrap"><table class="data metric-table">
    <thead><tr><th>指标</th><th>基线</th><th>候选</th><th>变化</th><th style="width:34%">对比</th></tr></thead>
    <tbody>${selected.map((metric) => {
      const max = maxOf(metric.key);
      const good = metric.betterDirection === 'better' ? 'delta-up' : metric.betterDirection === 'worse' ? 'delta-down' : '';
      const suffix = metric.unit === '%' ? '%' : '';
      return `<tr>
        <td>${metric.label}</td>
        <td class="sub">${fmt(metric.base, metric.digits)}${suffix}</td>
        <td>${fmt(metric.candidate, metric.digits)}${suffix}</td>
        <td class="${good}">${metric.delta > 0 ? '+' : ''}${fmt(metric.delta, metric.digits)}${metric.unit === '%' ? 'pp' : ''}</td>
        <td>
          <span class="mini-bars">
            <span class="mini-bar base" style="width:${Math.max(1, (metric.base / max) * 100)}%"></span>
            <span class="mini-bar cand" style="width:${Math.max(1, (metric.candidate / max) * 100)}%"></span>
          </span>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>
  <div class="legend" style="margin-top:10px"><span class="legend-item"><span class="legend-swatch" style="background:var(--surface-3)"></span>基线</span><span class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>候选</span></div>`;
}

function renderLineDiff(lines, { limit = 8, expanded = false, expandedLimit = 30, expandButton = true } = {}) {
  const groups = [
    { key: 'added', title: '新增补货单', cls: 'good', sign: '+' },
    { key: 'changed', title: '调整补货单', cls: 'warn', sign: '~' },
    { key: 'removed', title: '移除补货单', cls: 'bad', sign: '−' },
  ];
  const hasAny = lines.added.length + lines.changed.length + lines.removed.length > 0;
  if (!hasAny) return '<div class="chart-empty">补货单与基线一致</div>';
  const shown = expanded ? expandedLimit : limit;
  const hiddenTotal = groups.reduce((sum, group) => sum + Math.max(0, lines[group.key].length - shown), 0);
  return `<div class="diff-list">${groups.filter((group) => lines[group.key].length).map((group) => `
    <div class="diff-group-head"><span class="pill ${group.cls}">${group.sign}</span>${group.title} · ${lines[group.key].length}</div>
    ${lines[group.key].slice(0, shown).map((line) => {
      let chip = `<span class="diff-chip">${fmt(line.qty)} 件</span>`;
      let arrival = `<span class="muted" style="font-size:11px">${esc(line.arrivalDate)} 到</span>`;
      if (line.from) {
        const qtyChanged = line.qty !== line.from.qty;
        const arrivalChanged = line.arrivalDay !== line.from.arrivalDay;
        chip = qtyChanged
          ? `<span class="diff-chip ${line.qty > line.from.qty ? 'good' : 'bad'}">${fmt(line.from.qty)} → ${fmt(line.qty)} 件</span>`
          : `<span class="diff-chip">${fmt(line.qty)} 件</span>`;
        arrival = arrivalChanged
          ? `<span class="diff-chip warn">到货 ${esc(line.from.arrivalDate.slice(5))} → ${esc(line.arrivalDate.slice(5))}</span>`
          : arrival;
      }
      return `
      <div class="diff-line">
        <span class="mono">${esc(line.orderDate)}</span>
        <span>${esc(line.name)} <span class="mono" style="color:var(--text-muted)">${esc(line.sku)}</span></span>
        ${chip}
        ${arrival}
      </div>`;
    }).join('')}
    ${lines[group.key].length > shown ? `<div class="diff-line muted" style="display:block;padding-left:16px">… 另有 ${lines[group.key].length - shown} 条${expandButton ? '' : '，完整差异见「方案比较」'}</div>` : ''}
  `).join('')}
  ${expanded && expandButton && hiddenTotal > 0 ? `<div class="diff-line" style="justify-content:center"><button class="btn btn-sm" data-expand-diff>展开全部 ${lines.added.length + lines.changed.length + lines.removed.length} 条差异</button></div>` : ''}
  </div>`;
}

/* ---------------- Approvals ---------------- */

function renderApprovals() {
  const panel = $('#panel-approval');
  const pending = state.approvals.filter((approval) => approval.status === 'pending');
  const decided = state.approvals.filter((approval) => approval.status !== 'pending');
  const pendingSection = pending.map((approval) => {
    const expanded = state.approvalDiffExpanded === approval.id;
    return renderApprovalCard(approval, true, expanded);
  }).join('');

  panel.innerHTML = `
    <div class="section-stack">
      <div class="card">
        <div class="card-head"><h3>待审批</h3><span class="hint">${pending.length} 项</span></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
          ${pending.length ? pendingSection : '<div class="chart-empty">没有待审批的方案</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>审批记录</h3><span class="hint">确认过程可追溯</span></div>
        <div class="card-pad" style="display:flex;flex-direction:column;gap:12px">
          ${decided.length ? decided.map((approval) => renderApprovalCard(approval, false)).join('') : '<div class="chart-empty">还没有已处理的审批</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>操作记录</h3><span class="hint">最近 ${state.audit.length} 条</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
          <tbody>${state.audit.map((entry) => `
            <tr>
              <td>${fmtDateTime(entry.at)}</td>
              <td>${esc(entry.actor)}</td>
              <td class="mono" style="text-align:left">${esc(entry.action)}</td>
              <td>${esc(entry.entity)}${entry.entityId ? ` #${entry.entityId}` : ''}</td>
              <td style="text-align:left" class="sub">${esc(compactDetail(entry.detail))}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>
    </div>`;

  $$('[data-approve]').forEach((button) => button.addEventListener('click', () => decide(button.dataset.approve, 'approve')));
  $$('[data-reject]').forEach((button) => button.addEventListener('click', () => decide(button.dataset.reject, 'reject')));
  $$('[data-approval-diff]').forEach((button) => button.addEventListener('click', () => {
    const id = Number(button.dataset.approvalDiff);
    state.approvalDiffExpanded = state.approvalDiffExpanded === id ? null : id;
    renderApprovals();
  }));
  $$('[data-verify-approval]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const { verification } = await api(`/scenarios/${button.dataset.verifyApproval}/verify`, { method: 'POST' });
      toast(verification.ok ? '快照复现通过' : '快照复现失败：哈希不一致', verification.ok ? 'good' : 'bad');
      if (!verification.ok) console.warn(verification);
    } catch (error) {
      toast(error.message, 'bad');
    }
  }));
}

function compactDetail(detail) {
  if (!detail) return '';
  return Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}

function renderApprovalCard(approval, isPending, expanded = false) {
  const status = STATUS[approval.status] || STATUS.pending;
  const diff = approval.diff || {};
  const lines = diff.lines || { added: [], changed: [], removed: [] };
  const metrics = (diff.metrics || []).filter((metric) => ['fillRate', 'lost', 'stockoutDays', 'totalOrdered'].includes(metric.key));
  const totalDiffLines = (lines.added?.length ?? 0) + (lines.changed?.length ?? 0) + (lines.removed?.length ?? 0);
  return `
    <div class="approval-card">
      <div class="approval-head">
        <div>
          <div class="title">${esc(approval.scenarioName)}</div>
          <div class="muted" style="font-size:11.5px">申请 #${approval.id} · ${esc(approval.requestedBy)} · ${fmtDateTime(approval.createdAt)}</div>
        </div>
        <div class="btn-row">
          <span class="pill ${status.cls}">${status.label}</span>
          <button class="btn btn-sm" data-verify-approval="${approval.scenarioId}">校验快照</button>
          ${isPending ? `<button class="btn btn-sm btn-danger" data-reject="${approval.id}">驳回</button>
            <button class="btn btn-sm btn-primary" data-approve="${approval.id}">批准并生成计划</button>` : ''}
        </div>
      </div>
      <div class="approval-body">
        <div class="diff-summary">${esc(diff.summary || '无差异摘要')}</div>
        <div class="btn-row" style="font-size:12px">
          <span class="pill">新增 ${lines.added?.length ?? 0}</span>
          <span class="pill">调整 ${lines.changed?.length ?? 0}</span>
          <span class="pill">移除 ${lines.removed?.length ?? 0}</span>
          ${metrics.map((metric) => {
            const good = metric.betterDirection === 'better' ? 'good' : metric.betterDirection === 'worse' ? 'bad' : '';
            return `<span class="pill ${good}">${metric.label} ${metric.delta > 0 ? '+' : ''}${fmt(metric.delta, metric.digits)}${metric.unit === '%' ? 'pp' : ''}</span>`;
          }).join('')}
        </div>
        <div class="hash-row">
          <span>候选输入哈希</span><code>${esc(shortHash(diff.candidate?.inputHash))}</code>
          <span>结果哈希</span><code>${esc(shortHash(diff.candidate?.resultHash))}</code>
          <span>基线</span><code>${diff.basePlan ? `计划 v${diff.basePlan.version}` : '无'}</code>
        </div>
        ${approval.note ? `<div class="muted" style="font-size:12px">提交说明：${esc(approval.note)}</div>` : ''}
        ${approval.decisionNote ? `<div class="muted" style="font-size:12px">审批意见：${esc(approval.decisionNote)}</div>` : ''}
        ${totalDiffLines > 0 ? `
          <div>
            <button class="btn btn-sm" data-approval-diff="${approval.id}" aria-expanded="${expanded}">
              ${expanded ? '收起补货单差异' : `查看补货单差异（${totalDiffLines} 条）`}
            </button>
          </div>
          <div class="diff-group" ${expanded ? '' : 'hidden'}>
            ${expanded ? renderLineDiff(lines, { expanded: true, expandedLimit: 10, expandButton: false }) : ''}
          </div>` : ''}
        <ol class="timeline">
          <li>
            <span class="tl-dot done">✓</span>
            <div><div class="tl-title">模拟并提交</div><div class="tl-sub">${esc(approval.requestedBy)} · ${fmtDateTime(approval.createdAt)}</div></div>
          </li>
          <li>
            <span class="tl-dot ${isPending ? 'active' : approval.status === 'approved' ? 'done' : 'bad'}">${isPending ? '…' : approval.status === 'approved' ? '✓' : '✕'}</span>
            <div><div class="tl-title">${isPending ? '等待审批' : approval.status === 'approved' ? '审批通过' : '已驳回'}</div>
              <div class="tl-sub">${approval.decisionBy ? `${esc(approval.decisionBy)} · ${fmtDateTime(approval.decidedAt)}` : '—'}</div></div>
          </li>
          ${approval.status === 'approved' ? `<li>
            <span class="tl-dot done">✓</span>
            <div><div class="tl-title">生成正式计划 v${approval.resultingPlanVersion ?? approval.planVersion}</div>
              <div class="tl-sub">模拟结果转为正式计划，上一版本标记为已替代</div></div>
          </li>` : ''}
        </ol>
      </div>
    </div>`;
}

async function decide(approvalId, decision) {
  const verb = decision === 'approve' ? '批准' : '驳回';
  if (!window.confirm(`确认${verb}审批 #${approvalId}？${decision === 'approve' ? '通过后将生成新的正式计划版本。' : ''}`)) return;
  const note = window.prompt(`${verb}意见（可留空）`, '') ?? '';
  try {
    const outcome = await api(`/approvals/${approvalId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, decidedBy: actor(), decisionNote: note }),
    });
    await refreshAll();
    renderApprovals();
    renderTopbar();
    if (outcome.plan) {
      state.planDetail = outcome.plan.id;
      toast(`已批准，生成正式计划 v${outcome.plan.version}`, 'good');
    } else {
      toast('已驳回该申请', 'good');
    }
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/* ---------------- Plans ---------------- */

async function renderPlans() {
  const panel = $('#panel-plans');
  if (!state.plans.length) {
    panel.innerHTML = '<div class="card"><div class="empty-state"><strong>还没有正式计划</strong><span>在“审批与记录”中批准一个方案后生成。</span></div></div>';
    return;
  }
  if (!state.planDetail) state.planDetail = state.plans[0].id;
  const detail = await api(`/plans/${state.planDetail}`).then((body) => body.plan).catch(() => null);
  panel.innerHTML = `
    <div class="two-col">
      <div class="card">
        <div class="card-head"><h3>计划版本</h3><span class="hint">批准后只新增版本，不覆盖历史</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>版本</th><th>来源方案</th><th>状态</th><th>生成时间</th></tr></thead>
          <tbody>${state.plans.map((plan) => `
            <tr class="${plan.id === state.planDetail ? 'is-selected' : ''}" data-plan="${plan.id}" style="cursor:pointer">
              <td>v${plan.version}</td>
              <td style="text-align:left">${esc(plan.scenarioName)}</td>
              <td><span class="pill ${(STATUS[plan.status] || {}).cls || ''}">${(STATUS[plan.status] || {}).label || plan.status}</span></td>
              <td>${fmtDateTime(plan.createdAt)}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="card">
        ${detail ? `
          <div class="card-head">
            <h3>计划 v${detail.version}</h3>
            <span class="hint">${esc(detail.scenarioName)}</span>
          </div>
          <div class="kv-grid">
            <div class="kv"><span class="k">综合满足率</span><span class="v">${pct(detail.payload.totals.fillRate)}</span></div>
            <div class="kv"><span class="k">缺口</span><span class="v">${fmt(detail.payload.totals.lost)} 件</span></div>
            <div class="kv"><span class="k">补货单</span><span class="v">${detail.payload.lines.length} 条</span></div>
            <div class="kv"><span class="k">下单量</span><span class="v">${fmt(detail.payload.totals.totalOrdered)} 件</span></div>
            <div class="kv"><span class="k">计划来源</span><span class="v">方案 #${detail.scenarioId ?? '—'}</span></div>
            <div class="kv"><span class="k">生成时间</span><span class="v">${fmtDateTime(detail.createdAt)}</span></div>
          </div>
          <div class="card-pad" style="border-top:1px solid var(--border)">
            <div class="hash-row" style="margin-bottom:10px">
              <span>输入</span><code>${esc(shortHash(detail.inputHash))}</code>
              <span>结果</span><code>${esc(shortHash(detail.resultHash))}</code>
              <button class="btn btn-sm" id="plan-download">下载计划 JSON</button>
            </div>
            <div class="table-wrap" style="max-height:300px;overflow:auto">
              <table class="data">
                <thead><tr><th>下单日</th><th>商品</th><th>数量</th><th>到货日</th></tr></thead>
                <tbody>${detail.payload.lines.slice(0, 60).map((line) => `
                  <tr><td>${esc(line.orderDate)}</td><td style="text-align:left">${esc(line.name)} <span class="sub mono">${esc(line.sku)}</span></td><td>${fmt(line.qty)}</td><td>${esc(line.arrivalDate)}</td></tr>
                `).join('')}</tbody>
              </table>
            </div>
          </div>` : '<div class="chart-empty">选择左侧计划查看明细</div>'}
      </div>
    </div>`;

  $$('[data-plan]').forEach((row) => row.addEventListener('click', () => {
    state.planDetail = Number(row.dataset.plan);
    renderPlans();
  }));
  $('#plan-download')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(detail.payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `plan-v${detail.version}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

/* ---------------- Boot ---------------- */

async function boot() {
  $('#theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : current === 'light' ? 'dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
  const storedTheme = localStorage.getItem('theme');
  if (storedTheme) document.documentElement.dataset.theme = storedTheme;

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  $('#new-scenario').addEventListener('click', () => openScenarioModal(null));

  const meta = await api('/meta');
  state.meta = meta;
  $('#engine-version').textContent = meta.engineVersion;

  await refreshAll();
  renderTabs();
  await renderWorkspace();
}

boot().catch((error) => {
  console.error(error);
  toast(`初始化失败：${error.message}`, 'bad');
});
