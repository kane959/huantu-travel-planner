/**
 * 坐标可信度与结构化费用测试
 *
 * 覆盖两件事：
 *   1. 坐标三档 —— 离谱坐标被丢弃、空坐标走地理编码兜底、补到的还要再过一次半径校验
 *   2. 费用核算 —— 模型给的数字不可信，一律后端重新求和，并与用户预算比对
 *
 * 不打外网：所有地理编码请求都由桩 fetch 应答。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rejectFarStops,
  fillMissingGeo,
  geocodeSpot,
  resetGeocodeState,
  parseBudgetText,
  computeBudgetCheck,
  normalizeBudget,
  normalizePlan,
} from '../server.mjs';
import { wgs2gcj } from '../public/travel-map-core.mjs';

/* ---------------- 桩 fetch ---------------- */

const HANGZHOU = { lat: 30.2741, lng: 120.1551, name: '杭州', source: 'city-table' };

function stubFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    return handler(u, opts);
  };
  return {
    calls,
    restore() { globalThis.fetch = real; },
  };
}

const jsonResponse = (data) => ({
  ok: true,
  status: 200,
  async json() { return data; },
  async text() { return JSON.stringify(data); },
});

void wgs2gcj;

/* ---------------- 第一档：离谱坐标 ---------------- */

test('坐标合理性：偏离城市中心 50km 以上的坐标被丢弃', () => {
  const plan = {
    days: [{
      day: 1,
      items: [
        { title: '灵隐寺', geo: { lat: 30.2408, lng: 120.0990, source: 'model' } },
        { title: '外滩', geo: { lat: 31.2400, lng: 121.4900, source: 'model' } },
      ],
    }],
  };
  const { rejected, checked } = rejectFarStops(plan, HANGZHOU);
  assert.equal(checked, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].title, '外滩');
  assert.ok(rejected[0].km > 100, '上海到杭州应在 100km 以上');

  // 杭州本地的坐标保留原样
  assert.deepEqual(plan.days[0].items[0].geo, { lat: 30.2408, lng: 120.099, source: 'model' });
  // 被丢弃的置空并标注原因，前端可据此显示「坐标异常已丢弃」
  assert.equal(plan.days[0].items[1].geo.lat, null);
  assert.equal(plan.days[0].items[1].geo.source, 'rejected');
  assert.ok(plan.days[0].items[1].geo.rejectedKm > 100);
});

test('坐标合理性：用户手动定位永不被覆盖', () => {
  const plan = {
    days: [{ day: 1, items: [{ title: '我标的点', geo: { lat: 31.24, lng: 121.49, source: 'manual' } }] }],
  };
  const { rejected, checked } = rejectFarStops(plan, HANGZHOU);
  assert.equal(checked, 0, '手动定位不参与校验');
  assert.equal(rejected.length, 0);
  assert.equal(plan.days[0].items[0].geo.source, 'manual');
});

test('坐标合理性：没有城市中心时不做任何丢弃', () => {
  const plan = { days: [{ day: 1, items: [{ title: '某地', geo: { lat: 31.24, lng: 121.49, source: 'model' } }] }] };
  const { rejected, checked } = rejectFarStops(plan, null);
  assert.equal(checked, 0);
  assert.equal(rejected.length, 0);
  assert.equal(plan.days[0].items[0].geo.lat, 31.24);
});

/* ---------------- 第三档：地理编码兜底 ---------------- */

test('地理编码：高德返回的 GCJ-02 坐标原样采用', async () => {
  resetGeocodeState();
  const stub = stubFetch((url) => {
    assert.ok(url.startsWith('https://restapi.amap.com/v3/place/text?'));
    assert.ok(url.includes('keywords=%E7%81%B5%E9%9A%90%E5%AF%BA'), '中文地名应被 URL 编码');
    return jsonResponse({ status: '1', pois: [{ location: '120.0990,30.2408', name: '灵隐寺' }] });
  });
  try {
    const hit = await geocodeSpot('灵隐寺', '杭州', { amapKey: 'test-key' });
    assert.equal(hit.via, 'amap');
    assert.equal(hit.lat, 30.2408);
    assert.equal(hit.lng, 120.099);
  } finally {
    stub.restore();
  }
});

test('地理编码：高德不可用时回退 Nominatim，并把 WGS-84 转成 GCJ-02', async () => {
  resetGeocodeState();
  let amapHit = false;
  const stub = stubFetch((url) => {
    if (url.includes('restapi.amap.com')) {
      amapHit = true;
      return jsonResponse({ status: '0', info: 'INVALID_USER_KEY' });
    }
    assert.ok(url.startsWith('https://nominatim.openstreetmap.org/search?'));
    return jsonResponse([{ lat: '30.2408', lon: '120.0990', display_name: '灵隐寺, 西湖区, 杭州' }]);
  });
  try {
    const hit = await geocodeSpot('灵隐寺', '杭州', { amapKey: 'bad-key' });
    assert.equal(amapHit, true, '应先试高德');
    assert.equal(hit.via, 'nominatim');
    // 关键：不能把 WGS-84 直接当 GCJ-02 用，否则地图上偏 500 米以上
    assert.ok(Math.abs(hit.lat - 30.2408) > 0.0005, '纬度应经过偏移转换');
    assert.ok(Math.abs(hit.lng - 120.099) > 0.0005, '经度应经过偏移转换');
    assert.ok(Math.abs(hit.lat - 30.2408) < 0.02, '偏移量应在合理范围，不能离谱');
  } finally {
    stub.restore();
  }
});

test('地理编码：同一地名第二次直接用缓存，不再发请求', async () => {
  resetGeocodeState();
  const stub = stubFetch(() => jsonResponse({ status: '1', pois: [{ location: '120.1551,30.2741', name: '西湖' }] }));
  try {
    await geocodeSpot('西湖', '杭州', { amapKey: 'k' });
    const first = stub.calls.length;
    await geocodeSpot('西湖', '杭州', { amapKey: 'k' });
    assert.equal(stub.calls.length, first, '第二次应命中缓存');
  } finally {
    stub.restore();
  }
});

test('坐标补全：休息类时段不参与，补到的还要过半径校验', async () => {
  resetGeocodeState();
  const plan = {
    days: [{
      day: 1,
      items: [
        { title: '灵隐寺', type: '景点', geo: { lat: null, lng: null, source: 'none' } },
        { title: '午后休息', type: '休息', geo: { lat: null, lng: null, source: 'none' } },
        { title: '外滩', type: '景点', geo: { lat: null, lng: null, source: 'none' } },
      ],
    }],
  };
  const stub = stubFetch((url) => {
    const q = decodeURIComponent(url.split('keywords=')[1]?.split('&')[0] || '');
    if (q.includes('外滩')) {
      // 故意让地理编码把外滩匹配到上海：超出了杭州 50km 半径
      return jsonResponse({ status: '1', pois: [{ location: '121.4900,31.2400', name: '外滩' }] });
    }
    return jsonResponse({ status: '1', pois: [{ location: '120.0990,30.2408', name: '灵隐寺' }] });
  });
  try {
    const out = await fillMissingGeo(plan, {
      city: '杭州', center: HANGZHOU, amapKey: 'k',
    });
    assert.equal(out.attempted, 2, '休息项不该被算进补全范围');
    assert.equal(out.filled, 1);
    assert.equal(plan.days[0].items[0].geo.source, 'geocoded');
    assert.equal(plan.days[0].items[0].geo.lat, 30.2408);
    assert.equal(plan.days[0].items[1].geo.lat, null, '休息项保持无坐标');
    assert.equal(plan.days[0].items[2].geo.lat, null, '超出半径的补全结果应被丢弃');
  } finally {
    stub.restore();
  }
});

test('坐标补全：没有高德 key 时限制补全数量，避免拖慢生成', async () => {
  resetGeocodeState();
  const items = Array.from({ length: 9 }, (_, i) => ({
    title: `站点${i}`, type: '景点', geo: { lat: null, lng: null, source: 'none' },
  }));
  const plan = { days: [{ day: 1, items }] };
  const stub = stubFetch(() => jsonResponse([{ lat: '30.2408', lon: '120.0990', display_name: 'x' }]));
  try {
    const out = await fillMissingGeo(plan, { city: '杭州', center: HANGZHOU });
    assert.ok(out.attempted <= 4, `无高德 key 时最多补 4 个，实际 ${out.attempted}`);
    assert.equal(out.skipped, 9 - out.attempted);
  } finally {
    stub.restore();
  }
});

/* ---------------- 预算文本解析 ---------------- */

test('预算解析：总预算、人均、万元、未填写', () => {
  assert.deepEqual(parseBudgetText('两人合计 8000 元，不含机票').scope, 'total');
  assert.equal(parseBudgetText('两人合计 8000 元，不含机票').amount, 8000);

  assert.equal(parseBudgetText('人均 5000').scope, 'perPerson');
  assert.equal(parseBudgetText('人均 5000').amount, 5000);
  assert.equal(parseBudgetText('每人 3,000 元').amount, 3000);

  assert.equal(parseBudgetText('预算 1.2 万').amount, 12000);
  assert.equal(parseBudgetText('未填写').amount, null);
  assert.equal(parseBudgetText('').amount, null);
  assert.equal(parseBudgetText('不限').amount, null);
});

test('预算解析：同时出现「人均」与「合计」时以合计为准', () => {
  const p = parseBudgetText('两人合计 8000，人均 4000');
  assert.equal(p.scope, 'total');
  assert.equal(p.amount, 8000);
});

/* ---------------- 费用结构 ---------------- */

test('费用结构：模型的合计不可信，后端重新求各分类之和', () => {
  const b = normalizeBudget({
    perPerson: true,
    items: [
      { category: '交通', label: '往返高铁', amount: 800, basis: '二等座', confidence: '估' },
      { category: '住宿', label: '2 晚', amount: 1200.4, basis: '600×2÷2', confidence: '估' },
      { category: '门票', label: '灵隐寺', amount: 0, basis: '免票', confidence: '待核实' },
    ],
    estimatedTotal: 5000, // 模型算错了
  });
  assert.equal(b.estimatedTotal, 2000, '逐项求和应覆盖模型自报的合计');
  assert.equal(b.byCategory['交通'], 800);
  assert.equal(b.byCategory['住宿'], 1200);
  assert.equal(b.totalMismatch, true);
});

test('费用结构：分类缺失时归入「其他」，非法分类不进入求和', () => {
  const b = normalizeBudget({
    items: [
      { category: '购物', label: '伴手礼', amount: 300 },
      { category: '交通', label: '', amount: 100 },
    ],
  });
  assert.equal(b.byCategory['其他'], 300);
  assert.equal(b.byCategory['交通'], 100);
  assert.equal(b.estimatedTotal, 400);
});

/* ---------------- 预算比对 ---------------- */

test('预算比对：人均费用乘人数后与「两人合计」预算比，超支明确提示', () => {
  const budget = normalizeBudget({
    perPerson: true,
    items: [{ category: '住宿', label: '2 晚', amount: 1600, basis: '800×2÷2' }],
  });
  const check = computeBudgetCheck(budget, { travelers: 2, budget: '两人合计 2000 元' });
  assert.equal(check.scope, 'total');
  assert.equal(check.estimatedPerPerson, 1600);
  assert.equal(check.estimatedTotal, 3200);
  assert.equal(check.limitTotal, 2000);
  assert.equal(check.over, true);
  assert.equal(check.overBy, 1200);
  assert.equal(check.level, 'over');
  assert.match(check.headline, /超出预算/);
  assert.match(check.advice, /住宿/);
});

test('预算比对：人均预算口径不会被误当成总预算', () => {
  const budget = normalizeBudget({
    perPerson: true,
    items: [{ category: '交通', amount: 1200 }, { category: '住宿', amount: 900 }],
  });
  const check = computeBudgetCheck(budget, { travelers: 2, budget: '人均 2500' });
  assert.equal(check.scope, 'perPerson');
  assert.equal(check.limitTotal, 5000, '人均 2500 × 2 人');
  assert.equal(check.estimatedTotal, 4200);
  assert.equal(check.level, 'ok');
  assert.match(check.headline, /结余/);
});

test('预算比对：按整团报价时不再乘人数；未填预算时不做判断', () => {
  const budget = normalizeBudget({ perPerson: false, items: [{ category: '交通', amount: 3000 }] });
  const check = computeBudgetCheck(budget, { travelers: 3, budget: '合计 4000' });
  assert.equal(check.estimatedTotal, 3000);
  assert.equal(check.estimatedPerPerson, 1000);
  assert.equal(check.level, 'ok');

  const none = computeBudgetCheck(budget, { travelers: 3, budget: '未填写' });
  assert.equal(none.provided, false);
  assert.equal(none.level, 'none');
  assert.equal(none.headline, '');
});

test('预算比对：贴近上限时判为 tight，而不是简单二分', () => {
  const budget = normalizeBudget({ perPerson: false, items: [{ category: '住宿', amount: 9600 }] });
  const check = computeBudgetCheck(budget, { travelers: 2, budget: '合计 10000' });
  assert.equal(check.level, 'tight');
  assert.match(check.headline, /贴近预算上限/);
});

/* ---------------- 与 plan 的集成 ---------------- */

const BASE_INPUT = {
  origin: '上海',
  destination: '杭州',
  startDate: '2026-11-10',
  endDate: '2026-11-11',
  days: 2,
  travelers: 2,
  children: 0,
  budget: '两人合计 2000 元',
  interests: [],
  pace: 'balanced',
  hotelPreference: 'comfort',
  transport: 'public',
  special: '',
  timezone: 'Asia/Shanghai',
};

test('集成：超支会写进 warnings，费用卡片与提醒口径一致', () => {
  const plan = normalizePlan({
    overview: { title: '杭州两日' },
    days: [{ theme: '西湖', items: [{ time: '09:00', title: '断桥', type: '景点' }] }, { theme: '灵隐', items: [] }],
    budget: {
      perPerson: true,
      items: [
        { category: '住宿', amount: 1200, basis: '2 晚 ÷ 2 人' },
        { category: '餐饮', amount: 400, basis: '估算' },
      ],
      estimatedTotal: 1600,
    },
  }, BASE_INPUT);

  assert.equal(plan.budgetCheck.level, 'over');
  assert.equal(plan.budgetCheck.estimatedTotal, 3200);
  assert.ok(plan.warnings.some((w) => w.includes('超出预算')), '超支必须出现在提醒里');
  assert.ok(plan.warnings.some((w) => w.includes('住宿')), '提醒里要点出超支最大的类别');
});

test('集成：预算内不产生超支提醒，但仍保留费用结构', () => {
  const plan = normalizePlan({
    overview: { title: '杭州两日' },
    days: [{ items: [] }, { items: [] }],
    budget: { perPerson: true, items: [{ category: '餐饮', amount: 300, basis: '估算' }] },
  }, BASE_INPUT);

  assert.equal(plan.budgetCheck.level, 'ok');
  assert.equal(plan.budgetCheck.estimatedTotal, 600);
  assert.ok(!plan.warnings.some((w) => w.includes('超出预算')));
  assert.equal(plan.budget.byCategory['餐饮'], 300);
});

test('集成：模型没给费用时结构仍然可渲染，且不会谎称「在预算内」', () => {
  const plan = normalizePlan({ days: [{ items: [] }, { items: [] }] }, BASE_INPUT);
  assert.equal(plan.budget.estimatedTotal, 0);
  assert.equal(plan.budget.items.length, 0);
  assert.equal(plan.budgetCheck.level, 'unknown');
  assert.match(plan.budgetCheck.headline, /费用未估出/);
  // 没有明细时如实说没估出来，不编造「住宿占比多少」这类建议
  assert.match(plan.budgetCheck.advice, /没有给出可求和的费用明细/);
  assert.ok(!/占比|最大头/.test(plan.budgetCheck.advice));
});
