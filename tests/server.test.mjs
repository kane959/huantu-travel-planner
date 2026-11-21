import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createApp,
  buildIcs,
  buildGoogleLinks,
  buildRouteSvg,
  normalizePlan,
  validateTripInput,
  zonedTimeToUtc,
  mergeConfirmed,
} from '../server.mjs';

// 测试必须离线可跑：关掉实时天气与联网搜索，避免任何外部请求影响断言与耗时。
process.env.HUANTU_WEATHER = 'off';
process.env.HUANTU_SEARCH_PROVIDER = 'off';
// 地理编码会发外网请求，单测里一律关掉，坐标逻辑另有 tests/geo.test.mjs 用假 fetch 覆盖
process.env.HUANTU_GEOCODE = 'off';


const SECRET = 'test-secret-placeholder';

function samplePlanJson(days = 3) {
  return {
    overview: {
      title: '杭州 · 湖山三日',
      summary: '以西湖西线为骨架，穿插茶山与老城，节奏适中。',
      highlights: ['住在湖滨，步行可达北山街', '茶山安排在上午，避开午后阵雨'],
      paceNote: '每天保留一段自由时间。',
      bestFor: '首次到访、偏好步行与茶馆的两位成人',
    },
    insights: {
      attractions: [{
        name: '断桥与白堤',
        area: '北山街',
        why: '清晨人少，可沿白堤走到孤山。',
        type: '景点',
        suggestedDuration: '90 分钟',
        bestTime: '清晨',
        openingHours: '9:00–17:00（2026-10-29 08:12 查询）',
        ticket: '免费',
        crowd: '上午十点后明显增多',
        suitableFor: ['情侣', '独自'],
        booking: '无需预约',
        backup: '雨天改为浙江省博物馆孤山馆区',
      }],
      hiddenGems: [{ name: '茅家埠', area: '西湖西线', why: '游客少，水岸安静。', note: '公交班次少，建议打车' }],
      activities: [{ name: '龙井村采茶体验', area: '龙井村', why: '可了解炒茶工艺。', duration: '2 小时', booking: '需提前联系茶农' }],
      food: [{ name: '片儿川', type: '面食', area: '湖滨', why: '本地早点，出餐快。', priceRange: '待核实' }],
      cafes: [{ name: '湖边某咖啡馆', area: '北山街', why: '临湖座位，适合休息。' }],
      transport: [{ mode: '地铁 + 步行', detail: '湖滨一带地铁接驳方便，景区内部以步行为主。', cost: '待核实', note: '节假日有交通管制' }],
      season: { summary: '11 月体感舒适，早晚偏凉。', tips: ['带一件薄外套', '周末景区人多'], weather: '待核实' },
      suitability: { family: '适合，但避免长距离步行。', couples: '适合。', seniors: '建议减少爬坡。', solo: '交通便利。' },
    },
    hotels: [{
      name: '湖滨片区精品酒店（示例）',
      area: '湖滨',
      priceRange: '¥900–1400 / 晚（待核实）',
      rating: '待核实',
      ratingSource: '',
      distanceToSights: '距断桥步行约 12 分钟',
      distanceToTransit: '距地铁站步行约 6 分钟',
      suitableFor: ['情侣', '独自'],
      reason: '兼顾景区与市区餐饮。',
      needCheck: ['实际房价与可订状态', '是否含早'],
    }],
    days: Array.from({ length: days }, (_, i) => ({
      theme: `第 ${i + 1} 天主题`,
      area: '西湖西线',
      items: [
        {
          time: '09:00', title: '断桥与白堤', type: '景点', area: '北山街', durationMin: 90,
          detail: '沿白堤慢走，途中在平湖秋月休息。', transportFromPrev: '从住宿步行', transportMin: 12,
          cost: '免费', backup: '雨天改为博物馆', booking: '无需预约',
          verify: { status: 'provided', checkedAt: '2026-10-29T00:00:00.000Z' },
        },
        {
          time: '12:30', title: '湖滨午餐', type: '餐饮', area: '湖滨', durationMin: 75,
          detail: '片儿川或本地小馆，按排队情况调整。', transportFromPrev: '步行', transportMin: 10,
          cost: '待核实', backup: '商场内餐厅',
        },
        {
          time: '15:00', title: '中国丝绸博物馆', type: '景点', area: '玉皇山路', durationMin: 120,
          detail: '<script>alert(1)</script>室内展厅，适合雨天。', transportFromPrev: '公交', transportMin: 25,
          cost: '免费', backup: '馆内咖啡休息',
        },
      ],
      meals: { breakfast: '酒店附近早点铺', lunch: '湖滨小馆', dinner: '南山路餐厅' },
      rest: '午后在馆内咖啡区休息 30 分钟。',
      freeTime: '17:30 后自由安排。',
      backupPlan: '全天改为室内博物馆动线。',
      notes: '避开周末上午的断桥人流。',
    })),
    route: { hotelArea: '湖滨', logic: '以湖滨为圆心向西北展开，避免往返。', notes: '' },
    confidence: { level: '中', missing: ['未确认酒店实际房价'] },
    warnings: ['灵隐寺周末需排队，建议早到。'],
    sources: [{ label: '通用旅行常识', type: 'model', note: '模型知识' }],
  };
}

async function startUpstream() {
  const calls = [];
  const state = { status: 200, body: null, responseStatus: 'completed', sse: false, plan: samplePlanJson(3) };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = raw ? JSON.parse(raw) : {};
    calls.push({ url: req.url, auth: req.headers.authorization, body: parsed });
    if (state.sse) {
      const text = JSON.stringify(state.body ?? state.plan);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(': keep-alive\n\n');
      const pieces = text.match(/[\s\S]{1,160}/g) || [];
      if (req.url === '/v1/responses') {
        for (const piece of pieces) {
          res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: piece })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { status: state.responseStatus } })}\n\n`);
      } else {
        for (const piece of pieces) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
      }
      return res.end();
    }
    res.writeHead(state.status, { 'Content-Type': 'application/json' });
    if (state.status !== 200) {
      return res.end(JSON.stringify({ error: 'upstream-failure-should-not-echo-' + SECRET }));
    }
    const text = JSON.stringify(state.body ?? state.plan);
    if (req.url === '/v1/responses') {
      return res.end(JSON.stringify({
        status: state.responseStatus,
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
        ],
      }));
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, state, port: server.address().port };
}

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'huantu-test-'));
  const upstream = await startUpstream();
  const logs = [];
  const app = await createApp({
    dataDir: dir,
    allowLocalUpstream: true,
    modelTimeoutMs: 15000,
    logger: { error: (...args) => logs.push(args.map(String).join(' ')) },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  let csrf = '';

  async function req(route, method = 'GET', body, extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      cookie,
      'X-Huantu-CSRF': csrf,
      ...extra,
    };
    const res = await fetch(base + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { raw: text };
    }
    if (value.csrf) csrf = value.csrf;
    return { status: res.status, value, headers: res.headers, text };
  }

  async function post(route, body = {}) {
    return fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'X-Huantu-CSRF': csrf },
      body: JSON.stringify(body),
    });
  }

  const cleanup = async () => {
    await Promise.all([
      new Promise((resolve) => app.close(resolve)),
      new Promise((resolve) => upstream.server.close(resolve)),
    ]);
    await rm(dir, { recursive: true, force: true });
  };

  return { app, upstream, base, req, post, dir, logs, cleanup };
}

const trip = {
  origin: '广州',
  destination: '杭州',
  startDate: '2026-11-05',
  days: 3,
  travelers: 2,
  children: 0,
  budget: '两人合计 8000 元',
  interests: ['博物馆', '咖啡'],
  pace: 'balanced',
  transport: 'public',
  hotel: 'boutique',
  special: '同行有 70 岁长辈，不能长时间爬坡。',
};

test('寰途：页面、协议、真实性、日历与可视化', async (t) => {
  const ctx = await setup(t);
  t.after(ctx.cleanup);

  await t.test('首页可以打开，并包含规划表单与移动端视口', async () => {
    const { status, text, headers } = await ctx.req('/');
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/html/);
    assert.match(text, /寰途/);
    assert.match(text, /id="planForm"/);
    assert.match(text, /name="mobile|width=device-width/);
    assert.match(text, /id="origin"/);
    assert.match(text, /id="destination"/);
    assert.match(text, /id="startDate"/);
    assert.match(text, /id="interestChips"/);
    assert.match(text, /开始规划/);
    assert.equal((await ctx.req('/style.css')).status, 200);
    assert.equal((await ctx.req('/app.js')).status, 200);
  });

  await t.test('交互原型可以访问：三个静态文件齐全，内容不被 CSP 拦截', async () => {
    const html = await ctx.req('/prototype');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(html.text, /交互原型/);
    assert.match(html.text, /prototype\.css/);
    assert.match(html.text, /prototype\.js/);
    // 不许把原型误做成内联脚本/样式，CSP 是 style-src/script-src 'self'
    assert.doesNotMatch(html.text, /<script>/);
    assert.doesNotMatch(html.text, /<style>/);
    assert.equal((await ctx.req('/prototype/index.html')).status, 200);
    assert.equal((await ctx.req('/prototype/prototype.css')).status, 200);
    const js = await ctx.req('/prototype/prototype.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    // 原型是纯静态演示：不允许发起网络请求或读取任何密钥
    assert.doesNotMatch(js.text, /fetch\(|XMLHttpRequest|sk-/);
    // 未知原型路径仍应 404，白名单不能被绕过
    assert.equal((await ctx.req('/prototype/nope.js')).status, 404);
  });

  await t.test('规划表单可提交（前端有提交处理，后端有 /api/plan）', async () => {
    const js = (await ctx.req('/app.js')).text;
    assert.match(js, /\$\('planForm'\)\.onsubmit/);
    assert.match(js, /\/api\/plan/);
    assert.match(js, /X-Huantu-CSRF/);
  });

  await t.test('未配置模型时返回清晰错误，不使用模板兜底', async () => {
    const s = await ctx.req('/api/state');
    assert.equal(s.value.configured, false);
    assert.equal(s.value.verified, false);
    assert.equal(s.value.model, '');
    assert.equal(s.value.adapters.search, 'not_connected');
    const r = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(r.status, 503);
    assert.match(r.value.error, /尚未配置模型/);
    assert.equal(r.value.plan, undefined);
    assert.equal(ctx.upstream.calls.length, 0);
  });

  await t.test('CSRF 与跨站来源会被拒绝', async () => {
    const bad = await ctx.req('/api/plan', 'POST', { trip }, { 'X-Huantu-CSRF': 'wrong' });
    assert.equal(bad.status, 403);
    const foreign = await ctx.req('/api/state', 'GET', undefined, { Origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
  });

  await t.test('输入校验：天数与目的地', async () => {
    await ctx.req('/api/config', 'POST', {
      baseUrl: `http://127.0.0.1:${ctx.upstream.port}/v1`,
      model: 'test-model',
      apiKey: SECRET,
      protocol: 'chat-completions',
    });
    assert.equal((await ctx.req('/api/plan', 'POST', { trip: { ...trip, days: 30 } })).status, 400);
    assert.equal((await ctx.req('/api/plan', 'POST', { trip: { ...trip, destination: '' } })).status, 400);
    assert.equal((await ctx.req('/api/plan', 'POST', { trip: { ...trip, startDate: '2026-02-30' } })).status, 400);
    assert.equal((await ctx.req('/api/plan', 'POST', { trip: { ...trip, origin: '杭州' } })).status, 400);
  });

  await t.test('Chat Completions 协议：路径、鉴权、无状态与结构化规划', async () => {
    await ctx.req('/api/config', 'POST', {
      baseUrl: `http://127.0.0.1:${ctx.upstream.port}/v1`,
      model: 'test-model',
      apiKey: SECRET,
      protocol: 'chat-completions',
    });
    const state = await ctx.req('/api/state');
    assert.equal(state.value.configured, true);
    assert.equal(state.value.verified, false, '配置不等于已验证');

    const test1 = await ctx.req('/api/test', 'POST', {});
    assert.equal(test1.status, 200);
    assert.equal(test1.value.source, 'model');
    assert.equal(ctx.upstream.calls.at(-1).url, '/v1/chat/completions');
    assert.equal(ctx.upstream.calls.at(-1).auth, `Bearer ${SECRET}`);
    assert.equal(ctx.upstream.calls.at(-1).body.store, false);
    assert.ok(Array.isArray(ctx.upstream.calls.at(-1).body.messages));
    assert.equal(ctx.upstream.calls.at(-1).body.stream, true, '默认使用流式，避免网关空闲超时');

    const r = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(r.status, 200);
    const plan = r.value.plan;

    // 规划结果可渲染：结构完整、日期由后端计算
    assert.equal(plan.days.length, 3);
    assert.equal(plan.days[0].date, '2026-11-05');
    assert.equal(plan.days[2].date, '2026-11-07');
    assert.equal(plan.days[0].label, 'Day 1');
    assert.equal(plan.days[0].items[0].time, '09:00');
    assert.equal(plan.days[0].items[0].endTime, '10:30');
    assert.equal(plan.days[0].items.length, 3);
    assert.equal(plan.meta.engine, 'model');
    assert.equal(plan.meta.model, 'test-model');
    assert.ok(plan.overview.title.length > 0);
    assert.ok(plan.hotels.length > 0);

    // 时效信息不得被伪造：模型自报的查询时间被丢弃
    assert.equal(plan.days[0].items[0].verify.checkedAt, null);
    assert.equal(plan.days[0].items[0].verify.status, 'unverified');
    assert.equal(plan.insights.season.verify.checkedAt, null);
    assert.equal(plan.insights.attractions[0].verify.status, 'unverified');

    // 模型 HTML 不被执行/保留
    assert.equal(plan.days[0].items[2].detail.includes('<script'), false);
    assert.match(plan.days[0].items[2].detail, /室内展厅/);

    // 来源与警告：后端强制加入"未接入实时接口"
    assert.ok(plan.sources.some((s) => s.type === 'local'));
    assert.ok(plan.sources.some((s) => s.status === 'not_connected'));
    assert.ok(plan.warnings.some((w) => w.includes('待核实')));
  });

  await t.test('Responses 协议：/responses + input + status 校验', async () => {
    await ctx.req('/api/config', 'POST', {
      baseUrl: `http://127.0.0.1:${ctx.upstream.port}/v1`,
      model: 'test-responses',
      apiKey: SECRET,
      protocol: 'responses',
      role: 'developer',
    });
    assert.equal((await ctx.req('/api/state')).value.verified, false);
    assert.equal((await ctx.req('/api/test', 'POST', {})).status, 200);
    const last = ctx.upstream.calls.at(-1);
    assert.equal(last.url, '/v1/responses');
    assert.equal(last.body.store, false);
    assert.equal(last.body.messages, undefined);
    assert.ok(Array.isArray(last.body.input));

    const r = await ctx.req('/api/plan', 'POST', { trip: { ...trip, days: 2 } });
    assert.equal(r.status, 200);
    assert.equal(r.value.plan.days.length, 2, '天数以用户输入为准');
    // 两阶段生成：先研究（规则 + 知识库 + 需求），再排行程（规则 + 需求）
    const itineraryCall = ctx.upstream.calls.at(-1);
    assert.equal(itineraryCall.url, '/v1/responses');
    assert.equal(itineraryCall.body.input[0].role, 'developer');
    assert.equal(itineraryCall.body.input.length, 2);
    assert.match(itineraryCall.body.input[1].content, /阶段二/);
    const researchCall = ctx.upstream.calls.at(-2);
    assert.equal(researchCall.body.input[0].role, 'developer');
    assert.equal(researchCall.body.input.length, 3);
    assert.match(researchCall.body.input[2].content, /阶段一/);
    assert.deepEqual(r.value.plan.meta.stages.map((x) => x.stage), ['research', 'itinerary']);

    ctx.upstream.state.responseStatus = 'incomplete';
    const incomplete = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(incomplete.status, 502);
    assert.match(incomplete.value.error, /未完成/);
    ctx.upstream.state.responseStatus = 'completed';
  });

  await t.test('流式响应（SSE）能被正确拼接，心跳行被忽略', async () => {
    ctx.upstream.state.sse = true;
    const base = { baseUrl: `http://127.0.0.1:${ctx.upstream.port}/v1`, apiKey: SECRET };
    await ctx.req('/api/config', 'POST', { ...base, model: 'test-stream', protocol: 'chat-completions' });

    let r = await ctx.req('/api/plan', 'POST', { trip: { ...trip, days: 2 } });
    assert.equal(r.status, 200);
    assert.equal(r.value.plan.days.length, 2);
    assert.equal(r.value.plan.days[0].items.length, 3, '分片拼接后结构应完整');
    assert.equal(r.value.plan.meta.model, 'test-stream');
    assert.equal(JSON.stringify(r.value).includes('keep-alive'), false);

    await ctx.req('/api/config', 'POST', {
      ...base, model: 'test-stream-responses', protocol: 'responses', role: 'developer',
    });
    r = await ctx.req('/api/plan', 'POST', { trip: { ...trip, days: 3 } });
    assert.equal(r.status, 200);
    assert.equal(r.value.plan.days.length, 3);
    assert.equal(r.value.plan.days[2].items.length, 3);

    ctx.upstream.state.responseStatus = 'incomplete';
    const truncated = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(truncated.status, 502);
    assert.match(truncated.value.error, /未完成/);

    ctx.upstream.state.responseStatus = 'completed';
    ctx.upstream.state.sse = false;
  });

  await t.test('模型失败时显示真实错误且不回显密钥', async () => {
    ctx.upstream.state.status = 401;
    const r = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(r.status, 502);
    assert.match(r.value.error, /401/);
    assert.equal(JSON.stringify(r.value).includes(SECRET), false);

    ctx.upstream.state.status = 200;
    ctx.upstream.state.body = { not: 'a plan' };
    const bad = await ctx.req('/api/plan', 'POST', { trip });
    // 结构不完整时仍会返回一个可渲染但空壳的方案，而不是伪造内容
    if (bad.status === 200) {
      assert.equal(bad.value.plan.days[0].items.length, 0);
      assert.equal(bad.value.plan.meta.engine, 'model');
    } else {
      assert.equal(bad.status, 502);
    }
    ctx.upstream.state.body = null;
    // 恢复一份完整方案，供后续 ICS / Google / SVG / 日历用例使用
    const restored = await ctx.req('/api/plan', 'POST', { trip });
    assert.equal(restored.value.plan.days[0].items.length, 3);
  });

  await t.test('ICS 文件格式正确（CRLF、折行、转义、UID、提醒）', async () => {
    const plan = (await ctx.req('/api/plan/latest')).value.plan;
    const ics = buildIcs(plan, { planId: plan.planId });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.match(ics, /VERSION:2\.0\r\n/);
    assert.match(ics, /PRODID:-\/\/Huantu\/\/AI Travel Planner\/\/ZH-CN/);
    assert.match(ics, /X-WR-CALNAME:寰途 · /);

    const events = ics.match(/BEGIN:VEVENT/g) || [];
    const totalItems = plan.days.reduce((n, d) => n + d.items.filter((i) => i.time).length, 0);
    assert.equal(events.length, totalItems);

    assert.match(ics, /DTSTART:20261105T090000\r\n/);
    assert.match(ics, /DTEND:20261105T103000\r\n/);
    assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT30M/);
    assert.match(ics, /UID:huantu-[a-f0-9]+-d1-i1@huantu\.local/);

    // 每一物理行（去掉 CRLF）不超过 75 字节
    for (const line of ics.split('\r\n')) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `折行失败：${line.slice(0, 20)}… ${Buffer.byteLength(line)} 字节`);
    }

    const escaped = buildIcs({
      input: { timezone: 'Asia/Shanghai', destination: 'A,B;C' },
      days: [{ day: 1, label: 'Day 1', date: '2026-11-05', items: [{ time: '09:00', endTime: '10:00', title: '咖啡,茶;点心', detail: '第一行\n第二行', area: 'X' }] }],
      hotels: [], route: {}, overview: { title: 'A,B;C' }, meta: {},
    }, { planId: 'abc123' });
    assert.match(escaped, /SUMMARY:Day 1 · 咖啡\\,茶\\;点心/);
    assert.match(escaped, /第一行\\n第二行/);

    // HTTP 端点返回 text/calendar 附件
    const res = await ctx.post('/api/calendar/ics', { planId: plan.planId });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="huantu-[a-f0-9]+\.ics"/);
  });

  await t.test('Google Calendar 链接的时间换算与参数正确', async () => {
    assert.equal(zonedTimeToUtc('2026-11-05', '09:00', 'Asia/Shanghai'), Date.UTC(2026, 10, 5, 1, 0, 0));
    assert.equal(zonedTimeToUtc('2026-11-05', '09:00', 'Europe/London'), Date.UTC(2026, 10, 5, 9, 0, 0));

    const plan = (await ctx.req('/api/plan/latest')).value.plan;
    const links = await ctx.req('/api/calendar/google', 'POST', { planId: plan.planId });
    assert.equal(links.status, 200);
    const first = links.value.events[0];
    const url = new URL(first.url);
    assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render');
    assert.equal(url.searchParams.get('action'), 'TEMPLATE');
    assert.equal(url.searchParams.get('dates'), '20261105T010000Z/20261105T023000Z');
    assert.equal(url.searchParams.get('ctz'), 'Asia/Shanghai');
    assert.match(url.searchParams.get('text'), /Day 1 · 断桥与白堤/);
    assert.equal(links.value.authorized, false);
    assert.match(links.value.note, /未获得授权/);
    assert.ok(links.value.trip.url.startsWith('https://calendar.google.com/'));

    // 出境行程：按目的地时区折算（京都 09:00 JST = 00:00Z），不能沿用北京时间
    const tokyo = {
      input: { destination: '京都', timezone: 'Asia/Tokyo', days: 1 },
      overview: { title: '京都' },
      days: [{ day: 1, label: 'Day 1', date: '2026-11-12', items: [{ time: '09:00', endTime: '10:30', title: '清水寺' }] }],
      hotels: [], route: {}, meta: {},
    };
    const tokyoLinks = buildGoogleLinks(tokyo, { planId: 'tokyo1' });
    const tokyoUrl = new URL(tokyoLinks.events[0].url);
    assert.equal(tokyoUrl.searchParams.get('dates'), '20261112T000000Z/20261112T013000Z');
    assert.equal(tokyoUrl.searchParams.get('ctz'), 'Asia/Tokyo');
    const tokyoIcs = buildIcs(tokyo, { planId: 'tokyo1' });
    assert.match(tokyoIcs, /X-WR-TIMEZONE:Asia\/Tokyo/);
    assert.match(tokyoIcs, /DTSTART:20261112T090000/);
  });

  await t.test('SVG 可视化可以生成，且标注非实时地图', async () => {
    const plan = (await ctx.req('/api/plan/latest')).value.plan;
    const svg = buildRouteSvg(plan);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.endsWith('</svg>'));
    assert.match(svg, /非实时地图/);
    assert.match(svg, /viewBox="0 0 1200 /);
    const nodeCount = (svg.match(/r="9"/g) || []).length;
    const expected = plan.days.reduce((n, d) => n + Math.min(d.items.length, 6), 0);
    assert.equal(nodeCount, expected, '景点节点数应与行程项目数一致');
    assert.match(svg, /DAY 1|Day 1/);
    assert.match(svg, /住宿参考/);
    assert.doesNotMatch(svg, /<script/i);

    const res = await ctx.post('/api/visual/svg', { planId: plan.planId });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await res.text(), /非实时地图/);
  });

  await t.test('日历同步状态不会被伪造', async () => {
    const s = await ctx.req('/api/state');
    const cal = s.value.calendar;
    assert.equal(cal.google.state, 'needs_authorization');
    assert.equal(cal.google.label, '尚未授权');
    assert.equal(cal.google.canSync, false);
    assert.equal(cal.apple.canSync, false);
    assert.equal(cal.ics.state, 'available');
    assert.equal(cal.lastSyncedAt, null);

    const google = await ctx.req('/api/calendar/connect', 'POST', { provider: 'google' });
    assert.equal(google.status, 501);
    assert.equal(google.value.connected, false);
    assert.match(google.value.message, /OAuth/);

    const apple = await ctx.req('/api/calendar/connect', 'POST', { provider: 'apple' });
    assert.equal(apple.value.connected, false);

    // 删除必须先确认
    const unconfirmed = await ctx.req('/api/calendar/delete', 'POST', { planId: s.value.hasPlan ? 'x' : '' });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.value.error, /确认/);

    const plan = (await ctx.req('/api/plan/latest')).value.plan;
    const confirmed = await ctx.req('/api/calendar/delete', 'POST', { confirm: true, planId: plan.planId });
    assert.equal(confirmed.value.deleted, false);
    assert.equal(confirmed.status, 501);
  });

  await t.test('重新规划保留已锁定的安排', async () => {
    const current = (await ctx.req('/api/plan/latest')).value.plan;
    const lockedTheme = current.days[0].theme;
    const lockedTitle = current.days[0].items[0].title;

    ctx.upstream.state.body = samplePlanJson(3);
    const next = samplePlanJson(3);
    next.days[0].theme = '模型改写后的主题';
    next.days[0].items = [{ time: '10:00', title: '被替换的景点', type: '景点', durationMin: 60 }];
    ctx.upstream.state.body = next;

    const before = ctx.upstream.calls.length;
    const r = await ctx.req('/api/replan', 'POST', {
      planId: current.planId,
      change: '第二天改室内，其余保留',
      lockedDays: [1],
    });
    assert.equal(r.status, 200);
    assert.equal(ctx.upstream.calls.length - before, 1, '普通调整只重排行程，复用已有研究');
    assert.equal(r.value.plan.meta.researchReused, true);
    assert.equal(r.value.plan.days[0].theme, lockedTheme);
    assert.equal(r.value.plan.days[0].items[0].title, lockedTitle);
    assert.equal(r.value.plan.days[0].locked, true);
    assert.ok(r.value.plan.meta.preservedItems >= 1);

    // 涉及住宿/预算时会重做研究，因此是两次上游调用
    ctx.upstream.state.body = samplePlanJson(3);
    const before2 = ctx.upstream.calls.length;
    const budget = await ctx.req('/api/replan', 'POST', {
      planId: r.value.plan.planId,
      change: '降低预算，换到更经济的住宿区域',
    });
    assert.equal(budget.status, 200);
    assert.equal(ctx.upstream.calls.length - before2, 2, '涉及住宿预算时要重做研究');
    assert.equal(budget.value.plan.meta.researchReused, false);
    ctx.upstream.state.body = null;
  });

  await t.test('密钥不出现在前端响应、磁盘配置或日志中', async () => {
    const endpoints = ['/api/state', '/api/plan/latest', '/api/health'];
    for (const route of endpoints) {
      const r = await ctx.req(route, 'GET');
      assert.equal(JSON.stringify(r.value).includes(SECRET), false, `${route} 泄露了密钥`);
    }
    const cfgRaw = await readFile(path.join(ctx.dir, 'config.json'), 'utf8');
    assert.equal(cfgRaw.includes(SECRET), false);
    assert.match(cfgRaw, /test-stream|test-model|test-responses/);
    assert.equal(ctx.logs.join('\n').includes(SECRET), false, '错误日志里不能出现密钥');

    const page = await ctx.req('/');
    assert.equal(page.text.includes(SECRET), false);
    const js = await ctx.req('/app.js');
    assert.equal(js.text.includes(SECRET), false);
  });

  await t.test('导入已导出的 JSON：清洗、重标注、不调用模型', async () => {
    const before = ctx.upstream.calls.length;
    const raw = samplePlanJson(2);
    raw.days[0].items[0].detail = '<img src=x onerror=alert(1)>导入的说明';
    raw.days[0].items[0].verify = { status: 'provided', checkedAt: '2026-10-29T00:00:00.000Z' };
    const r = await ctx.req('/api/plan/import', 'POST', { plan: { input: trip, ...raw } });
    assert.equal(r.status, 200);
    assert.equal(r.value.imported, true);
    assert.equal(ctx.upstream.calls.length, before, '导入不应调用模型');
    const plan = r.value.plan;
    assert.equal(plan.meta.engine, 'import');
    assert.equal(plan.days.length, 3, '天数按导入文件里的 input 规范化');
    assert.equal(plan.days[0].items[0].detail.includes('<img'), false);
    assert.equal(plan.days[0].items[0].verify.checkedAt, null, '导入内容不得自带查询时间');
    assert.ok(plan.warnings.some((w) => w.includes('导入')));
    assert.equal((await ctx.req('/api/plan/latest')).value.plan.planId, plan.planId);

    assert.equal((await ctx.req('/api/plan/import', 'POST', { plan: 'not-an-object' })).status, 400);
    assert.equal((await ctx.req('/api/plan/import', 'POST', { plan: { overview: {} } })).status, 400);
  });

  await t.test('清除旅行记录', async () => {
    const del = await ctx.req('/api/plan', 'DELETE');
    assert.equal(del.value.cleared, true);
    const latest = await ctx.req('/api/plan/latest');
    assert.equal(latest.value.plan, null);
  });
});

test('validateTripInput 与 normalizePlan 的边界行为', () => {
  const input = validateTripInput(trip);
  assert.equal(input.endDate, '2026-11-07');
  assert.equal(input.interests.length, 2);
  assert.equal(input.timezone, 'Asia/Shanghai', '国内目的地回落 Asia/Shanghai');
  assert.equal(validateTripInput({ ...trip, destination: '京都', origin: '广州' }).timezone, 'Asia/Tokyo', '出境目的地要换时区');
  assert.equal(validateTripInput({ ...trip, destination: '巴黎', origin: '广州' }).timezone, 'Europe/Paris');
  assert.equal(validateTripInput({ ...trip, destination: '香港', origin: '广州' }).timezone, 'Asia/Hong_Kong');
  assert.equal(validateTripInput({ ...trip, timezone: 'Europe/Paris' }).timezone, 'Europe/Paris');
  assert.equal(validateTripInput({ ...trip, timezone: 'Not/AZone' }).timezone, 'Asia/Shanghai');

  const plan = normalizePlan({ days: 'not-an-array', hotels: 'nope' }, input, { planId: 'x', model: 'm' });
  assert.equal(plan.days.length, 3);
  assert.equal(plan.days[0].items.length, 0);
  assert.equal(plan.hotels.length, 0);
  assert.equal(plan.confidence.level, '中');
  assert.equal(plan.days[0].date, '2026-11-05');
  assert.ok(plan.warnings.length >= 2);

  // 模型自带「Day 1｜」前缀时要剥掉，避免与列表里的 Day 标签重复
  const themed = normalizePlan({
    days: [{ theme: 'Day 1｜东山历史街区', items: [] }, { theme: '第 2 天：茶山', items: [] }],
  }, input, { planId: 'y' });
  assert.equal(themed.days[0].theme, '东山历史街区');
  assert.equal(themed.days[1].theme, '茶山');

  const merged = mergeConfirmed({
    days: [{ day: 1, locked: true, theme: '锁定主题', items: [{ title: '保留项', time: '09:00', index: 0 }] }],
  },
  { days: [{ day: 1, theme: '新主题', items: [], locked: false }], meta: {}, route: {} },
  );
  assert.equal(merged.days[0].theme, '锁定主题');
  assert.equal(merged.days[0].items[0].title, '保留项');
});
