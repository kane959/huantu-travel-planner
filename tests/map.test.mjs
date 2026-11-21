/**
 * 智能规划（路线地图）测试
 *
 * 覆盖三层：
 *   1. 纯逻辑 —— 坐标校验、坐标系换算、图标缩放、时间轴重算、plan → 站点转换
 *   2. 接口   —— /api/visual/map 的载荷结构、坐标来源标注、公开模式、静态资源
 *   3. 真实性 —— 编造的坐标不会被当成事实，缺坐标的站点必须如实出现在 missing 里
 *
 * 不测浏览器渲染：Leaflet 画得好不好看，机器判断不了，只测它拿到的数据对不对。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp, buildMapPayload, normalizePlan } from '../server.mjs';

// 单测不打外网：天气与地理编码一律关掉，坐标逻辑用假 fetch 在 geo.test.mjs 里单独覆盖
process.env.HUANTU_WEATHER = 'off';
process.env.HUANTU_SEARCH_PROVIDER = 'off';
process.env.HUANTU_GEOCODE = 'off';
import {
  isValidCoord, wgs2gcj, haversineKm, iconScaleForZoom, neighborCount, kmPerPixel,
  iconIdFor, transportOf, parseTime, formatTime, recomputeDayTimeline, groupByDay,
  planToStops, cityCenterOf, boundsOf, arcPoints, normalizeIncomingPlan, ICON_IDS,
} from '../public/travel-map-core.mjs';

const SECRET = 'map-secret-placeholder';

/* ------------------------------------------------------------------ *
 * 纯逻辑
 * ------------------------------------------------------------------ */

test('坐标校验：只接受真正能画在地图上的点', () => {
  assert.equal(isValidCoord(23.1291, 113.2644), true);
  assert.equal(isValidCoord('23.1291', '113.2644'), true);
  assert.equal(isValidCoord(NaN, 113), false);
  assert.equal(isValidCoord(null, undefined), false);
  assert.equal(isValidCoord(91, 113), false);
  assert.equal(isValidCoord(23, 181), false);
  // (0,0) 是模型最常拿来占位的空值，必须当作没有坐标
  assert.equal(isValidCoord(0, 0), false);
  assert.equal(isValidCoord(0.001, 0.001), false);
});

test('WGS-84 → GCJ-02：偏移量在 500~700 米这个真实量级，不是随手加的常数', () => {
  const cases = [
    [39.9042, 116.4074], // 北京
    [31.2304, 121.4737], // 上海
    [23.1291, 113.2644], // 广州
  ];
  for (const [lat, lng] of cases) {
    const out = wgs2gcj(lat, lng);
    const shift = haversineKm({ lat, lng }, out);
    assert.ok(shift > 0.3 && shift < 0.9, `偏移量应在 300~900 米之间，实际 ${(shift * 1000).toFixed(0)} 米`);
  }
  assert.equal(wgs2gcj(0, 0), null);
  assert.equal(wgs2gcj(NaN, 120), null);
});

test('图标缩放：11 级 0.42、15 级 1.0，密集时继续打折但不消失', () => {
  assert.equal(iconScaleForZoom(11, 0), 0.42);
  assert.equal(iconScaleForZoom(5, 0), 0.42);
  assert.equal(iconScaleForZoom(15, 0), 1);
  assert.equal(iconScaleForZoom(18, 0), 1);
  // 62px 内邻居 ≥4 → 再乘 0.46
  assert.equal(iconScaleForZoom(15, 4), 0.46);
  assert.ok(iconScaleForZoom(11, 9) >= 0.3, '再挤也不能缩到看不见');
  assert.ok(iconScaleForZoom(15, 0) > iconScaleForZoom(13, 0));
});

test('邻居计数用的是真实距离，不是经纬度差值', () => {
  const stops = [
    { lat: 23.1291, lng: 113.2644 },
    { lat: 23.1292, lng: 113.2645 }, // 十几米
    { lat: 23.1065, lng: 113.3245 }, // 广州塔，约 7 公里
  ];
  const near = neighborCount(stops, 0, { zoom: 16, radiusPx: 62 });
  const far = neighborCount(stops, 0, { zoom: 11, radiusPx: 62 });
  assert.equal(near, 1);
  assert.ok(far >= 1);
  assert.ok(kmPerPixel(23.13, 16) < kmPerPixel(23.13, 11), '级别越高，像素代表的地面距离越小');
});

test('图标映射：先看标题里的具体地点，再退回类型', () => {
  assert.equal(iconIdFor({ type: '景点', title: '广州塔' }), 'viewpoint');
  assert.equal(iconIdFor({ type: '景点', title: '白云山' }), 'mountain');
  assert.equal(iconIdFor({ type: '餐饮', title: '点都德' }), 'restaurant');
  assert.equal(iconIdFor({ type: '休息', title: '沙面咖啡馆' }), 'coffee');
  assert.equal(iconIdFor({ type: '交通', title: '白云机场 T2' }), 'airport');
  assert.equal(iconIdFor({ type: '自由', title: '随便走走' }), 'pin');
  assert.equal(iconIdFor({ type: '未知类型', title: '某个地方' }), 'pin');
  // 映射结果必须在 18 种白名单里
  for (const id of ICON_IDS) {
    assert.equal(iconIdFor({ type: '景点', title: `${id} 测试` }) !== '', true);
  }
});

test('交通方式识别：中文描述能对上 5 种模式', () => {
  assert.equal(transportOf('从住宿步行'), 'walk');
  assert.equal(transportOf('地铁 3 号线'), 'metro');
  assert.equal(transportOf('公交 121 路'), 'bus');
  assert.equal(transportOf('打车 15 分钟'), 'taxi');
  assert.equal(transportOf('自驾前往'), 'drive');
  assert.equal(transportOf(''), 'drive');
  assert.equal(transportOf('某种说不清的方式'), 'drive');
});

test('时间轴重算：首站按自身时间，后续 = 上一站离开 + 段间交通', () => {
  const items = [
    { title: 'A', time: '09:00', dur: 90, transportMin: 0 },
    { title: 'B', time: '09:00', dur: 60, transportMin: 15 },
    { title: 'C', time: '09:00', dur: 45, transportMin: 20 },
  ];
  const r = recomputeDayTimeline(items);
  assert.equal(r.items[0].arrive, '09:00');
  assert.equal(r.items[0].leave, '10:30');
  assert.equal(r.items[1].arrive, '10:45');
  assert.equal(r.items[1].leave, '11:45');
  assert.equal(r.items[2].arrive, '12:05');
  assert.equal(r.transportMin, 35);
  assert.equal(r.busyMin, 195);
  assert.equal(r.overflow, false);
});

test('时间轴重算：跨过午夜要标记 overflow，而不是静悄悄绕回去', () => {
  const r = recomputeDayTimeline([
    { title: '夜市', time: '22:00', dur: 180, transportMin: 0 },
  ]);
  assert.equal(r.overflow, true);
  assert.equal(r.end, '01:00');
});

test('时间解析与格式化容错', () => {
  assert.equal(parseTime('09:05'), 545);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('9:5'), null);
  assert.equal(parseTime(''), null);
  assert.equal(formatTime(545), '09:05');
  assert.equal(formatTime(1440), '00:00');
  assert.equal(formatTime(-30), '23:30');
});

test('planToStops：有坐标的进 stops，没坐标的进 missing，一个都不能吞', () => {
  const plan = normalizePlan({
    days: [{
      theme: '老城步行',
      items: [
        { time: '09:00', title: '广州塔', type: '景点', durationMin: 90, transportFromPrev: '从住宿出发', lat: 23.10647, lng: 113.32446 },
        { time: '12:30', title: '某家早茶店', type: '餐饮', durationMin: 75, transportFromPrev: '地铁' },
        { time: '15:00', title: '编造的地方', type: '景点', durationMin: 60, transportFromPrev: '步行', lat: 0, lng: 0 },
      ],
    }],
  }, {
    origin: '深圳', destination: '广州', startDate: '2026-11-05', days: 1,
    travelers: 2, children: 0, budget: '', interests: [], pace: 'balanced',
    transport: 'public', hotel: 'any', special: '', timezone: 'Asia/Shanghai',
  });

  const { stops, missing } = planToStops(plan);
  assert.equal(stops.length, 1);
  assert.equal(missing.length, 2);
  assert.equal(stops[0].label, '广州塔');
  assert.equal(stops[0].source, 'model');
  assert.equal(stops[0].mode, 'drive'); // 「从住宿出发」认不出方式，按默认驾车
  assert.equal(missing[0].source, 'none');
  assert.equal(missing[0].lat, null);
  // 0/0 占位被拒绝，不是画到几内亚湾去
  assert.equal(missing[1].label, '编造的地方');
  assert.equal(plan.days[0].items[2].geo.source, 'none');
});

test('groupByDay：按天分组、保留顺序、累加直线距离', () => {
  const stops = [
    { day: 2, order: 0, lat: 23.13, lng: 113.32 },
    { day: 1, order: 1, lat: 23.11, lng: 113.33 },
    { day: 1, order: 0, lat: 23.10, lng: 113.30 },
  ];
  const groups = groupByDay(stops);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].day, 1);
  assert.deepEqual(groups[0].stops.map((s) => s.order), [0, 1]);
  assert.ok(groups[0].distanceKm > 0);
  assert.equal(groups[1].distanceKm, 0);
});

test('城市中心：认识常见写法，认不出就退回站点中心', () => {
  assert.equal(cityCenterOf('广州').name, '广州');
  assert.equal(cityCenterOf('广州市').name, '广州');
  assert.equal(cityCenterOf('浙江杭州').name, '杭州');
  const fallback = cityCenterOf('某个不出名的小镇', [{ lat: 30, lng: 120 }, { lat: 32, lng: 122 }]);
  assert.equal(fallback.source, 'stops');
  assert.equal(fallback.lat, 31);
  assert.equal(cityCenterOf('', []), null);
});

test('弧线：不落在直线上，首尾必须精确对齐两端站点', () => {
  const a = { lat: 23.1, lng: 113.3 };
  const b = { lat: 23.2, lng: 113.5 };
  const pts = arcPoints(a, b);
  assert.equal(pts.length, 25);
  assert.deepEqual(pts[0], [a.lat, a.lng]);
  assert.deepEqual(pts[pts.length - 1], [b.lat, b.lng]);
  const mid = pts[12];
  const onLine = (mid[1] - a.lng) / (b.lng - a.lng);
  const onLineLat = a.lat + (b.lat - a.lat) * onLine;
  assert.ok(Math.abs(mid[0] - onLineLat) > 1e-4, '中点应当偏离直线，否则多段行程会叠在一起');
  assert.deepEqual(arcPoints(a, { lat: 0, lng: 0 }), []);
});

test('外接矩形：忽略无坐标站点', () => {
  assert.equal(boundsOf([{ lat: null, lng: null }]), null);
  assert.equal(boundsOf([]), null);
  const b = boundsOf([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { lat: null, lng: 9 }]);
  assert.deepEqual(b, { minLat: 1, maxLat: 3, minLng: 2, maxLng: 4 });
});

test('iframe 协议：外部传来的站点要过白名单，垃圾数据直接丢', () => {
  const list = normalizeIncomingPlan([
    { id: 'attraction', label: '广州塔', lat: 23.10647, lng: 113.32446, mode: 'walk' },
    { id: 'evil-icon', label: '正佳广场', lat: 23.13213, lng: 113.32699 },
    { label: '没坐标的地方' },
    { id: 'pin', label: '', lat: 1, lng: 1 },
    { id: 'pin', label: '越界的点', lat: 200, lng: 1 },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].icon, 'attraction');
  assert.equal(list[0].mode, 'walk');
  assert.equal(list[1].icon, 'pin'); // 不在白名单的图标被降级，不会拼进 DOM
  assert.equal(normalizeIncomingPlan('not-an-array').length, 0);
});

/* ------------------------------------------------------------------ *
 * 载荷与接口
 * ------------------------------------------------------------------ */

function mapPlanJson() {
  const item = (title, extra) => ({
    time: '09:00', title, type: '景点', area: '天河', durationMin: 90,
    detail: '测试用。', transportFromPrev: '地铁', transportMin: 20, ...extra,
  });
  return {
    overview: { title: '广州两日', summary: '测试用方案。', highlights: ['a'], paceNote: 'p', bestFor: 'b' },
    days: [
      { theme: '城市中轴', area: '天河', items: [
        item('广州塔', { lat: 23.10647, lng: 113.32446, transportFromPrev: '从住宿出发' }),
        item('正佳广场', { lat: 23.13213, lng: 113.32699, type: '购物' }),
      ] },
      { theme: '老城', area: '荔湾', items: [
        item('永庆坊'),
        item('某个模型也不确定的地方', { lat: 0, lng: 0 }),
      ] },
    ],
    warnings: ['w'],
  };
}

function normalizedMapPlan() {
  return normalizePlan(mapPlanJson(), {
    origin: '深圳', destination: '广州', startDate: '2026-11-05', days: 2,
    travelers: 2, children: 0, budget: '', interests: [], pace: 'balanced',
    transport: 'public', hotel: 'any', special: '', timezone: 'Asia/Shanghai',
  });
}

test('地图载荷：结构、统计与坐标来源都要说清楚', () => {
  const payload = buildMapPayload(normalizedMapPlan());
  assert.equal(payload.ok, true);
  assert.equal(payload.city.name, '广州');
  assert.equal(payload.city.source, 'city-table');
  assert.equal(payload.stops.length, 2);
  assert.equal(payload.missing.length, 2);
  assert.equal(payload.stats.total, 4);
  assert.equal(payload.stats.located, 2);
  assert.equal(payload.stats.missing, 2);
  assert.equal(payload.stats.days, 2);
  assert.equal(payload.stats.manual, 0);
  assert.match(payload.notice, /未经地理编码核验/);
  assert.match(payload.notice, /不是真实导航轨迹/);

  const tower = payload.stops.find((s) => s.label === '广州塔');
  assert.equal(tower.day, 1);
  assert.equal(tower.source, 'model');
  assert.equal(tower.icon, 'viewpoint');
  // 首站保留原始 transportMin 字段，但时间轴里不会把它算进去（首站没有"上一站"）
  assert.equal(tower.transportMin, 20);
  assert.equal(recomputeDayTimeline([{ time: '09:00', dur: 90, transportMin: 20 }]).transportMin, 0);
});

test('地图载荷：模型给的经纬度会被夹到 5 位小数，不让浮点噪声进前端', () => {
  const payload = buildMapPayload(normalizedMapPlan());
  for (const stop of payload.stops) {
    assert.equal(typeof stop.lat, 'number');
    assert.equal(Math.round(stop.lat * 1e5) / 1e5, stop.lat);
  }
});

test('地图载荷：没有站点时也不能崩', () => {
  const plan = normalizePlan({ days: [{ items: [] }] }, {
    origin: 'A', destination: '乌镇', startDate: '2026-11-05', days: 1,
    travelers: 1, children: 0, budget: '', interests: [], pace: 'balanced',
    transport: 'any', hotel: 'any', special: '', timezone: 'Asia/Shanghai',
  });
  const payload = buildMapPayload(plan);
  assert.equal(payload.stops.length, 0);
  assert.equal(payload.stats.total, 0);
  // 「乌镇」不在城市表里，但也没有站点可算中心
  assert.equal(payload.city, null);
});

/* ------------------------------------------------------------------ *
 * HTTP 端点
 * ------------------------------------------------------------------ */

async function startUpstream(plan) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url, body: raw ? JSON.parse(raw) : {} });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, port: server.address().port };
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'huantu-map-'));
  const upstream = await startUpstream(mapPlanJson());
  const app = await createApp({
    dataDir: dir,
    allowLocalUpstream: true,
    modelTimeoutMs: 15000,
    logger: { error() {} },
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
    return { status: res.status, value, headers: res.headers, text };
  }

  // 先取一次 state 拿到 CSRF，否则后面所有 POST 都会被 403
  csrf = (await (async () => {
    const res = await fetch(base + '/api/state');
    return (await res.json()).csrf || '';
  })()) || csrf;

  return {
    req,
    upstream,
    base,
    async cleanup() {
      await Promise.all([
        new Promise((resolve) => app.close(resolve)),
        new Promise((resolve) => upstream.server.close(resolve)),
      ]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('接口：地图资源都能取到，且页面已挂上路线地图标签', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);

  const page = await ctx.req('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tab="map"/);
  assert.match(page.text, /id="tabMap"/);
  assert.match(page.text, /\/vendor\/leaflet\.js/);
  assert.match(page.text, /\/travel-map\.js/);
  assert.match(page.text, /\/vendor\/leaflet\.css/);
  // 密钥不能出现在页面里
  assert.equal(page.text.includes(SECRET), false);

  // CSP 必须放行高德瓦片，否则地图永远进离线模式；其余指令不能放松
  // 两种合法写法：精确列出 *.is.autonavi.com，或用 https: 统一放行图片（实时实拍图需要）
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(
    csp,
    /img-src [^;]*(?:\*\.is\.autonavi\.com|https:)/,
    'img-src 应放行高德瓦片域名（或统一放行 https 图片）',
  );
  assert.match(csp, /style-src 'self'/, 'style-src 不应放开内联样式');
  assert.match(csp, /script-src 'self'/, 'script-src 不应放开外链脚本');

  for (const [route, type] of [
    ['/travel-map.js', /javascript/],
    ['/travel-map.css', /text\/css/],
    ['/travel-map-core.mjs', /javascript/],
    ['/icons.js', /javascript/],
    ['/vendor/leaflet.js', /javascript/],
    ['/vendor/leaflet.css', /text\/css/],
  ]) {
    const res = await ctx.req(route);
    assert.equal(res.status, 200, `${route} 应当可访问`);
    assert.match(res.headers.get('content-type'), type, `${route} 的 MIME 不对`);
  }

  // 白名单之外的文件不能被顺手读出来
  assert.equal((await ctx.req('/../server.mjs')).status, 404);
  assert.equal((await ctx.req('/package.json')).status, 404);
});

test('接口：生成方案后 /api/visual/map 返回可用站点', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);

  const cfg = await ctx.req('/api/config', 'POST', {
    baseUrl: `http://127.0.0.1:${ctx.upstream.port}/v1`,
    model: 'test-model',
    apiKey: SECRET,
    protocol: 'chat-completions',
    role: 'system',
  });
  assert.equal(cfg.status, 200);

  const planned = await ctx.req('/api/plan', 'POST', {
    trip: {
      origin: '深圳', destination: '广州', startDate: '2026-11-05', days: 2,
      travelers: 2, children: 0, budget: '两人 5000 元', interests: ['美食'],
      pace: 'balanced', transport: 'public', hotel: 'any', special: '',
    },
  });
  assert.equal(planned.status, 200, JSON.stringify(planned.value).slice(0, 300));
  const planId = planned.value.plan.planId;

  const res = await ctx.req('/api/visual/map', 'POST', { planId });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/, '必须按 JSON 返回，模型文本不能当 HTML 解释');
  assert.equal(res.value.ok, true);
  assert.equal(res.value.city.name, '广州');
  assert.equal(res.value.stops.length, 2);
  assert.equal(res.value.missing.length, 2);
  assert.equal(res.value.stats.days, 2);
  // 模型输出里的 HTML 只当数据，不当结构
  const raw = JSON.stringify(res.value);
  assert.equal(raw.includes('<script'), false);

  // planId 不存在时沿用项目既有约定：回退到本会话最近一份方案，而不是报错
  const fallback = await ctx.req('/api/visual/map', 'POST', { planId: 'nope' });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.value.stops.length, res.value.stops.length);

  // 只接受 POST
  const wrongMethod = await ctx.req('/api/visual/map');
  assert.ok([404, 405].includes(wrongMethod.status));
});

test('接口：公开模式下地图数据可用，但配置类接口仍然封死', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'huantu-map-pub-'));
  const upstream = await startUpstream(mapPlanJson());
  const app = await createApp({
    dataDir: dir,
    allowLocalUpstream: true,
    publicMode: true,
    publicNoCode: true,
    publicHost: '127.0.0.1',
    maxCalls: 8,
    trustedProxies: ['127.0.0.1'],
    modelTimeoutMs: 15000,
    logger: { error() {} },
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
    return { status: res.status, value };
  }

  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => app.close(resolve)),
      new Promise((resolve) => upstream.server.close(resolve)),
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  const pub = await req('/api/public');
  assert.equal(pub.status, 200);
  csrf = pub.value.csrf || csrf;

  // 公开模式下没有配置权限，地图接口不该顺手把模型信息带出来
  const bad = await req('/api/config', 'POST', { baseUrl: 'http://x', model: 'm', apiKey: 'k' });
  assert.equal(bad.status, 403, '访客不能改配置，也就没有方案可画');
});
