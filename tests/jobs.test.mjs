import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server.mjs';
import { createQueue, createRedisQueue } from '../queue.mjs';

// 测试必须离线可跑：关掉实时天气与联网搜索，避免任何外部请求影响断言与耗时。
process.env.HUANTU_WEATHER = 'off';
process.env.HUANTU_SEARCH_PROVIDER = 'off';
// 地理编码会发外网请求，单测里一律关掉，坐标逻辑另有 tests/geo.test.mjs 用假 fetch 覆盖
process.env.HUANTU_GEOCODE = 'off';


const SECRET = 'jobs-secret-placeholder';

function samplePlan(days = 2) {
  return {
    overview: {
      title: '杭州 · 两日',
      summary: '以西湖西线为主，节奏适中。',
      highlights: ['住在湖滨'],
      paceNote: '每天留一段自由时间。',
      bestFor: '首次到访',
    },
    insights: {
      attractions: [{
        name: '断桥', area: '北山街', why: '清晨人少。', type: '景点',
        suggestedDuration: '60 分钟', bestTime: '清晨', openingHours: '待核实', ticket: '免费',
        crowd: '', suitableFor: ['情侣'], booking: '', backup: '改博物馆',
      }],
      hiddenGems: [], activities: [], food: [], cafes: [], transport: [],
      season: { summary: '秋末偏凉。', tips: ['带外套'], weather: '待核实' },
      suitability: { family: '', couples: '', seniors: '', solo: '' },
    },
    hotels: [{ name: '湖滨示例酒店', area: '湖滨', priceRange: '待核实', rating: '待核实', reason: '近湖。', needCheck: ['房价'] }],
    days: Array.from({ length: days }, (_, i) => ({
      theme: `第 ${i + 1} 天`,
      area: '西湖',
      items: [
        { time: '09:00', title: '断桥', type: '景点', durationMin: 60, detail: '沿堤慢走。', transportFromPrev: '从住宿步行', transportMin: 10, backup: '雨天改博物馆' },
        { time: '14:00', title: '自由时间', type: '自由', durationMin: 90, detail: '喝茶。', transportFromPrev: '步行', transportMin: 5 },
      ],
      meals: { breakfast: '酒店', lunch: '湖滨小馆', dinner: '自由' },
      rest: '午后休息。', freeTime: '17:00 后自由。', backupPlan: '全室内动线。', notes: '',
    })),
    route: { hotelArea: '湖滨', logic: '以湖滨为圆心。', notes: '' },
    confidence: { level: '中', missing: [] },
    warnings: [],
    sources: [{ label: '通用常识', type: 'model', note: '' }],
  };
}

const trip = {
  origin: '广州', destination: '杭州', startDate: '2026-11-05', days: 2, travelers: 2,
  budget: '两人 6000 元', interests: ['博物馆'], pace: 'balanced', transport: 'public',
  hotel: 'comfort', special: '',
};

async function startUpstream() {
  const calls = [];
  const state = { status: 200, delay: { research: 0, itinerary: 0 }, failOn: null, plan: samplePlan(2) };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    // 两条规则都在两段提示里出现，只能看最后一条用户消息判断阶段
    const contents = (body.messages || body.input || []).map((m) => m.content || '');
    const lastContent = contents[contents.length - 1] || '';
    const stage = lastContent.includes('阶段二') ? 'itinerary' : 'research';
    const isResearch = stage === 'research';
    calls.push({ url: req.url, at: Date.now(), stage, auth: req.headers.authorization });

    const delay = isResearch ? state.delay.research : state.delay.itinerary;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    // 客户端取消后 socket 会关闭，这里写完即忽略错误
    if (state.failOn === (isResearch ? 'research' : 'itinerary') || state.status !== 200) {
      res.writeHead(state.status === 200 ? 500 : state.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'upstream failure ' + SECRET }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const text = JSON.stringify(state.plan);
    if (req.url === '/v1/responses') {
      return res.end(JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      }));
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
  }).on('clientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, state, port: server.address().port };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'huantu-jobs-'));
  const upstream = await startUpstream();
  const logs = [];
  const app = await createApp({
    dataDir: dir,
    allowLocalUpstream: true,
    planWaitMs: 400,
    queue: createQueue({ driver: 'memory' }),
    logger: { error: (...args) => logs.push(args.map(String).join(' ')) },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  let csrf = '';

  async function req(route, method = 'GET', body, extra = {}) {
    const res = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, 'X-Huantu-CSRF': csrf, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let value;
    try { value = JSON.parse(text); } catch { value = { raw: text }; }
    if (value.csrf) csrf = value.csrf;
    return { status: res.status, value, text, headers: res.headers };
  }

  async function pollUntil(jobId, predicate, timeoutMs = 12000) {
    const seen = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await req(`/api/jobs/${jobId}`);
      seen.push(r.value.job.status);
      if (predicate(r.value.job)) return { job: r.value.job, seen };
      await sleep(80);
    }
    return { job: null, seen };
  }

  // 先取一次状态，拿到会话 cookie 与 CSRF
  await req('/api/state');

  return {
    app, upstream, base, req, pollUntil, dir, logs,
    async close() {
      await Promise.all([
        new Promise((resolve) => app.close(resolve)),
        new Promise((resolve) => upstream.server.close(resolve)),
      ]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('寰途异步任务：创建、阶段轮询、完成、失败、取消、密钥', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());

  await ctx.req('/api/config', 'POST', {
    baseUrl: `http://127.0.0.1:${ctx.upstream.port}/v1`,
    model: 'job-model',
    apiKey: SECRET,
    protocol: 'chat-completions',
  });

  await t.test('创建任务立即返回 jobId，不等模型', async () => {
    ctx.upstream.state.delay.research = 400;
    ctx.upstream.state.delay.itinerary = 400;
    const started = Date.now();
    const r = await ctx.req('/api/jobs', 'POST', { trip });
    const cost = Date.now() - started;
    assert.equal(r.status, 202);
    assert.match(r.value.jobId, /^[a-f0-9]{12}$/);
    assert.ok(['pending', 'researching'].includes(r.value.job.status));
    assert.equal(r.value.job.hasResult, false);
    assert.equal(r.value.job.mode, 'initial');
    assert.ok(cost < 300, `创建任务应立即返回，实际耗时 ${cost}ms`);
    assert.equal(r.value.links.self, `/api/jobs/${r.value.jobId}`);

    const { job } = await ctx.pollUntil(r.value.jobId, (j) => j.status === 'completed');
    assert.equal(job.status, 'completed');
  });

  await t.test('状态轮询能看到 researching → planning → completed', async () => {
    ctx.upstream.state.delay.research = 500;
    ctx.upstream.state.delay.itinerary = 500;
    const created = await ctx.req('/api/jobs', 'POST', { trip });
    const jobId = created.value.jobId;

    const { job, seen } = await ctx.pollUntil(jobId, (j) => j.status === 'completed');
    assert.equal(job.status, 'completed');
    assert.ok(seen.includes('researching'), '应观察到 researching，实际：' + seen.join(','));
    assert.ok(seen.includes('planning'), '应观察到 planning，实际：' + seen.join(','));
    assert.ok(seen.indexOf('researching') <= seen.indexOf('planning'), '阶段顺序应为 研究 → 行程');
    assert.equal(job.stageLabel, '已完成');
    assert.ok(job.timing.researchMs >= 400);
    assert.ok(job.timing.itineraryMs >= 400);
    assert.equal(job.research.model, 'job-model');
    assert.ok(job.research.attractions >= 1);
  });

  await t.test('完成后 /result 返回可渲染方案，且时效字段仍为待核实', async () => {
    ctx.upstream.state.delay.research = 0;
    ctx.upstream.state.delay.itinerary = 0;
    const created = await ctx.req('/api/jobs', 'POST', { trip });
    const { job } = await ctx.pollUntil(created.value.jobId, (j) => j.status === 'completed');

    const r = await ctx.req(`/api/jobs/${created.value.jobId}/result`);
    assert.equal(r.status, 200);
    assert.equal(r.value.plan.planId, job.planId);
    assert.equal(r.value.plan.days.length, 2);
    assert.equal(r.value.plan.days[0].items.length, 2);
    assert.ok(r.value.plan.days.every((d) => d.items.every((i) => i.verify.checkedAt === null)));
    assert.equal((await ctx.req(`/api/jobs/${created.value.jobId}`)).value.job.hasResult, true);
  });

  await t.test('研究阶段失败：任务 failed、错误真实、没有方案', async () => {
    ctx.upstream.state.failOn = 'research';
    const created = await ctx.req('/api/jobs', 'POST', { trip });
    const { job, seen } = await ctx.pollUntil(created.value.jobId, (j) => ['failed', 'completed'].includes(j.status));
    assert.equal(job.status, 'failed');
    assert.equal(job.stageLabel, '生成失败');
    assert.match(job.error.message, /500/);
    assert.equal(job.hasResult, false);
    assert.ok(!seen.includes('planning'), '研究失败不应进入行程阶段');

    const result = await ctx.req(`/api/jobs/${created.value.jobId}/result`);
    assert.equal(result.status, 409);
    assert.match(result.value.error, /500/);
    ctx.upstream.state.failOn = null;
  });

  await t.test('行程阶段失败：研究已保存，任务仍 failed', async () => {
    ctx.upstream.state.failOn = 'itinerary';
    const created = await ctx.req('/api/jobs', 'POST', { trip });
    const { job } = await ctx.pollUntil(created.value.jobId, (j) => ['failed', 'completed'].includes(j.status));
    assert.equal(job.status, 'failed');
    assert.match(job.error.message, /500/);
    const result = await ctx.req(`/api/jobs/${created.value.jobId}/result`);
    assert.equal(result.status, 409);
    assert.equal(result.value.plan, undefined);
    ctx.upstream.state.failOn = null;
  });

  await t.test('取消任务：状态 cancelled，上游请求被中止，结果不可取', async () => {
    ctx.upstream.state.delay.research = 5000;
    const created = await ctx.req('/api/jobs', 'POST', { trip });
    const jobId = created.value.jobId;
    await sleep(400);

    const before = ctx.upstream.calls.length;
    const cancel = await ctx.req(`/api/jobs/${jobId}/cancel`, 'POST', {});
    assert.equal(cancel.status, 200);
    assert.match(cancel.value.message, /取消/);

    const { job } = await ctx.pollUntil(jobId, (j) => ['cancelled', 'failed', 'completed'].includes(j.status), 4000);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.hasResult, false);
    assert.equal(job.cancellable, false);

    await sleep(300);
    assert.equal(ctx.upstream.calls.length, before, '取消后不应再发起新的模型请求');

    const result = await ctx.req(`/api/jobs/${jobId}/result`);
    assert.equal(result.status, 409);
    assert.match(result.value.error, /取消/);
    ctx.upstream.state.delay.research = 0;
  });

  await t.test('同一会话同时只允许一个任务', async () => {
    ctx.upstream.state.delay.research = 600;
    const first = await ctx.req('/api/jobs', 'POST', { trip });
    assert.equal(first.status, 202);
    const second = await ctx.req('/api/jobs', 'POST', { trip });
    assert.equal(second.status, 409);
    assert.match(second.value.error, /在生成中/);
    await ctx.req(`/api/jobs/${first.value.jobId}/cancel`, 'POST', {});
    await ctx.pollUntil(first.value.jobId, (j) => j.status === 'cancelled', 4000);
    ctx.upstream.state.delay.research = 0;
  });

  await t.test('兼容接口 /api/plan 超过等待时间返回 202 + jobId', async () => {
    ctx.upstream.state.delay.research = 900;
    const r = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(r.status, 202);
    assert.match(r.value.jobId, /^[a-f0-9]{12}$/);
    assert.match(r.value.message, /轮询/);

    const { job } = await ctx.pollUntil(r.value.jobId, (j) => j.status === 'completed');
    assert.equal(job.status, 'completed');
    ctx.upstream.state.delay.research = 0;
  });

  await t.test('兼容接口快任务仍同步返回 200（旧调用方不受影响）', async () => {
    const r = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(r.status, 200);
    assert.equal(r.value.plan.days.length, 2);
    assert.equal(r.value.job.status, 'completed');
  });

  await t.test('任务列表与状态不泄露密钥，日志也不含密钥', async () => {
    const list = await ctx.req('/api/jobs');
    assert.equal(list.status, 200);
    assert.equal(list.value.queue, 'memory');
    assert.ok(list.value.jobs.length >= 1);
    assert.equal(JSON.stringify(list.value).includes(SECRET), false);
    assert.equal(list.text.includes(SECRET), false);

    // 逐个任务的状态与结果也不能带密钥
    for (const job of list.value.jobs.slice(0, 5)) {
      const one = await ctx.req(`/api/jobs/${job.id}`);
      assert.equal(one.text.includes(SECRET), false);
      const result = await ctx.req(`/api/jobs/${job.id}/result`);
      assert.equal(result.text.includes(SECRET), false);
    }
    assert.equal(ctx.logs.join('\n').includes(SECRET), false);
  });

  await t.test('任务按会话隔离：别的浏览器拿不到任务', async () => {
    const list = await ctx.req('/api/jobs');
    const jobId = list.value.jobs[0].id;
    const foreign = await fetch(`${ctx.base}/api/jobs/${jobId}`);
    assert.equal(foreign.status, 404);
    const foreignResult = await fetch(`${ctx.base}/api/jobs/${jobId}/result`);
    assert.equal(foreignResult.status, 404);
  });

  await t.test('不存在的任务与非法 id 都返回 404', async () => {
    assert.equal((await ctx.req('/api/jobs/aaaaaaaaaaaa')).status, 404);
    assert.equal((await ctx.req('/api/jobs/not-a-job')).status, 404);
  });
});

test('队列适配器：内存可用、Redis 明确未实现', () => {
  const memory = createQueue({ driver: 'memory' });
  const job = memory.create({ id: 'a1b2c3d4e5f6', sessionId: 's1', status: 'pending', createdAt: new Date().toISOString() });
  assert.equal(job.id, 'a1b2c3d4e5f6');
  memory.update(job.id, { status: 'researching' });
  assert.equal(memory.get(job.id).status, 'researching', '更新应对执行器可见（同一引用）');
  assert.equal(memory.listBySession('s1').length, 1);
  memory.delete(job.id);
  assert.equal(memory.get(job.id), null);

  const redis = createRedisQueue({ url: 'redis://127.0.0.1:6379' });
  assert.equal(redis.kind, 'redis');
  assert.throws(() => redis.create({}), /Redis 队列尚未实现/);
  assert.throws(() => createQueue({ driver: 'kafka' }), /不支持的队列类型/);
});
