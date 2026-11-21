/* 寰途前端：所有模型文本一律以 textContent 写入，不解析 HTML。 */

const $ = (id) => document.getElementById(id);

const state = {
  csrf: '',
  model: null,
  plan: null,
  interests: new Set(),
  busy: false,
  calendarLinks: null,
  public: false,
  noCode: false,
  authorized: true,
  // 知识库页签的缓存：避免每次切页签都请求一次
  library: null,
  libraryAt: 0,
  libraryCities: new Map(),
};

const PACE_LABEL = { relaxed: '慢节奏', balanced: '适中', intense: '紧凑' };
const HOTEL_LABEL = { budget: '经济', comfort: '舒适', boutique: '设计感 / 精品', luxury: '高端', homestay: '民宿', any: '不限' };
const TRANSPORT_LABEL = { public: '公共交通优先', walk: '步行优先', drive: '自驾 / 包车', mixed: '混合', any: '不限' };

/* ---------------- 基础工具 ---------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function append(parent, ...children) {
  for (const child of children) if (child) parent.append(child);
  return parent;
}

function notice(message, isError = false) {
  const box = $('notice');
  box.textContent = message || '';
  box.classList.toggle('is-error', Boolean(isError));
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function setBusy(value) {
  state.busy = value;
  $('submitPlan').disabled = value;
  $('submitReplan').disabled = value;
  $('cancelJob').hidden = !value;
}

/* ---------------- 任务轮询 ---------------- */

const STAGE_TEXT = {
  pending: ['任务已创建，等待开始…', '后台已经接手，马上开始研究目的地。'],
  researching: ['正在研究目的地…', '第一步：整理景点、小众去处、片区、住宿区域与季节提示。'],
  planning: ['正在编排行程…', '第二步：把研究结果排成每日动线，核算停留时间与交通耗时。'],
};

let pollTimer = null;
let pollFailures = 0;
let activeJobId = null;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 研究阶段的半成品：概览一出来就先给用户看，
 * 这样在编排每日动线的那几分钟里，屏幕上不是只有一个秒表在转。
 */
function renderPreview(preview) {
  const box = $('progressPreview');
  if (!box) return;
  box.replaceChildren();
  if (!preview) {
    box.hidden = true;
    return;
  }
  const ov = preview.overview || {};

  const head = el('div', 'preview-head');
  append(head, el('span', 'preview-tag', '研究已完成'));
  append(head, el('span', 'preview-note', '每日动线还在编排，下面是已经定下来的部分'));
  append(box, head);

  const title = ov.title || '';
  const summary = ov.summary || '';
  if (title) append(box, el('p', 'preview-title', title));
  if (summary) append(box, el('p', 'preview-summary', summary));

  const spots = Array.isArray(preview.attractions) ? preview.attractions : [];
  if (spots.length) {
    const ul = el('ul', 'preview-spots');
    for (const s of spots) {
      const li = el('li');
      append(li, el('b', null, s.name));
      if (s.area) append(li, el('span', null, s.area));
      append(ul, li);
    }
    append(box, ul);
  }

  const bits = [];
  if (preview.hotelArea) bits.push(`住宿片区：${preview.hotelArea}`);
  if (preview.hotelCount) bits.push(`候选酒店 ${preview.hotelCount} 家`);
  if (preview.confidence) bits.push(`信息置信度：${preview.confidence}`);
  if (bits.length) append(box, el('p', 'preview-meta', bits.join(' · ')));

  const warnings = Array.isArray(preview.warnings) ? preview.warnings.slice(0, 2) : [];
  if (warnings.length) {
    const ul = el('ul', 'preview-warnings');
    for (const w of warnings) append(ul, el('li', null, w));
    append(box, ul);
  }

  box.hidden = false;
}

function showProgress(job) {
  $('progress').hidden = false;
  const [title, detail] = STAGE_TEXT[job.status] || ['正在工作…', ''];
  const seconds = Math.max(0, Math.round((job.elapsedMs || 0) / 1000));
  $('progressTitle').textContent = title;
  $('progressDetail').textContent = detail;
  $('progressMeta').textContent = [
    `任务 ${job.id}`,
    job.trip?.destination ? `${job.trip.destination} · ${job.trip.days} 天` : '',
    seconds ? `已用时 ${seconds} 秒` : '',
    job.mode === 'replan' ? '重新规划' : '',
  ].filter(Boolean).join(' · ');
  $('cancelJob').hidden = !job.cancellable;
  $('cancelJob').textContent = job.status === 'pending' ? '取消任务' : '取消并中止模型请求';
  renderPreview(job.preview);
}

function hideProgress() {
  $('progress').hidden = true;
  $('progressMeta').textContent = '';
  renderPreview(null);
}

async function finishJob(jobId) {
  const { plan, job } = await api(`/api/jobs/${jobId}/result`);
  hideProgress();
  setBusy(false);
  showPlan(plan);
  if (job?.mode === 'replan') {
    // 重新规划后直接展示新的每日行程
    document.querySelector('[data-tab="days"]').click();
  }
  const seconds = Math.round((plan.meta?.elapsedMs || 0) / 1000);
  notice(`方案已生成（${plan.input.days} 天，用时约 ${seconds} 秒${plan.meta?.preservedItems ? `，保留 ${plan.meta.preservedItems} 处已确认安排` : ''}）。天气、房价与营业时间均为待核实信息。`);
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pollJob(jobId) {
  stopPolling();
  activeJobId = jobId;
  pollFailures = 0;
  pollTimer = setInterval(async () => {
    try {
      const { job } = await api(`/api/jobs/${jobId}`);
      pollFailures = 0;
      if (job.status === 'completed') {
        stopPolling();
        activeJobId = null;
        await finishJob(jobId);
        return;
      }
      if (job.status === 'failed') {
        stopPolling();
        activeJobId = null;
        hideProgress();
        setBusy(false);
        notice('规划失败：' + (job.error?.message || '未知错误'), true);
        return;
      }
      if (job.status === 'cancelled') {
        stopPolling();
        activeJobId = null;
        hideProgress();
        setBusy(false);
        notice('任务已取消，没有生成新方案。');
        return;
      }
      showProgress(job);
    } catch (error) {
      pollFailures += 1;
      if (pollFailures >= 3) {
        stopPolling();
        activeJobId = null;
        setBusy(false);
        notice('无法获取任务状态：' + error.message + '（任务可能仍在后台运行，可刷新页面查看）', true);
      }
    }
  }, 2000);
}

async function createJob(body) {
  const data = await api('/api/jobs', { method: 'POST', body });
  setBusy(true);
  showProgress(data.job);
  pollJob(data.jobId);
  return data.job;
}

/* ---------------- 公开试用：访问码闸门 ---------------- */

function showGate() {
  state.authorized = false;
  stopPolling();
  $('gate').hidden = false;
  $('main').hidden = true;
  const footer = document.querySelector('.site-footer');
  if (footer) footer.hidden = true;
  $('openSettings').hidden = true;
  $('modelStatus').textContent = '待输入访问码';
  $('modelStatus').dataset.state = 'checking';
  $('accessCode').focus();
}

function hideGate() {
  state.authorized = true;
  $('gate').hidden = true;
  $('main').hidden = false;
  const footer = document.querySelector('.site-footer');
  if (footer) footer.hidden = false;
}

/** 公开模式下改掉「本机」相关文案，并藏起访客用不到的入口 */
function applyPublicUi() {
  if (!state.public) return;
  $('openSettings').hidden = true;
  $('importLabel').hidden = true; // 导入接口在公开模式下不开放
  $('formHint').textContent = state.noCode
    ? '公开试用：任何人打开本页都能生成行程，每个网络每天有调用额度上限。'
    : '公开试用的模型额度由分享者提供，每次规划会消耗一次调用次数。';
  $('footerBrand').textContent = state.noCode ? '寰途 · 公开试用（无需访问码）' : '寰途 · 公开试用版';
  const boundary = $('boundaryHost');
  if (boundary) {
    boundary.textContent = '公开试用只开放创建行程、查看进度与结果；模型设置与日历写入不对访客开放。';
  }
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', '寰途公开试用：由服务端代你调用旅行规划模型。');
}

$('gateForm').onsubmit = async (event) => {
  event.preventDefault();
  const code = $('accessCode').value;
  const error = $('gateError');
  error.textContent = '';
  if (!code || code.length < 8) {
    error.textContent = '请填写访问码。';
    return;
  }
  $('gateSubmit').disabled = true;
  try {
    await api('/api/session', { method: 'POST', body: { code } });
    // 访问码只在这一次请求里出现；浏览器里只留下服务端发的 HttpOnly Cookie
    $('accessCode').value = '';
    hideGate();
    await boot({ skipGateCheck: true, publicMode: true });
  } catch (err) {
    error.textContent = err.message;
  } finally {
    $('gateSubmit').disabled = false;
  }
};

/* ---------------- 请求 ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Huantu-CSRF': state.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (!res.ok) throw new Error(`请求未完成（HTTP ${res.status}）：服务返回了无法识别的内容，请确认寰途服务仍在运行。`);
    throw new Error('服务返回了无法识别的内容，请确认寰途服务仍在运行。');
  }
  if (!res.ok) {
    if (res.status === 401 && data.code === 'access_code_required') {
      showGate();
      throw Object.assign(new Error('需要访问码才能继续。'), { status: 401 });
    }
    throw Object.assign(new Error(data.error || `请求未完成（HTTP ${res.status}）。`), { status: res.status, data });
  }
  return data;
}

/* ---------------- 状态与模型设置 ---------------- */

function renderStatus() {
  const s = state.model;
  const pill = $('modelStatus');
  if (!s) {
    pill.textContent = '无法连接本机服务';
    pill.dataset.state = 'offline';
    return;
  }
  // 公开模式：不显示模型地址/ID/密钥状态，只说是不是在使用公开试用
  if (state.public) {
    $('openSettings').hidden = true;
    pill.textContent = state.noCode
      ? '公开试用 · 无需访问码'
      : (s.ready ? '公开试用模式' : '公开试用 · 模型未就绪');
    pill.dataset.state = s.ready ? 'online' : 'offline';
    return;
  }
  $('openSettings').hidden = false;
  if (!s.configured) {
    pill.textContent = '未连接模型';
    pill.dataset.state = 'offline';
  } else if (!s.verified) {
    pill.textContent = '已配置 · 未验证';
    pill.dataset.state = 'configured';
  } else {
    pill.textContent = `已验证 · ${s.model}`;
    pill.dataset.state = 'online';
  }
}

async function refreshState() {
  const s = await api('/api/state');
  state.csrf = s.csrf;
  state.model = s;
  renderStatus();
  return s;
}

$('openSettings').onclick = () => {
  if (state.public) return; // 公开模式下访客不能改模型配置
  const s = state.model;
  if (s) {
    $('baseUrl').value = s.baseUrl || '';
    $('model').value = s.model || '';
    $('protocol').value = s.protocol || 'chat-completions';
    $('role').value = s.role || 'system';
  }
  $('apiKey').value = '';
  $('testResult').textContent = '';
  $('testResult').classList.remove('is-error');
  $('settings').showModal();
};

$('closeSettings').onclick = () => $('settings').close();

$('settingsForm').onsubmit = async (event) => {
  event.preventDefault();
  const result = $('testResult');
  result.classList.remove('is-error');
  result.textContent = '正在保存配置并向服务商发送一条不含个人数据的测试请求…';
  $('connect').disabled = true;
  try {
    await api('/api/config', {
      method: 'POST',
      body: {
        baseUrl: $('baseUrl').value.trim(),
        model: $('model').value.trim(),
        protocol: $('protocol').value,
        role: $('role').value,
        apiKey: $('apiKey').value,
      },
    });
    $('apiKey').value = '';
    const test = await api('/api/test', { method: 'POST', body: {} });
    result.textContent = `真实请求成功 · ${test.model} · ${test.protocol} · ${test.elapsedMs} ms\n模型返回：${test.reply}`;
    notice('模型连接测试通过，可以开始规划。');
    await refreshState();
  } catch (error) {
    result.classList.add('is-error');
    result.textContent = error.message;
    await refreshState().catch(() => {});
  } finally {
    $('connect').disabled = false;
  }
};

$('forget').onclick = async () => {
  try {
    await api('/api/config', { method: 'DELETE' });
    $('apiKey').value = '';
    $('testResult').textContent = '后端内存中的密钥已清除。页面不会保留任何密钥副本。';
    await refreshState();
  } catch (error) {
    $('testResult').textContent = error.message;
  }
};

/* ---------------- 表单 ---------------- */

function defaultStartDate() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

$('startDate').value = defaultStartDate();

$('interestChips').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  const value = chip.dataset.interest;
  if (state.interests.has(value)) {
    state.interests.delete(value);
    chip.classList.remove('is-active');
    chip.setAttribute('aria-pressed', 'false');
  } else {
    if (state.interests.size >= 8) {
      notice('兴趣标签最多选择 8 个。', true);
      return;
    }
    state.interests.add(value);
    chip.classList.add('is-active');
    chip.setAttribute('aria-pressed', 'true');
  }
});

function collectTrip() {
  return {
    origin: $('origin').value.trim(),
    destination: $('destination').value.trim(),
    startDate: $('startDate').value,
    days: Number($('days').value),
    travelers: Number($('travelers').value),
    children: Number($('children').value || 0),
    budget: $('budget').value.trim(),
    interests: [...state.interests],
    pace: $('pace').value,
    transport: $('transport').value,
    hotel: $('hotel').value,
    special: $('special').value.trim(),
  };
}

$('importPlan').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    notice('文件过大（超过 2 MB），请确认是寰途导出的行程 JSON。', true);
    return;
  }
  try {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      notice('文件不是有效的 JSON。', true);
      return;
    }
    const data = await api('/api/plan/import', { method: 'POST', body: { plan: parsed.plan || parsed } });
    showPlan(data.plan);
    notice('已导入行程。导入不会调用模型，也不会改动原文件；时效信息仍为「待核实」。');
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    notice('导入失败：' + error.message, true);
  }
});

$('planForm').onsubmit = async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const trip = collectTrip();
  if (!trip.origin || !trip.destination) {
    notice('请填写出发地与目的地。', true);
    return;
  }
  if (!trip.startDate) {
    notice('请选择出发日期。', true);
    return;
  }
  notice('');
  try {
    // 立即返回：任务在后台跑，页面每 2 秒轮询状态，不再让请求一直挂着
    await createJob({ trip });
    notice('任务已创建，正在后台研究目的地。可以离开这一页，回来时会继续显示进度。');
  } catch (error) {
    setBusy(false);
    notice('无法创建规划任务：' + error.message, true);
  }
};

/* ---------------- 展示 ---------------- */

function showPlan(plan) {
  state.plan = plan;
  state.calendarLinks = null;
  $('formSection').hidden = true;
  $('result').hidden = false;
  $('resultTitle').textContent = plan.overview.title;
  $('resultMeta').textContent = [
    `${plan.input.startDate} → ${plan.input.endDate}`,
    `${plan.input.days} 天`,
    `${plan.input.travelers} 人`,
    `生成于 ${fmtDateTime(plan.meta.generatedAt)}`,
    plan.meta.mode === 'replan' ? '已按新要求调整' : '',
  ].filter(Boolean).join(' · ');
  renderOverview();
  renderDays();
  renderSpots();
  renderHotels();
  renderRoute();
  renderMap();
  renderCalendar();
  renderSources();
  renderLibrary();
  // 支持 #result:library 这类直达链接（刷新后仍停在同一页签，也方便分享具体分区）
  const direct = /^#result:([a-z]+)(?:\/.*)?$/.exec(location.hash || '');
  if (direct && document.querySelector(`.tab[data-tab="${direct[1]}"]`)) {
    document.querySelector(`.tab[data-tab="${direct[1]}"]`).click();
  }
}

function metaCell(label, value) {
  const cell = el('div', 'meta-cell');
  append(cell, el('dt', null, label), el('dd', null, value || '—'));
  return cell;
}

const BUDGET_LEVEL = {
  over: ['超出预算', 'is-over'],
  tight: ['贴近上限', 'is-tight'],
  ok: ['预算内', 'is-ok'],
  unknown: ['未估出', 'is-unknown'],
  none: ['未设预算', 'is-none'],
};

const BUDGET_CATEGORY_ORDER = ['交通', '住宿', '门票', '餐饮', '其他'];

function money(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return `¥${Math.round(Number(n)).toLocaleString('zh-CN')}`;
}

/**
 * 费用卡片。
 * 数字全部来自服务端重新求和的结果（模型的算术不可信），
 * 因此这里只负责展示，不再做任何加减。
 */
function renderBudgetBlock(plan) {
  const b = plan.budget;
  const c = plan.budgetCheck;
  if (!b || !c || !b.items || !b.items.length) return null;

  const [levelText, levelClass] = BUDGET_LEVEL[c.level] || BUDGET_LEVEL.none;
  const block = el('div', 'block budget-block');
  append(block, el('h3', null, '费用估算'));

  const bar = el('div', `budget-bar ${levelClass}`);
  append(bar, el('span', 'budget-tag', levelText));
  if (c.headline) append(bar, el('span', 'budget-headline', c.headline));
  append(block, bar);

  const figures = el('dl', 'budget-figures');
  const fig = (label, value) => append(el('div'), el('dt', null, label), el('dd', null, value));
  append(
    figures,
    fig('人均', money(c.estimatedPerPerson)),
    fig(`${c.travelers} 人合计`, money(c.estimatedTotal)),
    fig('预算', c.provided ? `${money(c.limitTotal)}${c.scope === 'perPerson' ? '（人均口径）' : ''}` : '未填写'),
  );
  append(block, figures);

  const cats = BUDGET_CATEGORY_ORDER
    .map((name) => ({ name, amount: b.byCategory?.[name] || 0 }))
    .filter((x) => x.amount > 0);
  const max = Math.max(...cats.map((x) => x.amount), 1);
  const catBox = el('div', 'budget-cats');
  for (const cat of cats) {
    const row = el('div', 'budget-cat');
    const track = el('span', 'budget-cat-track');
    const fill = el('i');
    fill.style.width = `${Math.max(6, Math.round((cat.amount / max) * 100))}%`;
    track.append(fill);
    append(row, el('span', 'budget-cat-name', cat.name), el('span', 'budget-cat-amount', money(cat.amount)), track);
    append(catBox, row);
  }
  append(block, catBox);

  const details = el('details', 'budget-details');
  append(details, el('summary', null, `逐项明细（${b.items.length} 项）`));
  const ul = el('ul', 'budget-items');
  for (const it of b.items) {
    const li = el('li');
    const head2 = el('div', 'budget-item-head');
    append(
      head2,
      el('span', 'budget-item-name', `${it.category} · ${it.label || '未命名'}`),
      el('span', 'budget-item-amount', money(it.amount)),
    );
    append(li, head2);
    const bits = [it.basis, it.confidence].filter(Boolean);
    if (bits.length) append(li, el('p', 'budget-item-basis', bits.join(' · ')));
    append(ul, li);
  }
  append(details, ul);
  append(block, details);

  if (c.advice) append(block, el('p', 'budget-advice', c.advice));
  if (b.note) append(block, el('p', 'budget-note', b.note));
  if (b.totalMismatch) {
    append(block, el('p', 'budget-note', '模型自报的合计与逐项相加对不上，页面显示的是逐项求和的结果。'));
  }
  append(
    block,
    el('p', 'verify-line', '费用为模型估算，除标注「待核实」的项目外均未经实时比价；'
      + '实际支出以官方报价与现场为准。'),
  );
  return block;
}

function renderOverview() {
  const plan = state.plan;
  const p = $('tabOverview');
  p.replaceChildren();

  const head = el('div');
  append(head, el('p', 'plan-summary', plan.overview.summary || '（模型未提供概述）'));

  const grid = el('dl', 'meta-grid');
  append(
    grid,
    metaCell('出发地', plan.input.origin),
    metaCell('目的地', plan.input.destination),
    metaCell('日期', `${fmtDate(plan.input.startDate)} – ${fmtDate(plan.input.endDate)}`),
    metaCell('天数', `${plan.input.days} 天`),
    metaCell('人数', `${plan.input.travelers} 人${plan.input.children ? `（含儿童 ${plan.input.children}）` : ''}`),
    metaCell('预算', plan.input.budget),
    metaCell('节奏', PACE_LABEL[plan.input.pace] || plan.input.pace),
    metaCell('住宿偏好', HOTEL_LABEL[plan.input.hotelPreference] || '不限'),
  );

  append(p, head, grid);

  const budgetBlock = renderBudgetBlock(plan);
  if (budgetBlock) append(p, budgetBlock);

  if (plan.overview.highlights.length) {
    const block = el('div', 'block');
    append(block, el('h3', null, '本次行程的取舍'));
    const ul = el('ul', 'highlights');
    for (const item of plan.overview.highlights) append(ul, el('li', null, item));
    append(block, ul);
    append(p, block);
  }

  const routeBlock = el('div', 'block');
  append(routeBlock, el('h3', null, '路线逻辑'));
  const dl = el('dl', 'fact-row');
  const facts = [
    ['住宿区域', plan.route.hotelArea || '待确认'],
    ['排布逻辑', plan.route.logic || '未说明'],
    ['补充说明', plan.route.notes || '—'],
    ['节奏说明', plan.overview.paceNote || '—'],
    ['适合人群', plan.overview.bestFor || '—'],
  ];
  for (const [k, v] of facts) append(dl, el('dt', null, k), el('dd', null, v));
  append(routeBlock, dl);
  append(p, routeBlock);

  const season = plan.insights.season;
  if (season.summary || season.tips.length) {
    const block = el('div', 'block');
    append(block, el('h3', null, '季节与天气'));
    append(block, el('p', 'plan-summary', season.summary || '模型未提供季节说明。'));
    if (season.tips.length) {
      const ul = el('ul', 'highlights');
      for (const tip of season.tips) append(ul, el('li', null, tip));
      append(block, ul);
    }
    const liveWeather = plan._live && plan._live.weather;
    if (liveWeather && liveWeather.days && liveWeather.days.length) {
      const ul = el('ul', 'highlights');
      for (const d of liveWeather.days) {
        const rain = d.precip == null ? '' : `，降水概率 ${d.precip}%`;
        append(ul, el('li', null, `${d.date}：${d.summary}，${d.tmin ?? '?'}~${d.tmax ?? '?'}℃${rain}`));
      }
      append(block, ul);
    }
    const liveNote = liveWeather && liveWeather.source
      ? `数据来源：${liveWeather.source}${liveWeather.kind === 'climate' ? '（去年同日的实测值，仅作气候参考，不是预报）' : ''}，查询于 ${plan._searchedAt ? fmtDateTime(plan._searchedAt) : '本次规划'}。数值仅供参考，出行前请再查一次官方预报。`
      : '本机未接入天气接口，以上为常识性估计，请以出行前官方预报为准。';
    const verify = el('p', 'verify-line', `天气：${season.weather} · ${liveNote}`);
    append(block, verify);
    append(p, block);
  }

  const suit = plan.insights.suitability;
  const suitRows = [
    ['亲子', suit.family], ['情侣', suit.couples], ['长辈', suit.seniors], ['独自', suit.solo],
  ].filter(([, v]) => v);
  if (suitRows.length) {
    const block = el('div', 'block');
    append(block, el('h3', null, '适合同行人'));
    const dl2 = el('dl', 'fact-row');
    for (const [k, v] of suitRows) append(dl2, el('dt', null, k), el('dd', null, v));
    append(block, dl2);
    append(p, block);
  }

  const block = el('div', 'block');
  append(block, el('h3', null, '出行提示'));
  const ul = el('ul', 'warning-list');
  for (const w of plan.warnings) append(ul, el('li', null, w));
  append(block, ul);
  if (plan.confidence.missing.length) {
    append(block, el('p', 'plan-summary', '仍缺信息：' + plan.confidence.missing.join('、')));
  }
  append(p, block);
}

function renderDays() {
  const plan = state.plan;
  const wrap = $('tabDays');
  wrap.replaceChildren();

  const intro = el('p', 'route-note', '时间轴含预计停留与交通耗时。点击「锁定这一天」后，重新规划会强制保留该日安排。');
  append(wrap, intro);

  for (const day of plan.days) {
    const card = el('article', 'day-card' + (day.locked ? ' is-locked' : ''));

    const head = el('div', 'day-head');
    const titleBox = el('div');
    append(
      titleBox,
      el('p', 'day-label', `${day.label}${day.preservedFrom ? ' · 已保留' : ''}`),
      el('h3', 'day-theme', day.theme),
      el('p', 'day-sub', `${day.date} ${day.weekday}${day.area ? ` · ${day.area}` : ''} · ${day.items.length} 项安排`),
    );

    const lock = el('button', 'lock-toggle', day.locked ? '已锁定' : '锁定这一天');
    lock.type = 'button';
    lock.setAttribute('aria-pressed', String(Boolean(day.locked)));
    lock.onclick = () => {
      day.locked = !day.locked;
      lock.textContent = day.locked ? '已锁定' : '锁定这一天';
      lock.setAttribute('aria-pressed', String(day.locked));
      card.classList.toggle('is-locked', day.locked);
      notice(day.locked ? `${day.label} 已锁定，重新规划时会保留这一天。` : `${day.label} 已解除锁定。`);
    };
    append(head, titleBox, lock);
    append(card, head);

    if (day.items.length) {
      const timeline = el('div', 'timeline');
      for (const item of day.items) {
        const row = el('div', 'timeline-item');
        const time = el('div', 'ti-time', item.time || '待定');
        if (item.endTime) append(time, el('small', null, `至 ${item.endTime}`));
        const body = el('div', 'ti-body');
        const titleRow = el('div', 'ti-head');
        const title = el('h4');
        append(title, el('span', null, item.title), el('span', 'type-badge', item.type));
        if (item.locked) append(title, el('span', 'type-badge', '已保留'));
        const itemLock = el('button', 'ti-lock', item.locked ? '已锁定' : '锁定');
        itemLock.type = 'button';
        itemLock.setAttribute('aria-pressed', String(Boolean(item.locked)));
        itemLock.title = '锁定后重新规划会强制保留这一项';
        itemLock.onclick = () => {
          item.locked = !item.locked;
          itemLock.textContent = item.locked ? '已锁定' : '锁定';
          itemLock.setAttribute('aria-pressed', String(item.locked));
          title.querySelectorAll('.type-badge').forEach((badge) => {
            if (badge.textContent === '已保留') badge.remove();
          });
          if (item.locked) append(title, el('span', 'type-badge', '已保留'));
          notice(item.locked ? `已锁定「${item.title}」，重新规划时会保留。` : `已解除「${item.title}」的锁定。`);
        };
        append(titleRow, title, itemLock);
        append(body, titleRow);
        if (item.detail) append(body, el('p', 'ti-detail', item.detail));
        const meta = el('div', 'ti-meta');
        append(meta, el('span', null, `停留 ${item.durationMin} 分钟`));
        if (item.transportFromPrev) {
          append(meta, el('span', null, `${item.transportFromPrev}${item.transportMin ? ` · 约 ${item.transportMin} 分钟` : ''}`));
        }
        if (item.cost) append(meta, el('span', null, `花费：${item.cost}`));
        if (item.booking) append(meta, el('span', null, `预约：${item.booking}`));
        append(body, meta);
        if (item.backup) append(body, el('p', 'ti-backup', `雨天或临时关闭：${item.backup}`));
        append(row, time, body);
        append(timeline, row);
      }
      append(card, timeline);
    } else {
      append(card, el('p', 'empty-state', '这一天没有具体安排。'));
    }

    const meals = day.meals;
    const mealRows = [
      ['早餐', meals.breakfast.suggestion],
      ['午餐', meals.lunch.suggestion],
      ['晚餐', meals.dinner.suggestion],
    ].filter(([, v]) => v);
    if (mealRows.length) {
      const box = el('div', 'day-meals');
      for (const [label, value] of mealRows) {
        const line = el('p');
        append(line, el('span', null, label), document.createTextNode(value));
        append(box, line);
      }
      append(card, box);
    }

    const extra = [];
    if (day.rest) extra.push(['休息', day.rest]);
    if (day.freeTime) extra.push(['自由时间', day.freeTime]);
    if (day.backupPlan) extra.push(['全天备选', day.backupPlan]);
    if (day.notes) extra.push(['备注', day.notes]);
    if (extra.length) {
      const box = el('div', 'day-extra');
      for (const [label, value] of extra) {
        const line = el('p');
        append(line, el('strong', null, label + '：'), document.createTextNode(value));
        append(box, line);
      }
      append(card, box);
    }

    append(wrap, card);
  }
}

// 推荐地点的实景图：右下角一行小灰字标来源，点它跳原网页
function photoFigure(name) {
  const photos = (state.plan && state.plan.photos) || {};
  const photo = photos[name];
  if (!photo || !photo.image) return null;
  const fig = el('figure', 'spot-photo');
  const img = document.createElement('img');
  img.src = photo.image;
  img.alt = name;
  img.loading = 'eager';
  img.referrerPolicy = 'no-referrer';
  // 图没真正画出来之前不上屏：防盗链、404、超时都只会让这块「不出现」，不会留一个空框。
  fig.style.opacity = '0';
  const drop = () => fig.remove();
  img.addEventListener('load', () => { fig.style.opacity = ''; });
  img.addEventListener('error', drop);
  setTimeout(() => { if (!img.complete || !img.naturalWidth) drop(); }, 9000);
  append(fig, img);
  const cap = el('figcaption');
  const label = `来源 · ${photo.sourceName || '原文'}`;
  if (photo.sourceUrl) {
    const a = el('a', null, label);
    a.href = photo.sourceUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = photo.sourceUrl;
    cap.append(a);
  } else {
    cap.textContent = label;
  }
  append(fig, cap);
  return fig;
}

// 景点卡片的「实时情报」：优先显示整理好的中文要点；没查到就明说为什么没查到，
// 别拿一句「待核实」糊过去——用户有权知道是没搜、没命中、还是页面里本来就没写。
function spotFactBlock(name) {
  const live = state.plan && state.plan._live;
  if (!live) return null;
  const pack = live.spotFacts && live.spotFacts[name];
  const sum = live.spotFactSummary && live.spotFactSummary[name];
  const miss = live.spotFactMisses && live.spotFactMisses[name];
  const hasPack = pack && Array.isArray(pack.results) && pack.results.length > 0;
  if (!sum && !hasPack && !miss) return null;

  const wrap = el('div', 'spot-facts-live');

  // 一、整理好的中文要点
  if (sum) {
    wrap.dataset.state = 'ok';
    append(wrap, el('p', 'spot-facts-title', '实时情报 · 已从原文整理成中文'));
    const rows = [
      ['门票', sum.ticket],
      ['开放', sum.hours],
      ['休息', sum.closed],
      ['预约', sum.booking],
      ['提示', sum.note],
    ].filter(([, v]) => v);
    const dl = el('dl', 'fact-list');
    for (const [k, v] of rows) {
      const line = el('div', 'fact-row');
      append(line, el('dt', null, k));
      append(line, el('dd', null, v));
      append(dl, line);
    }
    append(wrap, dl);

    const src = el('p', 'fact-src');
    const label = sum.sourceName || '原文页面';
    if (sum.sourceUrl) {
      const a = el('a', null, label);
      a.href = sum.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      append(src, document.createTextNode('来源 · '));
      append(src, a);
    } else {
      src.textContent = '来源 · ' + label;
    }
    const extra = (hasPack ? pack.results : []).filter((r) => r.url && r.url !== sum.sourceUrl).slice(0, 2);
    if (extra.length) {
      append(src, document.createTextNode('　原网页：'));
      extra.forEach((r, i) => {
        if (i) append(src, document.createTextNode(' · '));
        const a = el('a', null, r.site || '链接');
        a.href = r.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        append(src, a);
      });
    }
    append(wrap, src);
    return wrap;
  }

  // 二、抓到了原文，但整理成中文那一步没成功
  if (hasPack) {
    wrap.dataset.state = 'ok';
    append(wrap, el('p', 'spot-facts-title', '实时检索到的原文（未能整理成中文）'));
    for (const r of pack.results.slice(0, 2)) {
      const item = el('div', 'hit-item');
      append(item, hitIconEl(r));
      const body = el('div', 'hit-body');
      const head = el('div', 'hit-head');
      const a = el('a', 'hit-title', cleanSnippet(r.title) || '（无标题）');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      append(head, a);
      if (r.site) append(head, el('span', 'hit-site', r.site));
      append(body, head);
      const snip = cleanSnippet(r.snippet || '');
      if (snip) append(body, el('p', 'hit-snippet', snip));
      append(item, body);
      append(wrap, item);
    }
    return wrap;
  }

  // 三、压根没查到 —— 说清楚是哪一环断的
  wrap.dataset.state = 'miss';
  wrap.classList.add('is-miss');
  append(wrap, el('p', 'spot-facts-title', '实时情报 · 这次没查到'));
  append(wrap, el('p', 'miss-detail', miss.detail || '没有找到可用的公开页面'));
  if (miss.query) append(wrap, el('p', 'fact-src', `查询词：${miss.query}`));
  return wrap;
}

function spotCard(item, kind) {
  const card = el('article', 'spot-card');
  const photo = photoFigure(item.name);
  if (photo) append(card, photo);
  append(card, el('h4', null, item.name));
  if (item.area) append(card, el('p', 'spot-area', item.area));
  if (item.why) append(card, el('p', 'spot-why', item.why));

  // 先摆实时检索到的原文，再摆结构化字段
  const liveFacts = kind === 'attraction' ? spotFactBlock(item.name) : null;
  const hasFacts = Boolean(liveFacts && liveFacts.dataset.state === 'ok');
  if (liveFacts) append(card, liveFacts);

  const facts = el('div', 'spot-facts');
  const rows = [];
  // 已经有官网原文摆在上面了，就别再用一句「待核实」占位——那不是补充信息，是自相矛盾
  const isUnverified = (v) => hasFacts && /待核实/u.test(String(v || ''));
  if (item.suggestedDuration) rows.push(['建议停留', item.suggestedDuration]);
  if (item.bestTime) rows.push(['最佳时段', item.bestTime]);
  if (item.openingHours && !isUnverified(item.openingHours)) rows.push(['开放时间', item.openingHours]);
  if (item.ticket && !isUnverified(item.ticket)) rows.push(['门票', item.ticket]);
  if (item.crowd) rows.push(['人流', item.crowd]);
  if (item.duration && kind !== 'attraction') rows.push(['时长', item.duration]);
  if (item.priceRange && kind !== 'attraction') rows.push(['人均', item.priceRange]);
  if (item.booking) rows.push(['预约', item.booking]);
  if (item.note) rows.push(['提示', item.note]);
  for (const [label, value] of rows) {
    const line = el('p');
    append(line, el('b', null, label), document.createTextNode(value));
    append(facts, line);
  }
  if (rows.length) append(card, facts);

  if (item.suitableFor?.length) {
    const tags = el('div', 'tags');
    for (const t of item.suitableFor) append(tags, el('span', 'tag', t));
    append(card, tags);
  }
  if (kind === 'attraction') {
    const factState = liveFacts ? liveFacts.dataset.state : '';
    const verifyClass = factState === 'ok' ? 'verify-line is-sourced'
      : (factState === 'miss' ? 'verify-line is-miss' : 'verify-line');
    const verifyText = factState === 'ok'
      ? '以上为检索当时的公开信息，出行前请以官方最新公告为准。'
      : (factState === 'miss' ? '这几个字段没查到实时来源，出行前请自行核实。' : '开放时间、门票与预约规则需出行前核实。');
    append(card, el('p', verifyClass, verifyText));
    if (item.backup) append(card, el('p', 'ti-backup', `备选：${item.backup}`));
  }
  return card;
}

function section(parent, title, items, renderFn, emptyText) {
  const block = el('div', 'block');
  append(block, el('h3', null, `${title}${items.length ? ` · ${items.length}` : ''}`));
  if (!items.length) {
    append(block, el('p', 'empty-state', emptyText || '模型未提供该部分内容。'));
  } else {
    const grid = el('div', 'card-grid');
    for (const item of items) append(grid, renderFn(item));
    append(block, grid);
  }
  append(parent, block);
}

function renderSpots() {
  const plan = state.plan;
  const wrap = $('tabSpots');
  wrap.replaceChildren();
  const ins = plan.insights;
  section(wrap, '值得游览的景点', ins.attractions, (x) => spotCard(x, 'attraction'), '本次未给出景点清单。');
  section(wrap, '小众目的地', ins.hiddenGems, (x) => spotCard(x, 'gem'), '暂无小众推荐。');
  section(wrap, '特色活动', ins.activities, (x) => spotCard(x, 'activity'), '暂无活动推荐。');
  section(wrap, '当地美食', ins.food, (x) => spotCard(x, 'food'), '暂无美食推荐。');
  section(wrap, '餐厅与咖啡馆', ins.cafes, (x) => spotCard(x, 'cafe'), '暂无咖啡馆推荐。');

  const block = el('div', 'block');
  append(block, el('h3', null, '交通方式'));
  if (ins.transport.length) {
    const dl = el('dl', 'fact-row');
    for (const t of ins.transport) {
      const dd = el('dd');
      append(dd, el('span', null, t.detail || ''));
      if (t.cost) append(dd, el('span', 'tag', `费用 ${t.cost}`));
      if (t.note) append(dd, el('span', 'tag', t.note));
      append(dl, el('dt', null, t.mode || '交通'), dd);
    }
    append(block, dl);
  } else {
    append(block, el('p', 'empty-state', '暂无交通建议。'));
  }
  append(block, el('p', 'route-note', '交通班次、末班车时间与票价均需自行核实。'));
  append(wrap, block);
}

function renderHotels() {
  const plan = state.plan;
  const wrap = $('tabHotels');
  wrap.replaceChildren();
  append(wrap, el('p', 'route-note', '寰途不代订、不代付款。以下为片区与类型建议，房价与可订状态需你在预订平台核实。'));

  if (!plan.hotels.length) {
    append(wrap, el('p', 'empty-state', '模型未给出住宿建议。'));
  } else {
    const grid = el('div', 'card-grid');
    for (const hotel of plan.hotels) {
      const card = el('article', 'spot-card');
      const photo = photoFigure(hotel.name);
      if (photo) append(card, photo);
      append(card, el('h4', null, hotel.name));
      if (hotel.area) append(card, el('p', 'spot-area', hotel.area));
      append(card, el('p', 'hotel-price', hotel.priceRange));
      if (hotel.reason) append(card, el('p', 'spot-why', hotel.reason));
      const facts = el('div', 'spot-facts');
      const rows = [
        ['评分', `${hotel.rating}（${hotel.ratingSource}）`],
        ['距主要景点', hotel.distanceToSights],
        ['距交通枢纽', hotel.distanceToTransit],
      ];
      for (const [label, value] of rows) {
        const line = el('p');
        append(line, el('b', null, label), document.createTextNode(value || '待核实'));
        append(facts, line);
      }
      append(card, facts);
      if (hotel.suitableFor.length) {
        const tags = el('div', 'tags');
        for (const t of hotel.suitableFor) append(tags, el('span', 'tag', t));
        append(card, tags);
      }
      if (hotel.needCheck.length) {
        const ul = el('ul', 'hotel-needcheck');
        for (const n of hotel.needCheck) append(ul, el('li', null, n));
        append(card, ul);
      }
      append(card, el('p', 'verify-line', '房价、评分与可订状态需自行核实。'));
      append(grid, card);
    }
    append(wrap, grid);
  }

  const block = el('div', 'block');
  append(block, el('h3', null, '住宿区域建议'));
  const dl = el('dl', 'fact-row');
  append(dl, el('dt', null, '推荐片区'), el('dd', null, plan.route.hotelArea || '待确认'));
  append(dl, el('dt', null, '选择理由'), el('dd', null, plan.route.logic || '—'));
  append(block, dl);
  append(wrap, block);
}

async function renderRoute() {
  const plan = state.plan;
  const wrap = $('tabRoute');
  wrap.replaceChildren();
  append(wrap, el('p', 'route-note', '路线图由后端根据行程数据生成 SVG 图，不是实时地图，也不代表真实地理距离与比例。'));

  const frame = el('div', 'route-frame');
  frame.append(el('p', 'route-note', '正在生成路线图…'));
  append(wrap, frame);

  const actions = el('div', 'route-actions');
  append(wrap, actions);

  try {
    const res = await fetch('/api/visual/svg', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Huantu-CSRF': state.csrf },
      body: JSON.stringify({ planId: plan.planId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = el('img');
    img.alt = `${plan.overview.title} 路线示意图`;
    img.src = url;
    frame.replaceChildren(img);

    const download = el('a', 'ghost-button', '下载路线图（SVG）');
    download.href = url;
    download.download = `寰途-${plan.input.destination}-路线图.svg`;
    append(actions, download);

    const open = el('a', 'ghost-button', '在新窗口查看');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    append(actions, open);
  } catch (error) {
    frame.replaceChildren(el('p', 'route-note', `路线图生成失败：${error.message}`));
  }

  const dl = el('dl', 'fact-row');
  append(dl, el('dt', null, '每日主题'), el('dd', null, plan.days.map((d) => `${d.label} ${d.theme}`).join(' / ')));
  append(dl, el('dt', null, '住宿位置'), el('dd', null, plan.route.hotelArea || '待确认'));
  append(dl, el('dt', null, '交通顺序'), el('dd', null, '按时间轴顺序串联；节点之间的移动时间见每日行程。'));
  const block = el('div', 'block');
  append(block, el('h3', null, '图示说明'), dl);
  append(wrap, block);
}

/* ---------------- 路线地图（智能规划） ---------------- */

const TM_MODE_ORDER = ['walk', 'metro', 'bus', 'taxi', 'drive'];
const TM_MODE_LABEL = { walk: '步行', metro: '地铁', bus: '公交', taxi: '打车', drive: '驾车' };

/** 等 travel-map.js 把核心模块加载完；本地文件，正常是几十毫秒 */
async function tmReady() {
  if (!window.travelMapReady) return false;
  try {
    await window.travelMapReady;
  } catch (error) {
    console.error('[寰途] 地图核心加载失败', error);
    return false;
  }
  return Boolean(window.TravelMap && window.TravelMapCore);
}

/** 某一天的完整时间轴（含未定位的站点），编辑改动直接读 plan，保证和导出/日历一致 */
function tmTimelineOf(dayNo) {
  const core = window.TravelMapCore;
  const day = state.plan?.days?.find((d) => d.day === dayNo);
  if (!core || !day) return null;
  const items = day.items.map((it, i) => ({
    order: i,
    raw: it,
    title: it.title,
    type: it.type,
    time: it.time,
    dur: it.durationMin,
    transportMin: it.transportMin,
    transportFromPrev: it.transportFromPrev,
    mode: core.transportOf(it.transportFromPrev),
    located: core.isValidCoord(it.geo?.lat, it.geo?.lng),
  }));
  return core.recomputeDayTimeline(items);
}

function tmHint(text) {
  return el('p', 'route-note', text);
}

/** 时间轴的“时长 −15 / +15”“换交通方式”“在地图上定位” */
function tmItemActions(item, day, rerender) {
  const wrap = el('div', 'tm-item__actions');
  const raw = item.raw;

  const shorter = el('button', 'tm-chip', '时长 −15');
  shorter.type = 'button';
  shorter.addEventListener('click', () => {
    raw.durationMin = Math.max(15, (raw.durationMin || 90) - 15);
    rerender();
  });

  const longer = el('button', 'tm-chip', '时长 +15');
  longer.type = 'button';
  longer.addEventListener('click', () => {
    raw.durationMin = Math.min(720, (raw.durationMin || 90) + 15);
    rerender();
  });

  const modeBtn = el('button', 'tm-chip is-on', `交通：${TM_MODE_LABEL[item.mode] || '驾车'}`);
  modeBtn.type = 'button';
  modeBtn.title = '点击切换：步行 → 地铁 → 公交 → 打车 → 驾车';
  modeBtn.addEventListener('click', () => {
    const next = TM_MODE_ORDER[(TM_MODE_ORDER.indexOf(item.mode) + 1) % TM_MODE_ORDER.length];
    raw.transportFromPrev = TM_MODE_LABEL[next];
    rerender();
  });

  append(wrap, shorter, longer, modeBtn);

  if (!item.located) {
    const locate = el('button', 'tm-chip', '在地图上定位');
    locate.type = 'button';
    locate.addEventListener('click', () => {
      const map = state.tm?.map;
      if (!map) {
        notice('地图还没初始化，先点一次「路线地图」标签。', true);
        return;
      }
      notice('请在地图上点一下这个地点的大致位置。');
      map.beginPlacement(({ lat, lng }) => {
        raw.geo = { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, source: 'manual' };
        notice(`已手动定位：${raw.title}`);
        // refresh 会同时刷新地图站点和时间轴；地图还没初始化时退回只刷列表
        if (state.tmRefresh) state.tmRefresh();
        else rerender();
      });
    });
    append(wrap, locate);
  }

  return wrap;
}

/** 渲染右侧时间轴（按天分组，改动即时重算到达时间） */
function tmRenderTimeline(container) {
  const core = window.TravelMapCore;
  container.replaceChildren();
  if (!core || !state.plan) return;

  const rerender = () => tmRenderTimeline(container);

  for (const day of state.plan.days) {
    const tl = tmTimelineOf(day.day);
    const colorClass = `tm-c${((day.day - 1) % 7) + 1}`;

    const block = el('section', `tm-day ${colorClass}`);

    const head = el('div', 'tm-day__head');
    append(head, el('span', 'tm-day__label', `DAY ${day.day} · ${day.weekday}`));
    const totalTransfer = tl ? tl.transportMin : 0;
    const endTime = tl ? tl.end : '—';
    append(head, el('span', 'tm-day__meta',
      `移动 ${totalTransfer} 分 · 收尾 ${endTime}`));
    append(block, head);

    if (!day.items.length) {
      append(block, el('p', 'tm-missing', '这一天还没有具体安排。'));
      append(container, block);
      continue;
    }

    if (!tl) continue;

    tl.items.forEach((item) => {
      const row = el('div', `tm-item${item.located ? '' : ' is-missing'}`);
      const timeBox = el('div', 'tm-item__time');
      append(timeBox, document.createTextNode(item.arrive));
      append(timeBox, el('span', null, `→ ${item.leave}`));
      append(row, timeBox);

      const main = el('div', 'tm-item__main');
      const title = el('h4', 'tm-item__title');
      title.innerHTML = HuantuIcons.svg(item.icon, { size: 16 });
      append(title, document.createTextNode(item.title));
      append(main, title);

      const subText = item.located
        ? `${item.mode ? TM_MODE_LABEL[item.mode] : '—'}${item.transportMin ? ` ${item.transportMin} 分` : ''} · 停留 ${item.dur} 分`
        : `未定位 · 停留 ${item.dur} 分`;
      append(main, el('p', 'tm-item__sub', subText));
      append(main, tmItemActions(item, day, rerender));

      append(row, main);
      append(block, row);
    });

    if (tl.transportMin) {
      append(block, el('p', 'tm-missing', `当天在路上的时间合计 ${tl.transportMin} 分钟。`));
    }
    append(container, block);
  }
}

function tmRenderLegend(container) {
  container.replaceChildren();
  if (!window.TravelMap) return;
  const maxDay = Math.min(TravelMap.DAY_COLORS.length, state.plan?.days?.length || 0);
  for (let i = 0; i < maxDay; i += 1) {
    const item = el('span', 'tm-legend__item');
    const dot = el('span', `tm-legend__dot tm-c${i + 1}`);
    append(item, dot, document.createTextNode(`Day ${i + 1}`));
    append(container, item);
  }
  for (const [mode, label] of Object.entries(TM_MODE_LABEL)) {
    const item = el('span', 'tm-legend__item');
    const dash = el('span', `tm-legend__dash${mode === 'drive' ? ' is-solid' : ''}`);
    append(item, dash, document.createTextNode(label));
    append(container, item);
  }
}

function tmSummary(payload) {
  const { stats } = payload;
  if (!stats.total) return '这份方案里还没有可上地图的站点。';
  const parts = [`已定位 ${stats.located} / ${stats.total} 站`];
  if (stats.missing) parts.push(`${stats.missing} 站缺坐标`);
  if (stats.manual) parts.push(`${stats.manual} 站手动定位`);
  return parts.join(' · ');
}

/** 建面板骨架（不含 Leaflet 初始化，避免在 hidden 容器里算出 0 尺寸） */
function renderMap() {
  const wrap = $('tabMap');
  // 换方案时先卸掉旧地图，避免 Leaflet 实例和它的 DOM 监听一起泄漏
  if (state.tm?.map) {
    try { state.tm.map.destroy(); } catch { /* 容器已被替换，忽略 */ }
  }
  wrap.replaceChildren();
  append(wrap, tmHint('真实底图 + 按天分组的可编辑时间轴。坐标来自模型估计或你手动定位，'
    + '未经地理编码核验；连线是示意弧线，不是真实导航轨迹。'));

  const shell = el('div', 'tm-shell');

  const left = el('div');
  const mapWrap = el('div', 'tm-map-wrap');
  const mapBox = el('div', 'tm-map');
  mapBox.id = 'tmMap';
  append(mapWrap, mapBox);
  append(left, mapWrap);

  const toolbar = el('div', 'tm-toolbar');
  const btnFit = el('button', 'tm-toggle', '全部看全');
  btnFit.type = 'button';
  const btnStyle = el('button', 'tm-toggle', '标准底图');
  btnStyle.type = 'button';
  btnStyle.setAttribute('aria-pressed', 'false');
  const btnScale = el('button', 'tm-toggle', '放大图标');
  btnScale.type = 'button';
  btnScale.setAttribute('aria-pressed', 'false');
  const summary = el('span', 'tm-map-summary route-note', '正在准备地图…');
  append(toolbar, btnFit, btnStyle, btnScale, el('span', 'tm-toolbar__spacer'), summary);
  append(left, toolbar);

  const legend = el('div', 'tm-legend');
  append(left, legend);
  append(shell, left);

  const side = el('aside', 'tm-side');
  const sideHead = el('div', 'tm-side__head');
  append(sideHead, el('p', 'tm-side__title', '每日时间轴'));
  append(sideHead, el('p', 'tm-side__note', '改时长或交通方式后，后面的到达时间会自动重算。'));
  append(side, sideHead);
  const daysBox = el('div', 'tm-days');
  append(side, daysBox);
  append(shell, side);

  append(wrap, shell);
  append(wrap, tmHint('底图需要联网（高德在线瓦片）。内网或断网时地图会自动切到离线示意模式，'
    + '编号、连线与时间轴照常可用。'));

  state.tm = { mapBox, summary, legend, daysBox, btnFit, btnStyle, btnScale, map: null, payload: null };
  tmRenderLegend(legend);
  tmRenderTimeline(daysBox);

  btnFit.addEventListener('click', () => state.tm?.map?.fit());
  btnStyle.addEventListener('click', () => {
    const on = btnStyle.getAttribute('aria-pressed') === 'true';
    const map = state.tm?.map;
    if (!map) return;
    const next = !on;
    map.setTileStyle(next ? 7 : 8);
    btnStyle.setAttribute('aria-pressed', String(next));
    btnStyle.textContent = next ? '浅色底图' : '标准底图';
  });
  btnScale.addEventListener('click', () => {
    const on = btnScale.getAttribute('aria-pressed') === 'true';
    const map = state.tm?.map;
    if (!map) return;
    const next = !on;
    map.setScale(next ? 1.25 : null);
    btnScale.setAttribute('aria-pressed', String(next));
  });
}

/** 标签页切到「路线地图」时才真正初始化 Leaflet */
async function activateMap() {
  if (!state.tm) renderMap();
  const tm = state.tm;
  if (!tm) return;

  if (tm.map) {
    tm.map.invalidate();
    return;
  }

  const ok = await tmReady();
  if (!ok) {
    tm.summary.textContent = '地图组件加载失败：请确认 /vendor/leaflet.js 与 /travel-map-core.mjs 可访问。';
    return;
  }

  try {
    tm.payload = await api('/api/visual/map', { method: 'POST', body: { planId: state.plan.planId } });
  } catch (error) {
    tm.summary.textContent = `地图数据获取失败：${error.message}`;
    return;
  }

  const city = tm.payload.city;
  tm.map = new TravelMap(tm.mapBox, {
    center: city ? [city.lat, city.lng] : undefined,
    zoom: city ? 12 : 11,
    style: 8,
    editable: true,
    autoFit: true,
  });

  tm.map.on('offline', () => {
    tm.summary.textContent = '底图瓦片不可达，已切离线示意模式；站点与时间轴不受影响。';
  });

  // 站点一律从 plan 现算，保证手动定位、改时长后地图与列表同步
  const refresh = () => {
    if (!state.tm?.map || !state.plan) return;
    const { stops } = window.TravelMapCore.planToStops(state.plan);
    state.tm.map.setStops(stops);
    state.tm.summary.textContent = tmSummary({
      stats: {
        total: stops.length,
        located: stops.length,
        missing: (state.plan.days || []).reduce((n, d) => n + d.items.filter(
          (it) => !window.TravelMapCore.isValidCoord(it.geo?.lat, it.geo?.lng)).length, 0),
        manual: stops.filter((s) => s.source === 'manual').length,
      },
    });
    tmRenderTimeline(state.tm.daysBox);
  };

  refresh();
  state.tmRefresh = refresh;
  tm.map.on('stopmoved', ({ stop }) => {
    // 拖动结束：把新坐标写回 plan 里对应的那一条，导出 JSON / ICS 才是同一份数据
    const day = state.plan.days.find((d) => d.day === stop.day);
    const item = day?.items?.[stop.order];
    if (item) {
      item.geo = { lat: Math.round(stop.lat * 1e5) / 1e5, lng: Math.round(stop.lng * 1e5) / 1e5, source: 'manual' };
    }
    refresh();
  });
  setTimeout(() => {
    tm.map.invalidate();
    tm.map.fit();
  }, 60);
}

/* ---------------- 日历 ---------------- */

const CAL_STATE_LABEL = {
  needs_authorization: '尚未授权',
  ics_available: 'ICS 可导入',
  unsupported_direct: '不支持直连',
  available: '可导出',
};

function calendarRow({ name, status, actions }) {
  const row = el('div', 'calendar-row');
  const head = el('div', 'calendar-row-head');
  append(head, el('span', 'calendar-name', name), el('span', 'calendar-state', CAL_STATE_LABEL[status.state] || status.label));
  head.lastChild.dataset.state = status.state;
  append(row, head, el('p', 'calendar-detail', status.detail));
  const box = el('div', 'calendar-actions');
  for (const btn of actions) if (btn) append(box, btn);
  append(row, box);
  return row;
}

function renderCalendar() {
  const plan = state.plan;
  const wrap = $('tabCalendar');
  wrap.replaceChildren();

  const tz = plan.meta.timezone || 'Asia/Shanghai';
  append(wrap, el('p', 'route-note', `当前本机未获得 Google 或 Apple 的写入授权。下面明确区分三种状态：已同步（需要授权）、需要授权、ICS 可导入。寰途不会把「可导入」写成「已同步」。日历时间按 ${tz} 折算，导入后按设备本地时区显示。`));

  const list = el('div', 'calendar-list');
  const status = state.model?.calendar || {
    google: { state: 'needs_authorization', detail: '尚未授权。' },
    apple: { state: 'unsupported_direct', detail: '通过 .ics 导入。' },
    system: { state: 'ics_available', detail: '下载 .ics 后导入。' },
  };

  const icsButton = el('button', 'ghost-button', '下载 .ics 文件');
  icsButton.type = 'button';
  icsButton.onclick = downloadIcs;

  const googleButton = el('button', 'ghost-button', '生成 Google 创建链接');
  googleButton.type = 'button';
  googleButton.onclick = loadGoogleLinks;

  const authButton = el('button', 'ghost-button', '尝试授权直连');
  authButton.type = 'button';
  authButton.onclick = () => connectCalendar('google');

  append(list,
    calendarRow({ name: 'Google Calendar', status: status.google, actions: [googleButton, authButton] }),
    calendarRow({ name: 'Apple Calendar', status: status.apple, actions: [icsButton] }),
    calendarRow({ name: '手机系统日历', status: status.system, actions: [icsButton] }),
  );
  append(wrap, list);

  const linkBlock = el('div', 'block');
  append(linkBlock, el('h3', null, 'Google Calendar 逐条创建'));
  append(linkBlock, el('p', 'route-note', '点击后会在 Google 页面打开预填事件，需要你本人登录并确认保存。寰途不保存任何 Google 账号信息。'));
  const listBox = el('div', 'event-link-list');
  listBox.id = 'eventLinks';
  listBox.append(el('p', 'empty-state', '尚未生成链接。'));
  append(linkBlock, listBox);
  append(wrap, linkBlock);

  const eventsBlock = el('div', 'block');
  append(eventsBlock, el('h3', null, '事件内容预览'));
  append(eventsBlock, el('p', 'route-note', '每个事件的标题、开始与结束时间、地点、交通提示、备注与提醒如下；.ics 内含 30 分钟前提醒。'));
  const preview = el('div', 'event-link-list');
  for (const day of plan.days) {
    for (const item of day.items) {
      if (!item.time) continue;
      const line = el('div', 'event-link');
      append(line, el('span', null, `${day.date} ${item.time}–${item.endTime || ''}`), el('span', null, `${day.label} · ${item.title}`));
      append(preview, line);
    }
  }
  append(eventsBlock, preview);
  append(wrap, eventsBlock);

  const danger = el('div', 'confirm-box');
  append(danger, el('p', 'section-kicker', '删除或修改日历事件'));
  append(danger, el('p', null, '删除日历事件必须由你本人确认，并且只能删除你自己日历中的事件。寰途目前没有写入授权，因此本机不持有任何已同步事件。'));
  const label = el('label');
  const check = el('input');
  check.type = 'checkbox';
  check.id = 'deleteConfirm';
  const span = el('span', null, '我确认上述说明，并理解删除操作需要在我自己的日历应用中完成。');
  append(label, check, span);
  append(danger, label);
  const delBtn = el('button', 'ghost-button', '检查可删除事件');
  delBtn.type = 'button';
  delBtn.onclick = () => requestDelete(check.checked);
  append(danger, delBtn);
  append(wrap, danger);

  const result = el('div');
  result.id = 'calendarMessage';
  append(wrap, result);
}

async function downloadIcs() {
  try {
    const res = await fetch('/api/calendar/ics', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Huantu-CSRF': state.csrf },
      body: JSON.stringify({ planId: state.plan.planId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `寰途-${state.plan.input.destination}-${state.plan.input.startDate}.ics`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notice('已下载 .ics 文件。在手机上打开该文件即可导入系统日历；导入后请核对时区。');
  } catch (error) {
    notice('ICS 下载失败：' + error.message, true);
  }
}

async function loadGoogleLinks() {
  const box = $('eventLinks');
  box.replaceChildren(el('p', 'empty-state', '正在生成链接…'));
  try {
    const data = await api('/api/calendar/google', { method: 'POST', body: { planId: state.plan.planId } });
    box.replaceChildren();
    if (data.trip?.url) {
      const line = el('div', 'event-link');
      const a = el('a', null, '创建整段旅程事件');
      a.href = data.trip.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      append(line, a, el('span', null, data.timezone));
      append(box, line);
    }
    for (const event of data.events) {
      const line = el('div', 'event-link');
      const a = el('a', null, event.title);
      a.href = event.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      append(line, a, el('span', null, `${event.date} ${event.startUtc.slice(11, 16)} UTC`));
      append(box, line);
    }
    notice(data.note || '已生成 Google 创建链接。');
  } catch (error) {
    box.replaceChildren(el('p', 'empty-state', error.message));
  }
}

async function connectCalendar(provider) {
  const box = $('calendarMessage');
  box.replaceChildren();
  try {
    const data = await api('/api/calendar/connect', { method: 'POST', body: { provider } });
    append(box, el('p', 'route-note', `状态：${data.state} · 已连接：${data.connected ? '是' : '否'}。${data.message}`));
  } catch (error) {
    append(box, el('p', 'route-note', `未能连接：${error.message}`));
  }
}

async function requestDelete(confirmed) {
  const box = $('calendarMessage');
  box.replaceChildren();
  if (!confirmed) {
    append(box, el('p', 'route-note', '请先勾选确认说明。没有确认时寰途不会发出任何删除请求。'));
    return;
  }
  try {
    const data = await api('/api/calendar/delete', { method: 'POST', body: { confirm: true, planId: state.plan.planId } });
    append(box, el('p', 'route-note', data.message));
  } catch (error) {
    append(box, el('p', 'route-note', error.message));
  }
}

/* ---------------- 来源 ---------------- */

/* ---- 实时检索明细：每条结果旁边标来源站点 + 站点图标 ---- */

const LIVE_GROUPS = [
  { key: 'attractions', label: '景点票价 / 开放情况', hint: '模型据此填写门票与开放时间，具体数值仍以官网为准' },
  { key: 'hotels', label: '酒店评价', hint: '评价偏低或负面口径的条目已在筛选阶段排除' },
  { key: 'transport', label: '地铁 / 公交公告', hint: '若查到停运或施工，当日行程已改走替代路线' },
];

// 搜索返回的摘要常带 markdown（# 标题、... 省略号），显示前收拾一下
function cleanSnippet(raw) {
  return String(raw)
    .replace(/\r/g, '')
    .replace(/^[\s#>*\-•·]+/gu, '')
    .replace(/#{1,6}\s*/g, '')          // 搜索结果里残留的 markdown 标题号
    .replace(/\s*-{3,}\s*/g, ' ')       // 表格分隔线
    .replace(/\s*\|\s*/g, ' · ')        // 表格竖线换成间隔点，读起来才像话
    .replace(/\.\s*\.\s*\./g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function siteInitial(hit) {
  const raw = String(hit.site || '').trim();
  if (raw) return raw.replace(/^www\./i, '').charAt(0).toUpperCase();
  try {
    return new URL(hit.url).hostname.replace(/^www\./i, '').charAt(0).toUpperCase();
  } catch {
    return '?';
  }
}

function hitIconEl(hit) {
  const box = el('span', 'hit-icon');
  box.textContent = siteInitial(hit); // 图标没加载出来时留首字母
  box.setAttribute('aria-hidden', 'true');
  if (!hit.icon) return box;
  const img = document.createElement('img');
  img.src = hit.icon;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => box.classList.add('has-img'));
  img.addEventListener('error', () => img.remove()); // 加载失败就留着首字母
  box.append(img);
  return box;
}

function renderLiveHits(wrap) {
  const live = state.plan && state.plan._live;
  if (!live) return;
  const groups = LIVE_GROUPS
    .map((g) => ({ ...g, rows: (live[g.key] || []).flatMap((grp) => grp.results || []) }))
    .filter((g) => g.rows.length);
  if (!groups.length) return;

  const block = el('div', 'block');
  append(block, el('h3', null, '实时检索到的原始条目'));
  append(block, el('p', 'route-note', '每条左侧是来源站点图标与站名，点标题可打开原网页。时效信息以官方页面为准。'));

  for (const g of groups) {
    const sub = el('div', 'hit-group');
    append(sub, el('h4', 'hit-group-title', g.label));
    const ul = el('ul', 'hit-list');
    const seen = new Set();
    for (const hit of g.rows) {
      if (!hit || !hit.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      const li = el('li', 'hit-item');
      append(li, hitIconEl(hit));
      const body = el('div', 'hit-body');
      const a = el('a', 'hit-title', hit.title || hit.url);
      a.href = hit.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      append(body, a);
      if (hit.site) append(body, el('span', 'hit-site', hit.site));
      if (hit.snippet) {
        const s = cleanSnippet(hit.snippet);
        if (s) append(body, el('p', 'hit-snippet', s.length > 110 ? `${s.slice(0, 110)}…` : s));
      }
      append(li, body);
      append(ul, li);
    }
    append(sub, ul);
    if (g.hint) append(sub, el('p', 'hit-hint', g.hint));
    append(block, sub);
  }
  append(wrap, block);
}

function renderSources() {
  const plan = state.plan;
  const wrap = $('tabSources');
  wrap.replaceChildren();

  append(wrap, el('p', 'route-note', '下表列出本次方案的信息来源与时间。凡是「未核验」的内容，都不应作为预订或行程决策的唯一依据。'));

  renderLiveHits(wrap);

  const table = el('table', 'source-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['来源', '类型', '状态', '记录时间', '说明']) append(hr, el('th', null, h));
  append(thead, hr);
  const tbody = el('tbody');
  for (const src of plan.sources) {
    const tr = el('tr');
    const statusText = { static: '静态整理', unverified: '未核验', not_connected: '未接入', partial: '部分接入', checked: '已核验', connected: '已接入' }[src.status] || src.status;
    const badge = el('span', 'src-status', statusText);
    badge.dataset.status = src.status;
    append(tr,
      el('td', null, src.label),
      el('td', null, { local: '本地知识库', model: '模型生成', adapter: '待接入接口', search: '实时搜索', weather: '实时天气', hotel: '实时酒店', transport: '实时交通', attraction: '实时景点' }[src.type] || src.type),
      (() => { const td = el('td'); td.append(badge); return td; })(),
      el('td', null, src.retrievedAt ? fmtDateTime(src.retrievedAt) : '待核实'),
      el('td', null, src.note || ''),
    );
    append(tbody, tr);
  }
  append(table, thead, tbody);
  append(wrap, table);

  const block = el('div', 'block');
  const dl = el('dl', 'fact-row');
  append(dl, el('dt', null, '方案生成'), el('dd', null, fmtDateTime(plan.meta.generatedAt)));
  append(dl, el('dt', null, '模型'), el('dd', null, `${plan.meta.model || '未记录'} · ${plan.meta.protocol || ''}`));
  append(dl, el('dt', null, '行程编号'), el('dd', null, plan.planId));
  append(dl, el('dt', null, '时区'), el('dd', null, `${plan.meta.timezone}（日历时间为浮动本地时间，导入后按设备时区显示）`));
    const types = new Set((plan.sources || []).map((s) => s.type));
    const pending = [];
    if (!types.has('weather')) pending.push('实时天气');
    if (!types.has('attraction')) pending.push('景点票价');
    if (!types.has('hotel')) pending.push('酒店评价');
    if (!types.has('transport')) pending.push('交通公告');
    pending.push('地图', '酒店实时库存', '班次余票');
    append(dl, el('dt', null, '未接入接口'), el('dd', null, pending.join(' · ') + ' · Google/Apple OAuth'));
  append(block, el('h3', null, '本次方案元信息'), dl);
  append(wrap, block);
}

/* ---------------- 知识库 ---------------- */

const LIB_KIND_LABEL = { search: '整类搜索', spot: '景点票价', photo: '地点配图', digest: '确认事实' };
const LIB_STATE = {
  fresh: ['新鲜', 'is-fresh'],
  stale: ['待更新', 'is-stale'],
  expired: ['已过期', 'is-expired'],
};

function libStateBadge(name) {
  const [label, cls] = LIB_STATE[name] || ['未知', 'is-stale'];
  return el('span', `lib-badge ${cls}`, label);
}

/** 本次生成的知识库使用账本：不请求接口，直接用 plan 里带回来的数。 */
function renderLibraryUsage(wrap) {
  const lib = state.plan && state.plan.library;
  if (!state.plan) return;
  const block = el('div', 'block');
  append(block, el('h3', null, '这次生成用了多少知识库'));

  if (!lib) {
    append(block, el('p', 'route-note', '这份行程生成时还没有知识库记录，或知识库被关闭了。'));
    return append(wrap, block);
  }
  if (lib.enabled === false) {
    append(block, el('p', 'route-note', '知识库未启用。开启后，搜到的票价、评价和图片会留在本地，下次直接复用，不再重复联网。'));
    return append(wrap, block);
  }
  if (lib.reused) {
    append(block, el('p', 'route-note', '这次沿用了上一版的研究结论，没有重新检索。'));
    return append(wrap, block);
  }

  const grid = el('div', 'lib-stats');
  const cell = (n, label, cls) => {
    const d = el('div', `lib-stat ${cls || ''}`);
    append(d, el('strong', null, String(n ?? 0)), el('span', null, label));
    return d;
  };
  append(grid,
    cell(lib.hits, '条命中知识库', 'is-hit'),
    cell(lib.savedFetches, '次联网检索被省下', 'is-hit'),
    cell(lib.misses, '条这次新搜并入库'),
    cell(lib.stale, '条已过期，下次重搜', lib.stale ? 'is-warn' : ''),
  );
  append(block, grid);

  const items = (lib.items || []).filter((it, i, arr) =>
    arr.findIndex((x) => x.kind === it.kind && x.label === it.label) === i);
  if (items.length) {
    const ul = el('ul', 'lib-hit-list');
    for (const it of items) {
      const li = el('li');
      append(li,
        el('span', 'lib-kind', LIB_KIND_LABEL[it.kind] || it.kind),
        el('span', 'lib-key', it.label),
        libStateBadge(it.state),
        el('span', 'lib-age', it.ageDays === 0 ? '今天抓的' : `${it.ageDays} 天前`),
      );
      append(ul, li);
    }
    append(block, ul);
  } else if (!lib.hits) {
    append(block, el('p', 'route-note', '这次全部现搜，没有可复用的旧记录——搜到的内容已经存进下面这张表，下次同城同问就快了。'));
  }
  append(wrap, block);
}

function paintCityItems(items, bodyEl) {
  bodyEl.replaceChildren();
  if (!items.length) {
    append(bodyEl, el('p', 'route-note', '这座城市还没有记录。'));
    return;
  }
  const table = el('table', 'source-table lib-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['类型', '关键词', '状态', '抓取时间', '被用过', '操作']) append(hr, el('th', null, h));
  append(thead, hr);
  const tbody = el('tbody');
  for (const it of items) {
    const tr = el('tr');
    const timeCell = el('td', null, it.ageDays === 0 ? '今天' : `${it.ageDays} 天前`);
    timeCell.title = fmtDateTime(it.updatedAt);
    const actionCell = el('td', 'lib-actions');

    const refresh = el('button', 'link-button', '标废重搜');
    refresh.type = 'button';
    refresh.title = '下次生成时重新检索这一条（现在不联网）';
    refresh.addEventListener('click', () => libraryAction('refresh', it, bodyEl));

    const del = el('button', 'link-button is-danger', '删除');
    del.type = 'button';
    del.addEventListener('click', () => libraryAction('delete', it, bodyEl));

    append(actionCell, refresh, del);
    append(tr,
      el('td', null, LIB_KIND_LABEL[it.kind] || it.kind),
      (() => {
        const td = el('td');
        append(td, el('div', 'lib-key-cell', it.key));
        if (it.preview) append(td, el('div', 'lib-preview', it.preview.length > 90 ? `${it.preview.slice(0, 90)}…` : it.preview));
        return td;
      })(),
      (() => { const td = el('td'); td.append(libStateBadge(it.state)); return td; })(),
      timeCell,
      el('td', null, it.hits ? `${it.hits} 次` : '—'),
      actionCell,
    );
    append(tbody, tr);
  }
  append(table, thead, tbody);
  append(bodyEl, table);
}

async function libraryAction(action, item, bodyEl) {
  const label = action === 'refresh' ? '已标记为待重搜，下次生成这条会重新联网。' : '已从知识库删除。';
  try {
    if (action === 'refresh') {
      await api('/api/library/refresh', { method: 'POST', body: { city: item.city, kind: item.kind, key: item.key } });
    } else {
      await api('/api/library/item', { method: 'DELETE', body: { city: item.city, kind: item.kind, key: item.key } });
    }
    notice(label);
    state.libraryCities.delete(item.city);
    state.libraryAt = 0;
    await renderLibrary();
  } catch (err) {
    notice(err.message, true);
  }
}

async function loadCityItems(city, bodyEl) {
  const open = bodyEl.hidden;
  bodyEl.hidden = !open;
  if (!open) return;
  if (state.libraryCities.has(city)) {
    paintCityItems(state.libraryCities.get(city), bodyEl);
    return;
  }
  bodyEl.replaceChildren(el('p', 'route-note', '正在读取…'));
  try {
    const data = await api(`/api/library?city=${encodeURIComponent(city)}`);
    state.libraryCities.set(city, data.items || []);
    paintCityItems(data.items || [], bodyEl);
  } catch (err) {
    bodyEl.replaceChildren(el('p', 'route-note', err.message));
  }
}

function paintLibraryCities(block, data) {
  const s = data.summary || {};
  append(block, el('p', 'route-note',
    `共 ${s.cities ?? 0} 座城市 / ${s.entries ?? 0} 条记录：新鲜 ${s.fresh ?? 0}、待更新 ${s.stale ?? 0}、已过期 ${s.expired ?? 0}。`
    + `搜索一次就会留下，下次同城同问直接复用；过期的会在下次生成时自动重搜并覆盖。`));

  if (!data.cities || !data.cities.length) {
    append(block, el('p', 'route-note', '还没有任何记录。生成一次行程后就会自动出现。'));
    return;
  }

  const autoCity = (() => {
    const m = /^#result:library\/(.+)$/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1]) : '';
  })();
  for (const c of data.cities) {
    const card = el('div', 'lib-city');
    const head = el('div', 'lib-city-head');

    const nameBtn = el('button', 'lib-city-name', `${c.city} · ${c.total} 条`);
    nameBtn.type = 'button';
    nameBtn.setAttribute('aria-expanded', 'false');

    const meta = el('span', 'lib-city-meta',
      `最后更新 ${c.updatedAt ? fmtDateTime(c.updatedAt) : '—'} · 新鲜 ${c.fresh} / 待更新 ${c.stale} / 过期 ${c.expired}`);

    const all = el('button', 'link-button', '整城重搜');
    all.type = 'button';
    all.title = '把这城的记录全部标记为过期，下次生成时重新检索';
    all.addEventListener('click', async () => {
      try {
        const r = await api('/api/library/refresh', { method: 'POST', body: { city: c.city } });
        notice(`已把 ${c.city} 的 ${r.expired} 条记录标记为待重搜。`);
        state.libraryCities.delete(c.city);
        state.libraryAt = 0;
        await renderLibrary();
      } catch (err) {
        notice(err.message, true);
      }
    });

    const bodyEl = el('div', 'lib-city-body');
    bodyEl.hidden = true;
    nameBtn.addEventListener('click', () => {
      nameBtn.setAttribute('aria-expanded', String(bodyEl.hidden));
      loadCityItems(c.city, bodyEl);
    });

    append(head, nameBtn, meta, all);
    append(card, head, bodyEl);
    append(block, card);

    // 支持 #result:library/杭州 直达某城的条目列表
    if (autoCity && c.city === autoCity) {
      nameBtn.setAttribute('aria-expanded', 'true');
      loadCityItems(c.city, bodyEl);
    }
  }
}

async function renderLibrary({ force = false } = {}) {
  const wrap = $('tabLibrary');
  if (!wrap) return;
  wrap.replaceChildren();
  renderLibraryUsage(wrap);

  const block = el('div', 'block');
  append(block, el('h3', null, '已沉淀的知识'));
  const status = el('p', 'route-note', '正在读取知识库…');
  append(block, status);
  append(wrap, block);

  if (!force && state.library && Date.now() - state.libraryAt < 20000) {
    status.remove();
    paintLibraryCities(block, state.library);
    return;
  }
  try {
    const data = await api('/api/library');
    state.library = data;
    state.libraryAt = Date.now();
    state.libraryCities.clear();
    status.remove();
    paintLibraryCities(block, data);
  } catch (err) {
    status.textContent = `知识库读取失败：${err.message}`;
  }
}

/* ---------------- 标签页 ---------------- */

document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  const name = tab.dataset.tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  const kicker = document.getElementById('resultKicker');
  if (kicker) kicker.textContent = tab.textContent;
  // 地图在容器可见后才初始化，否则 Leaflet 会按 0 尺寸算画布
  if (name === 'map') activateMap();
  // 知识库要读接口，切过去时才加载，避免每次生成都多打一次
  if (name === 'library') renderLibrary();
});

/* ---------------- 重新规划 ---------------- */

$('replanChips').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  $('replanText').value = chip.dataset.change;
  $('replanText').focus();
});

$('replanForm').onsubmit = async (event) => {
  event.preventDefault();
  if (state.busy || !state.plan) return;
  const change = $('replanText').value.trim();
  if (!change) {
    notice('请说明要如何调整行程。', true);
    return;
  }
  const lockedDays = state.plan.days.filter((d) => d.locked).map((d) => d.day);
  const lockedItems = [];
  for (const day of state.plan.days) {
    for (const item of day.items) if (item.locked) lockedItems.push(`${day.day}-${item.index}`);
  }
  notice('');
  try {
    await createJob({ planId: state.plan.planId, change, lockedDays, lockedItems });
    $('replanText').value = '';
    notice('重新规划已转入后台，完成后会自动展示新的每日行程。已锁定的安排会被保留。');
  } catch (error) {
    setBusy(false);
    notice('无法创建重新规划任务：' + error.message, true);
  }
};

$('cancelJob').onclick = async () => {
  if (!activeJobId) return;
  $('cancelJob').disabled = true;
  try {
    const { job } = await api(`/api/jobs/${activeJobId}/cancel`, { method: 'POST', body: {} });
    notice(job.status === 'cancelled' ? '任务已取消。' : '已请求取消，正在中止模型请求…');
  } catch (error) {
    notice('取消失败：' + error.message, true);
  } finally {
    $('cancelJob').disabled = false;
  }
};

$('printPlan').onclick = () => {
  notice('打印对话框会包含全部行程分区；在打印目标中选择「另存为 PDF」即可保存。');
  window.print();
};

$('exportPlan').onclick = async () => {
  if (!state.plan) return;
  try {
    const data = await api('/api/plan/export', { method: 'POST', body: { planId: state.plan.planId } });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `寰途-${state.plan.input.destination}-${state.plan.input.startDate}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notice('已导出 JSON。文件中的时效字段仍标为待核实，不含任何密钥信息。');
  } catch (error) {
    notice('导出失败：' + error.message, true);
  }
};

$('editRequest').onclick = () => {
  $('formSection').hidden = false;
  $('formSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('destination').focus();
};

$('clearPlan').onclick = () => {
  confirmAction(
    '清除旅行记录',
    '将清空本次会话中保存的所有行程方案（仅在本机进程内存中）。已下载的 .ics 文件和你自己日历中的事件不受影响。',
    async () => {
      await api('/api/plan', { method: 'DELETE' });
      state.plan = null;
      $('result').hidden = true;
      $('formSection').hidden = false;
      notice('已清除本会话的旅行记录。');
      await refreshState().catch(() => {});
    },
  );
};

/* ---------------- 确认弹窗 ---------------- */

let confirmHandler = null;
function confirmAction(title, body, handler) {
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  confirmHandler = handler;
  $('confirmDialog').showModal();
}
$('confirmCancel').onclick = () => {
  confirmHandler = null;
  $('confirmDialog').close();
};
$('confirmOk').onclick = async () => {
  const handler = confirmHandler;
  confirmHandler = null;
  $('confirmDialog').close();
  if (!handler) return;
  try {
    await handler();
  } catch (error) {
    notice(error.message, true);
  }
};

/* ---------------- 启动 ---------------- */

async function boot({ skipGateCheck = false, publicMode = null } = {}) {
  if (!skipGateCheck) {
    // /api/public 不需要授权，用来判断是「本机模式」还是「公开模式要访问码」
    const info = await api('/api/public');
    state.csrf = info.csrf || state.csrf;
    state.public = Boolean(info.public);
    state.noCode = Boolean(info.noCode);
    state.authorized = Boolean(info.authorized);
    if (state.public && !state.authorized) {
      showGate();
      return;
    }
    if (state.public) {
      hideGate();
      applyPublicUi();
    }
  }
  if (publicMode !== null) state.public = publicMode;
  if (state.public) {
    hideGate();
    applyPublicUi();
  }

  const s = await refreshState();
  const { plan } = await api('/api/plan/latest');
  if (plan) showPlan(plan);
  // 刷新页面或从别处回来时，如果后台还有任务在跑，继续轮询
  if (s?.jobs?.active) {
    setBusy(true);
    showProgress(s.jobs.active);
    pollJob(s.jobs.active.id);
  }
}

boot().catch((error) => {
  if (error?.status === 401) return; // 已切到访问码页面
  notice('无法连接本机服务：' + error.message, true);
  $('modelStatus').textContent = '无法连接本机服务';
  $('modelStatus').dataset.state = 'offline';
});
