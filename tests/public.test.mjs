import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp, stripHostPort, normalizePublicHost, isHostAllowed, resolveBindHost } from '../server.mjs';
import { createQueue } from '../queue.mjs';

// 测试必须离线可跑：关掉实时天气与联网搜索，避免任何外部请求影响断言与耗时。
process.env.HUANTU_WEATHER = 'off';
process.env.HUANTU_SEARCH_PROVIDER = 'off';
// 地理编码会发外网请求，单测里一律关掉，坐标逻辑另有 tests/geo.test.mjs 用假 fetch 覆盖
process.env.HUANTU_GEOCODE = 'off';


const SECRET = 'public-secret-placeholder';
const CODE = 'huantu-demo-code-2026-9f3a';
const PUBLIC_HOST = 'huantu.example.com';

function plan(days = 2) {
  return {
    overview: { title: '杭州 · 两日', summary: '西湖西线为主。', highlights: ['住湖滨'], paceNote: '留白。', bestFor: '首访' },
    insights: {
      attractions: [{ name: '断桥', area: '北山街', why: '清晨人少。', type: '景点', suggestedDuration: '60 分钟', bestTime: '清晨', openingHours: '待核实', ticket: '免费', suitableFor: ['情侣'], backup: '改博物馆' }],
      hiddenGems: [], activities: [], food: [], cafes: [], transport: [],
      season: { summary: '秋末偏凉。', tips: ['带外套'], weather: '待核实' },
      suitability: { family: '', couples: '', seniors: '', solo: '' },
    },
    hotels: [{ name: '湖滨示例酒店', area: '湖滨', priceRange: '待核实', rating: '待核实', reason: '近湖。', needCheck: ['房价'] }],
    days: Array.from({ length: days }, (_, i) => ({
      theme: `第 ${i + 1} 天`, area: '西湖',
      items: [{ time: '09:00', title: '断桥', type: '景点', durationMin: 60, detail: '沿堤慢走。', transportFromPrev: '从住宿步行', transportMin: 10 }],
      meals: { breakfast: '酒店', lunch: '小馆', dinner: '自由' },
      rest: '午后休息。', freeTime: '17:00 后自由。', backupPlan: '室内动线。', notes: '',
    })),
    route: { hotelArea: '湖滨', logic: '以湖滨为圆心。', notes: '' },
    confidence: { level: '中', missing: [] },
    warnings: [], sources: [],
  };
}

const trip = {
  origin: '广州', destination: '杭州', startDate: '2026-11-05', days: 2, travelers: 2,
  budget: '两人 6000 元', interests: ['博物馆'], pace: 'balanced', transport: 'public', hotel: 'comfort', special: '',
};

async function startUpstream() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const contents = (body.messages || body.input || []).map((m) => m.content || '');
    const stage = (contents.at(-1) || '').includes('阶段二') ? 'itinerary' : 'research';
    calls.push({ stage });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const text = JSON.stringify(plan(2));
    if (req.url === '/v1/responses') {
      return res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }));
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, port: server.address().port };
}

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'huantu-public-'));
  const upstream = await startUpstream();
  const logs = [];

  // 公开模式下访客不能改模型配置，所以模型必须由运维通过环境变量注入
  const previousEnv = {
    HUANTU_API_BASE_URL: process.env.HUANTU_API_BASE_URL,
    HUANTU_MODEL: process.env.HUANTU_MODEL,
    HUANTU_API_KEY: process.env.HUANTU_API_KEY,
    HUANTU_PROTOCOL: process.env.HUANTU_PROTOCOL,
  };
  process.env.HUANTU_API_BASE_URL = `http://127.0.0.1:${upstream.port}/v1`;
  process.env.HUANTU_MODEL = 'public-test-model';
  process.env.HUANTU_API_KEY = SECRET;
  process.env.HUANTU_PROTOCOL = 'chat-completions';

  const app = await createApp({
    dataDir: dir,
    allowLocalUpstream: true,
    publicMode: true,
    accessCode: CODE,
    publicHost: PUBLIC_HOST,
    planWaitMs: 3000,
    queue: createQueue({ driver: 'memory' }),
    logger: { error: (...a) => logs.push(a.map(String).join(' ')) },
    ...overrides,
  });

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;

  const jar = new Map();
  let csrf = '';
  let lastCookies = [];

  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async function raw(route, { method = 'GET', body, headers = {}, noCookies = false } = {}) {
    const res = await fetch(base + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Huantu-CSRF': csrf,
        ...(noCookies ? {} : { cookie: cookieHeader() }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    lastCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const rawCookie of lastCookies) {
      const [pair] = rawCookie.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (value === '') jar.delete(name.trim());
      else jar.set(name.trim(), value);
    }
    const text = await res.text();
    let value;
    try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
    if (value.csrf) csrf = value.csrf;
    return { status: res.status, value, text, headers: res.headers, cookies: lastCookies };
  }

  // fetch 禁止自定义 Host，这里用 http.request 才能测 Host 头
  function httpReq(route, { method = 'GET', headers = {}, body } = {}) {
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: app.address().port,
        path: route,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        agent: false,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let value;
          try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
          resolve({ status: res.statusCode, value, text });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  await raw('/api/public');

  t.after(async () => {
    await Promise.all([
      new Promise((r) => app.close(r)),
      new Promise((r) => upstream.server.close(r)),
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  return { app, upstream, base, raw, httpReq, jar, logs, get csrf() { return csrf; } };
}

async function authorize(ctx) {
  const r = await ctx.raw('/api/session', { method: 'POST', body: { code: CODE } });
  assert.equal(r.status, 200, '正确访问码应放行');
  return r;
}

async function waitJob(ctx, jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await ctx.raw(`/api/jobs/${jobId}`);
    if (['completed', 'failed', 'cancelled'].includes(value.job?.status)) return value.job;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('job timeout');
}

test('公开试用模式：访问码、权限、Host 与限额', async (t) => {
  await t.test('未授权时业务接口一律 401，入口接口不泄露模型信息', async () => {
    const ctx = await setup(t);
    const pub = await ctx.raw('/api/public');
    assert.equal(pub.status, 200);
    assert.equal(pub.value.public, true);
    assert.equal(pub.value.authorized, false);
    assert.ok(pub.value.csrf, '未授权也要给 CSRF，否则无法提交访问码');

    const health = await ctx.raw('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.value.public, true);
    assert.equal(health.value.model, undefined, '公开模式 health 不能带模型 ID');
    assert.equal(health.text.includes(SECRET), false);

    for (const [route, method] of [['/api/state', 'GET'], ['/api/jobs', 'GET'], ['/api/plan/latest', 'GET']]) {
      const r = await ctx.raw(route, { method });
      assert.equal(r.status, 401, `${route} 未授权应 401`);
      assert.equal(r.value.code, 'access_code_required');
    }
    const create = await ctx.raw('/api/jobs', { method: 'POST', body: { trip } });
    assert.equal(create.status, 401);
    assert.equal(ctx.upstream.calls.length, 0, '未授权不应触发任何模型调用');
  });

  await t.test('访问码错误返回 401，连续失败会限流', async () => {
    const ctx = await setup(t);
    for (let i = 0; i < 5; i++) {
      const r = await ctx.raw('/api/session', { method: 'POST', body: { code: 'wrong-code-' + i } });
      assert.equal(r.status, 401);
      assert.match(r.value.error, /访问码不正确/);
    }
    const blocked = await ctx.raw('/api/session', { method: 'POST', body: { code: CODE } });
    assert.equal(blocked.status, 429, '连续失败后应暂时限流');
    assert.match(blocked.value.error, /尝试次数过多/);
  });

  await t.test('正确访问码下发短期 HttpOnly Cookie，HTTPS 下带 Secure', async () => {
    const ctx = await setup(t);
    const r = await ctx.raw('/api/session', {
      method: 'POST',
      body: { code: CODE },
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(r.status, 200);
    const cookie = r.cookies.find((c) => c.startsWith('huantu_access='));
    assert.ok(cookie, '必须下发 huantu_access');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=\d+/);
    assert.equal(r.text.includes(CODE), false, '响应体不能回显访问码');

    // 非 HTTPS 时仍下发 HttpOnly，但不加 Secure（否则本机 http 调不通）
    const ctx2 = await setup(t);
    const plain = await ctx2.raw('/api/session', { method: 'POST', body: { code: CODE } });
    const plainCookie = plain.cookies.find((c) => c.startsWith('huantu_access='));
    assert.match(plainCookie, /HttpOnly/);
    assert.equal(plainCookie.includes('Secure'), false);
  });

  await t.test('授权后只能建任务/看进度/看结果，不能碰模型配置', async () => {
    const ctx = await setup(t);
    await authorize(ctx);

    const state = await ctx.raw('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.value.public, true);
    assert.equal(state.value.authorized, true);
    assert.equal(typeof state.value.ready, 'boolean');
    for (const key of ['baseUrl', 'model', 'protocol', 'role', 'apiKey', 'lastError', 'verification', 'verified']) {
      assert.equal(state.value[key], undefined, `公开 state 不应包含 ${key}`);
    }
    assert.equal(state.text.includes('127.0.0.1'), false, '不能泄露模型地址');

    // 模型配置相关接口全部 403
    const config = await ctx.raw('/api/config', { method: 'POST', body: { baseUrl: 'https://evil.example/v1', model: 'x', apiKey: 'x'.repeat(20) } });
    assert.equal(config.status, 403);
    assert.equal(config.value.code, 'not_available_in_public_mode');
    assert.equal((await ctx.raw('/api/config', { method: 'DELETE' })).status, 403);
    assert.equal((await ctx.raw('/api/test', { method: 'POST', body: {} })).status, 403);
    assert.equal((await ctx.raw('/api/plan/import', { method: 'POST', body: { plan: {} } })).status, 403);
    assert.equal((await ctx.raw('/api/calendar/connect', { method: 'POST', body: { provider: 'google' } })).status, 403);
    assert.equal((await ctx.raw('/api/calendar/delete', { method: 'POST', body: { confirm: true } })).status, 403);

    // 正常流程可用
    const created = await ctx.raw('/api/jobs', { method: 'POST', body: { trip } });
    assert.equal(created.status, 202);
    const job = await waitJob(ctx, created.value.jobId);
    assert.equal(job.status, 'completed');
    const result = await ctx.raw(`/api/jobs/${created.value.jobId}/result`);
    assert.equal(result.status, 200);
    assert.equal(result.value.plan.days.length, 2);
    assert.equal(result.text.includes(SECRET), false);

    // 结果衍生的只读导出仍可用
    assert.equal((await ctx.raw('/api/plan/latest')).status, 200);
    assert.equal((await ctx.raw('/api/calendar/google', { method: 'POST', body: {} })).status, 200);
    assert.equal((await ctx.raw('/api/plan/export', { method: 'POST', body: {} })).status, 200);
  });

  await t.test('Host 白名单：只认 localhost / 127.0.0.1 / 配置域名 / 可信代理的 X-Forwarded-Host', async () => {
    const ctx = await setup(t);

    const good = await ctx.httpReq('/api/public', { headers: { Host: PUBLIC_HOST } });
    assert.equal(good.status, 200, '配置的公开域名应放行');

    const withPort = await ctx.httpReq('/api/public', { headers: { Host: `${PUBLIC_HOST}:443` } });
    assert.equal(withPort.status, 200, '带端口的 Host 也应识别');

    const evil = await ctx.httpReq('/api/public', { headers: { Host: 'evil.example.net' } });
    assert.equal(evil.status, 403);
    assert.match(evil.value.error, /允许列表|HUANTU_PUBLIC_HOST/);

    // 可信代理（默认含 127.0.0.1）转发过来的域名可以放行
    const viaProxy = await ctx.httpReq('/api/public', {
      headers: { Host: '127.0.0.1', 'X-Forwarded-Host': PUBLIC_HOST },
    });
    assert.equal(viaProxy.status, 200);

    // 不信任的代理伪造 X-Forwarded-Host 无效
    const ctx2 = await setup(t, { trustedProxies: [] });
    const spoofed = await ctx2.httpReq('/api/public', {
      headers: { Host: 'evil.example.net', 'X-Forwarded-Host': PUBLIC_HOST },
    });
    assert.equal(spoofed.status, 403, '不可信来源的 X-Forwarded-Host 必须被忽略');

    // 端口、大小写、带 scheme 的配置都能归一化
    assert.equal(stripHostPort('HuAnTu.Example.com:8443'), 'huantu.example.com');
    assert.equal(stripHostPort('[::1]:8788'), '::1');
    assert.equal(normalizePublicHost('https://huantu.example.com/path?x=1'), 'huantu.example.com');
    assert.equal(normalizePublicHost('huantu.example.com:443'), 'huantu.example.com');
    assert.equal(normalizePublicHost('*.trycloudflare.com'), '*.trycloudflare.com');
  });

  await t.test('HUANTU_PUBLIC_HOST 支持通配后缀（隧道域名每次变化不用改配置）', async () => {
    const ctx = await setup(t, { publicHost: '*.trycloudflare.com' });

    const random = await ctx.httpReq('/api/public', { headers: { Host: 'quiet-river-1234.trycloudflare.com' } });
    assert.equal(random.status, 200, '任意子域名都应放行');

    const another = await ctx.httpReq('/api/public', { headers: { Host: 'brave-fox-99.trycloudflare.com:443' } });
    assert.equal(another.status, 200);

    const bareDomain = await ctx.httpReq('/api/public', { headers: { Host: 'trycloudflare.com' } });
    assert.equal(bareDomain.status, 403, '裸域名不在通配范围内');

    const lookalike = await ctx.httpReq('/api/public', { headers: { Host: 'x.trycloudflare.com.evil.net' } });
    assert.equal(lookalike.status, 403, '后缀伪装必须被拒绝');

    assert.equal(isHostAllowed('a.b.trycloudflare.com', { exact: [], suffix: 'trycloudflare.com' }), true);
    assert.equal(isHostAllowed('trycloudflare.com', { exact: [], suffix: 'trycloudflare.com' }), false);
    assert.equal(isHostAllowed('eviltrycloudflare.com', { exact: [], suffix: 'trycloudflare.com' }), false);
  });

  await t.test('HUANTU_PUBLIC_HOST 支持逗号分隔多个主机（局域网 IP + 隧道域名同时放行）', async () => {
    const ctx = await setup(t, { publicHost: '<LAN_IP>, *.loca.lt' });

    for (const host of ['<LAN_IP>:8788', 'good-name.loca.lt', '127.0.0.1']) {
      const r = await ctx.httpReq('/api/public', { headers: { Host: host } });
      assert.equal(r.status, 200, `${host} 应放行`);
    }
    const other = await ctx.httpReq('/api/public', { headers: { Host: '192.168.0.109' } });
    assert.equal(other.status, 403, '列表外的局域网 IP 应拒绝');
  });

  await t.test('CSRF、会话隔离与登出仍然生效', async () => {
    const ctx = await setup(t);
    await authorize(ctx);

    const noCsrf = await ctx.raw('/api/jobs', { method: 'POST', body: { trip }, headers: { 'X-Huantu-CSRF': 'wrong' } });
    assert.equal(noCsrf.status, 403);

    const created = await ctx.raw('/api/jobs', { method: 'POST', body: { trip } });
    await waitJob(ctx, created.value.jobId);

    // 另一个浏览器（没有 access cookie）直接 401，任务 id 也拿不到
    const stranger = await ctx.raw(`/api/jobs/${created.value.jobId}`, { noCookies: true });
    assert.equal(stranger.status, 401);

    // 有访问码但换了会话（只有 access cookie，没有 huantu_sid）→ 看不到别人的任务
    const accessOnly = await ctx.httpReq(`/api/jobs/${created.value.jobId}`, {
      headers: { cookie: `huantu_access=${ctx.jar.get('huantu_access')}` },
    });
    assert.equal(accessOnly.status, 404, '会话隔离：换会话看不到别人的任务');

    const logout = await ctx.raw('/api/session/logout', { method: 'POST', body: {} });
    assert.equal(logout.status, 200);
    assert.equal((await ctx.raw('/api/state')).status, 401, '登出后应重新需要访问码');
  });

  await t.test('每个会话有模型调用上限，超过返回 429', async () => {
    const ctx = await setup(t, { maxCallsPerSession: 2 });
    await authorize(ctx);

    const first = await ctx.raw('/api/jobs', { method: 'POST', body: { trip } });
    const job = await waitJob(ctx, first.value.jobId);
    assert.equal(job.status, 'completed');
    assert.equal(ctx.upstream.calls.length, 2);

    const second = await ctx.raw('/api/plan', { method: 'POST', body: { trip } });
    assert.equal(second.status, 429);
    assert.match(second.value.error, /上限/);
    assert.equal(second.value.job.status, 'failed');
    assert.equal(second.value.job.error.status, 429);

    const third = await ctx.raw('/api/jobs', { method: 'POST', body: { trip } });
    assert.equal(third.status, 202);
    const failed = await waitJob(ctx, third.value.jobId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.message, /上限/);
    assert.equal(ctx.upstream.calls.length, 2, '超额后不应再调用模型');
  });

  await t.test('访问码与密钥不出现在页面、脚本、状态与日志里', async () => {
    const ctx = await setup(t);
    await authorize(ctx);

    const page = await ctx.raw('/');
    const js = await ctx.raw('/app.js');
    assert.equal(page.text.includes(CODE), false);
    assert.equal(js.text.includes(CODE), false);
    assert.equal(js.text.includes('localStorage'), false, '前端不应把访问码存进 localStorage');
    assert.match(page.text, /id="gateForm"/);
    assert.match(page.text, /id="accessCode"/);

    const state = await ctx.raw('/api/state');
    assert.equal(state.text.includes(CODE), false);
    assert.equal(state.text.includes(SECRET), false);
    assert.equal(ctx.logs.join('\n').includes(CODE), false);
    assert.equal(ctx.logs.join('\n').includes(SECRET), false);
  });

  await t.test('公开模式强制要求 12 位以上访问码，或显式声明不要码', async () => {
    await assert.rejects(
      () => createApp({ publicMode: true, accessCode: 'short', publicHost: PUBLIC_HOST }),
      /至少 12 位/,
    );
    await assert.rejects(
      () => createApp({ publicMode: true, accessCode: '', publicHost: PUBLIC_HOST }),
      /HUANTU_PUBLIC_NO_CODE/,
    );
  });
});

test('公开模式不设访问码（HUANTU_PUBLIC_NO_CODE=1）', async (t) => {
  await t.test('不再 401，入口直接放行并标记 noCode', async () => {
    const ctx = await setup(t, { publicNoCode: true, accessCode: '' });

    const pub = await ctx.raw('/api/public', { noCookies: true });
    assert.equal(pub.status, 200);
    assert.equal(pub.value.public, true);
    assert.equal(pub.value.authorized, true);
    assert.equal(pub.value.noCode, true);

    const state = await ctx.raw('/api/state', { noCookies: true });
    assert.equal(state.status, 200, '无访问码时不应再 401');
    assert.equal(state.value.noCode, true);
    assert.equal(state.value.authorized, true);

    // 仍然不能碰模型配置、看不到模型信息
    const config = await ctx.raw('/api/config', { method: 'POST', body: { baseUrl: 'https://x.example/v1', model: 'x', apiKey: 'y'.repeat(20) } });
    assert.equal(config.status, 403);
    for (const key of ['baseUrl', 'model', 'apiKey', 'verification']) {
      assert.equal(state.value[key], undefined, `无码公开 state 也不能包含 ${key}`);
    }

    const login = await ctx.raw('/api/session', { method: 'POST', body: { code: 'whatever-12chars' } });
    assert.equal(login.status, 400);
    assert.match(login.value.error, /没有启用访问码/);
  });

  await t.test('按来源 IP 记账：换 Cookie 也绕不过额度', async () => {
    const ctx = await setup(t, { publicNoCode: true, accessCode: '', ipDailyCalls: 2 });
    const csrfToken = ctx.csrf;

    const first = await ctx.raw('/api/jobs', { method: 'POST', body: { trip } });
    assert.equal(first.status, 202);
    const job = await waitJob(ctx, first.value.jobId);
    assert.equal(job.status, 'completed');
    assert.equal(ctx.upstream.calls.length, 2);

    // 换一个全新浏览器（不带任何 Cookie）继续请求，仍被同一个 IP 额度挡住
    const fresh = await ctx.raw('/api/plan', {
      method: 'POST',
      body: { trip },
      noCookies: true,
      headers: { 'X-Huantu-CSRF': csrfToken },
    });
    assert.equal(fresh.status, 429);
    assert.match(fresh.value.error, /额度/);
    assert.equal(ctx.upstream.calls.length, 2, '超额后不应再调用模型');
  });

  await t.test('无码模式下 Host 白名单与 CSRF 依然生效', async () => {
    const ctx = await setup(t, { publicNoCode: true, accessCode: '' });

    const evil = await ctx.httpReq('/api/public', { headers: { Host: 'evil.example.net' } });
    assert.equal(evil.status, 403, '无码不等于不校验 Host');

    const allowed = await ctx.httpReq('/api/public', { headers: { Host: PUBLIC_HOST } });
    assert.equal(allowed.status, 200);

    const noCsrf = await ctx.raw('/api/jobs', { method: 'POST', body: { trip }, headers: { 'X-Huantu-CSRF': 'bad' } });
    assert.equal(noCsrf.status, 403, '无码仍然校验 CSRF');
  });
});

test('监听地址归一化：默认只监听本机，显式配置才绑公网网卡', () => {
  assert.equal(resolveBindHost(undefined), '127.0.0.1');
  assert.equal(resolveBindHost(''), '127.0.0.1');
  assert.equal(resolveBindHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveBindHost('0.0.0.0'), '0.0.0.0');
  assert.equal(resolveBindHost('::'), '::');
});
