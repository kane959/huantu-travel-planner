// 实时数据层（联网搜索 / 天气）的纯函数与容错行为测试。全部离线，不依赖网络。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  destinationTokens,
  filterRelevantHits,
  buildSearchQueriesByCategory,
  getTripWeather,
  fetchHistoricalSamePeriod,
  pickSpotFacts,
  collectSpotFacts,
  searchDeepseek,
  searchBocha,
  extractOgImage,
  isConcretePlace,
  collectPlacePhotos,
  searchZhipu,
  searchBing,
  searchSogou,
  resetSearchState,
  runWebSearch,
  SEARCH_PROVIDER_LABEL,
} from '../server.mjs';

// 造一个假 fetch，返回指定 JSON，并把请求记下来
function fakeFetch(payload, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  fn.calls = calls;
  return fn;
}

test('destinationTokens：能从「国家+城市」里剥出城市名', () => {
  assert.deepEqual(destinationTokens('京都'), ['京都']);
  assert.ok(destinationTokens('日本京都').includes('京都'));
  assert.ok(destinationTokens('泰国曼谷').includes('曼谷'));
  assert.ok(destinationTokens('日本东京都').includes('东京'));
  assert.deepEqual(destinationTokens(''), []);
});

test('filterRelevantHits：剔除与目的地完全无关的结果', () => {
  const junk = [
    { query: '京都 景点', results: [
      { title: 'New York Lottery: Official Site', url: 'https://nylottery.ny.gov', snippet: 'Winner gallery' },
      { title: '京都需预约景点', url: 'https://kyoto.travel/cn', snippet: '提前规划行程' },
      { title: '京都交通局', url: 'https://www.city.kyoto.lg.jp/kotsu/', snippet: '市巴士' },
      { title: '京都酒店推荐', url: 'https://hotels.ctrip.com/hotel/kyoto734', snippet: '评分 4.6' },
    ] },
  ];
  const out = filterRelevantHits(junk, '日本京都');
  assert.equal(out[0].results.length, 3);
  assert.ok(!out[0].results.some((r) => r.url.includes('nylottery')));
});

test('filterRelevantHits：全部无关时保留原结果，不清零', () => {
  const groups = [{ query: 'q', results: [{ title: 'AAA', url: 'https://a.example', snippet: 'bbb' }] }];
  const out = filterRelevantHits(groups, '日本京都');
  assert.equal(out[0].results.length, 1);
});

test('filterRelevantHits：过滤后不足 3 条就退回原结果，避免削太狠', () => {
  const groups = [{ query: 'q', results: [
    { title: '京都景点 A', url: 'https://k1', snippet: 'x' },
    { title: '京都景点 B', url: 'https://k2', snippet: 'x' },
    { title: '无关页面', url: 'https://junk', snippet: 'y' },
    { title: '无关页面2', url: 'https://junk2', snippet: 'y' },
  ] }];
  const out = filterRelevantHits(groups, '京都');
  assert.equal(out[0].results.length, 4, '只剩 2 条相关时应保留全部 4 条');
});

test('filterRelevantHits：null / 空数组不崩', () => {
  assert.equal(filterRelevantHits(null, '京都'), null);
  assert.deepEqual(filterRelevantHits([], '京都'), []);
  assert.deepEqual(filterRelevantHits([{ results: [] }], ''), [{ results: [] }]);
});

test('buildSearchQueriesByCategory：三类各两条，且带上目的地', () => {
  const q = buildSearchQueriesByCategory({ destination: '日本京都', budget: '中等', hotelPreference: 'comfort' });
  assert.equal(q.attractions.length, 2);
  assert.equal(q.hotels.length, 2);
  assert.equal(q.transport.length, 2);
  const all = [...q.attractions, ...q.hotels, ...q.transport].join(' ');
  assert.ok(all.includes('日本京都'));
  assert.ok(q.hotels.join(' ').includes('舒适型'));
  // 景点查询不应包含「价格」二字（会误搜到国内票务站）
  assert.ok(!q.attractions.join(' ').includes('价格'));
});

test('buildSearchQueriesByCategory：缺目的地时返回空查询', () => {
  const q = buildSearchQueriesByCategory({});
  assert.deepEqual(q, { attractions: [], hotels: [], transport: [] });
});

test('getTripWeather：地名无法识别时降级为 null，不抛错也不伪造数据', async () => {
  const warnings = [];
  const w = await getTripWeather('', '2026-11-10', '2026-11-14', { warn: (m) => warnings.push(m) });
  assert.equal(w, null);
});

/* ---------- 国产搜索 provider（DeepSeek / 博查 / 智谱）---------- */

test('searchDeepseek：打到 /v1/tools/search，Bearer 鉴权，优先用 summary 当摘要', async () => {
  const f = fakeFetch({
    results: [
      { title: '清水寺 官网', url: 'https://www.kiyomizu.or.jp/', summary: '成人 400 日元，秋季夜场另行公告。', snippet: '短摘要', content: '正文', site_name: '清水寺', site_icon: 'https://cdn.deepseek.com/site-icons/kiyomizu.or.jp' },
      { title: '伏见稻荷大社', url: 'https://inari.jp/', snippet: '境内全天开放，免费。' },
    ],
  });
  const out = await searchDeepseek(['京都 景点 门票'], { apiKey: 'sk-test', fetchImpl: f });

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(f.calls[0].opts.body);
  assert.equal(body.query, '京都 景点 门票');
  assert.ok(body.count >= 1 && body.count <= 50);

  assert.equal(out[0].query, '京都 景点 门票');
  assert.equal(out[0].results.length, 2);
  assert.equal(out[0].results[0].snippet, '成人 400 日元，秋季夜场另行公告。');
  // 没有 summary 时退回 snippet
  assert.equal(out[0].results[1].snippet, '境内全天开放，免费。');
  // 来源站点与图标要一并带出来（前端在标题旁边显示）
  assert.equal(out[0].results[0].site, '清水寺');
  assert.match(out[0].results[0].icon, /site-icons/);
  // 没给 icon 就留空，前端退化成首字母块；site 缺失时用域名兜底
  assert.equal(out[0].results[1].icon, '');
  assert.equal(out[0].results[1].site, 'inari.jp');
});

test('searchDeepseek：baseUrl 填了带 /v1 的地址也不会拼出 /v1/v1', async () => {
  const f = fakeFetch({ results: [] });
  await searchDeepseek(['q'], { apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1/', fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://api.deepseek.com/v1/tools/search');
});

test('searchBocha：解析 data.webPages.value，用 name/url/summary', async () => {
  const f = fakeFetch({
    code: 200,
    data: { webPages: { value: [
      { name: '京都酒店推荐', url: 'https://hotels.ctrip.com/hotel/kyoto734', summary: '评分 4.6，近京都站。', snippet: 's', siteName: '携程', siteIcon: 'https://ak-d.tripcdn.com/images/logo.png' },
    ] } },
  });
  const out = await searchBocha(['京都 酒店 评价'], { apiKey: 'k', fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://api.bochaai.com/v1/web-search');
  assert.equal(out[0].results[0].title, '京都酒店推荐');
  assert.equal(out[0].results[0].url, 'https://hotels.ctrip.com/hotel/kyoto734');
  assert.equal(out[0].results[0].snippet, '评分 4.6，近京都站。');
  assert.equal(out[0].results[0].site, '携程');
  assert.match(out[0].results[0].icon, /tripcdn/);
});

test('searchBocha：业务错误码（code != 200）抛错，由 runWebSearch 兜成 null', async () => {
  const f = fakeFetch({ code: 403, msg: 'no quota' });
  await assert.rejects(() => searchBocha(['q'], { apiKey: 'k', fetchImpl: f }), /bocha 403/);
  const r = await runWebSearch(['q'], { provider: 'bocha', apiKey: 'k', fetchImpl: f });
  assert.equal(r, null);
});

test('searchZhipu：解析 search_result，link 映射成 url', async () => {
  const f = fakeFetch({
    search_result: [
      { title: '京都市交通局', link: 'https://www.city.kyoto.lg.jp/kotsu/', content: '市巴士运行正常。', media: '京都市', icon: 'https://sfile.chatglm.cn/searchImage/kyoto_icon.jpg' },
    ],
  });
  const out = await searchZhipu(['京都 地铁 停运'], { apiKey: 'k', fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.equal(JSON.parse(f.calls[0].opts.body).search_engine, 'search_pro');
  assert.equal(out[0].results[0].url, 'https://www.city.kyoto.lg.jp/kotsu/');
  assert.equal(out[0].results[0].snippet, '市巴士运行正常。');
  assert.equal(out[0].results[0].site, '京都市');
  assert.match(out[0].results[0].icon, /chatglm\.cn/);
});

test('三家国产 provider 都对空结果 / 缺字段免疫', async () => {
  const f = fakeFetch({});
  for (const fn of [searchDeepseek, searchBocha, searchZhipu]) {
    const out = await fn(['q'], { apiKey: 'k', fetchImpl: f });
    assert.equal(out[0].results.length, 0);
  }
});

test('SEARCH_PROVIDER_LABEL：国产三家都有中文名', () => {
  assert.equal(SEARCH_PROVIDER_LABEL.deepseek, 'DeepSeek 搜索');
  assert.equal(SEARCH_PROVIDER_LABEL.bocha, '博查 Bocha');
  assert.equal(SEARCH_PROVIDER_LABEL.zhipu, '智谱 Web Search');
});

/* ---------- 推荐地点配图 ---------- */

test('extractOgImage：优先 og:image，支持相对路径与反序属性', () => {
  const html = '<html><head><meta content="/img/k.jpg" property="og:image"></head></html>';
  assert.equal(extractOgImage(html, 'https://a.example/page'), 'https://a.example/img/k.jpg');

  const html2 = '<head><meta property="og:image" content="https://cdn.example/x.png"></head>';
  assert.equal(extractOgImage(html2, 'https://a.example/'), 'https://cdn.example/x.png');

  const html3 = '<head><meta property="og:image:secure_url" content="https://s.example/y.jpg">'
    + '<meta property="og:image" content="https://s.example/fallback.jpg"></head>';
  assert.equal(extractOgImage(html3, 'https://a.example/'), 'https://s.example/y.jpg');

  const html4 = '<head><meta name="twitter:image" content="https://t.example/z.jpg"></head>';
  assert.equal(extractOgImage(html4, 'https://a.example/'), 'https://t.example/z.jpg');
});

test('extractOgImage：http 图片升级成 https，拿不到就返回空', () => {
  const html = '<meta property="og:image" content="http://cdn.example/a.jpg">';
  assert.equal(extractOgImage(html, 'https://a.example/'), 'https://cdn.example/a.jpg');
  assert.equal(extractOgImage('<html></html>', 'https://a.example/'), '');
  assert.equal(extractOgImage('', 'https://a.example/'), '');
  assert.equal(extractOgImage('<meta property="og:image" content="data:image/png;base64,xx">', 'https://a.example/'), '');
});

test('isConcretePlace：模糊地点不配图', () => {
  assert.equal(isConcretePlace('清水寺'), true);
  assert.equal(isConcretePlace('伏见稻荷大社'), true);
  assert.equal(isConcretePlace('京都站周边舒适型酒店（示例）'), false);
  assert.equal(isConcretePlace('岚山一带'), false);
  assert.equal(isConcretePlace(''), false);
  assert.equal(isConcretePlace('某个待核实的地方'), false);
});

test('collectPlacePhotos：只从已有搜索结果取页，抓到 og:image 就返回来源', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    url: 'https://www.kiyomizu.or.jp/',
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => '<meta property="og:image" content="https://www.kiyomizu.or.jp/photo/hondo.jpg">',
  });
  try {
    const groups = [{ results: [
      { title: '清水寺 官网', url: 'https://www.kiyomizu.or.jp/', site: '清水寺', snippet: '' },
    ] }];
    const photos = await collectPlacePhotos(
      [{ name: '清水寺', kind: 'attraction' }, { name: '岚山一带', kind: 'attraction' }],
      { cfg: { provider: 'off' }, groups, destination: '京都' },
    );
    assert.deepEqual(Object.keys(photos), ['清水寺']);
    assert.equal(photos['清水寺'].image, 'https://www.kiyomizu.or.jp/photo/hondo.jpg');
    assert.equal(photos['清水寺'].sourceUrl, 'https://www.kiyomizu.or.jp/');
    assert.equal(photos['清水寺'].sourceName, 'kiyomizu.or.jp');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('collectPlacePhotos：页面没有 og:image 就不返回该地点，不塞假图', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    url: 'https://inari.jp/',
    headers: { get: () => 'text/html' },
    text: async () => '<html><head><title>no image</title></head></html>',
  });
  try {
    const groups = [{ results: [{ title: '伏见稻荷大社', url: 'https://inari.jp/', site: 'inari.jp', snippet: '' }] }];
    const photos = await collectPlacePhotos([{ name: '伏见稻荷大社' }], { cfg: { provider: 'off' }, groups });
    assert.deepEqual(photos, {});
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchHistoricalSamePeriod：去年日期必须映射回出行年份，降水概率不冒充', async () => {
  const originalFetch = globalThis.fetch;
  const fake = fakeFetch({
    daily: {
      time: ['2025-11-23', '2025-11-24', '2025-12-31', '2026-01-01'],
      weather_code: [3, 51, 65, 61],
      temperature_2m_max: [15.5, 16.3, 9.2, 8.8],
      temperature_2m_min: [3.3, 2.5, 1.1, 0.6],
      precipitation_sum: [0, 1.2, 8.4, 3.1],
    },
  });
  globalThis.fetch = fake;
  try {
    const geo = { lat: 35.01, lon: 135.76, timezone: 'Asia/Tokyo', name: '京都' };
    const days = await fetchHistoricalSamePeriod(geo, '2026-11-23', '2026-11-26');
    assert.equal(days.length, 4);
    // 对外日期按本次出行首日逐日顺延（不是去年那串日期），跨月跨年也不能错
    assert.deepEqual(days.map((d) => d.date), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    // 原始实测日期保留在 archiveDate，便于追溯
    assert.deepEqual(days.map((d) => d.archiveDate), ['2025-11-23', '2025-11-24', '2025-12-31', '2026-01-01']);
    // archive 接口没有降水概率，必须留 null 而不是 0
    assert.ok(days.every((d) => d.precip === null));
    assert.equal(days[2].rainMm, 8.4);
    assert.ok(days.every((d) => d.label === '去年同期实测'));
    // 请求打的是 archive 接口，且查的是去年区间
    assert.ok(fake.calls[0].url.includes('archive-api.open-meteo.com'));
    assert.ok(fake.calls[0].url.includes('start_date=2025-11-23'));
    assert.ok(fake.calls[0].url.includes('end_date=2025-11-26'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pickSpotFacts：只留点名了这个景点的结果，官方站排前面', () => {
  const results = [
    { title: '京都景点总览', url: 'https://example.com/a', snippet: '清水寺、金阁寺都在这条线上', site: 'example.com' },
    { title: '清水寺 拝観案内', url: 'https://www.kiyomizu.or.jp/guide', snippet: '大人 400 円', site: 'kiyomizu.or.jp' },
    { title: '清水寺', url: 'https://www.trip.com/x', snippet: '门票 400 日元', site: 'trip.com' },
  ];
  const picked = pickSpotFacts('清水寺', results, 3);
  assert.equal(picked.length, 3);
  assert.equal(picked[0].site, 'kiyomizu.or.jp');
  // 只在摘要里顺带提到的，排到后面（但仍保留，聊胜于无）
  const gold = pickSpotFacts('金阁寺', results);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].site, 'example.com');
  // 完全没提到的景点不会硬塞
  assert.deepEqual(pickSpotFacts('银阁寺', results), []);
  assert.deepEqual(pickSpotFacts('', results), []);
  assert.equal(pickSpotFacts('清水寺', results, 1).length, 1);
});

test('collectSpotFacts：一个景点搜一次，结果按景点名各自过滤', async () => {
  const originalFetch = globalThis.fetch;
  const fake = fakeFetch({
    results: [
      { title: '清水寺 拝観時間と料金', url: 'https://www.kiyomizu.or.jp/guide', snippet: '開門 6:00，大人 400 円', site_name: '清水寺公式', site_icon: 'https://cdn.deepseek.com/site-icons/kiyomizu.or.jp' },
      { title: '清水寺攻略', url: 'https://example.com/b', snippet: '建议早上去', site_name: 'example.com', site_icon: '' },
    ],
  });
  globalThis.fetch = fake;
  try {
    const { facts: out, misses } = await collectSpotFacts(
      [{ name: '清水寺' }, { name: '金阁寺' }, { name: '（示例）' }, { name: '' }],
      { cfg: { provider: 'deepseek', apiKey: 'sk-test' }, destination: '日本京都' },
    );
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls[0].url.includes('tools/search'));
    const body = JSON.parse(fake.calls[0].opts.body);
    assert.ok(body.query.includes('清水寺'));
    assert.ok(body.query.includes('门票'));
    assert.deepEqual(Object.keys(out), ['清水寺']);
    assert.equal(out['清水寺'].results.length, 2);
    assert.equal(out['清水寺'].results[0].site, '清水寺公式');
    assert.equal(out['清水寺'].results[0].icon, 'https://cdn.deepseek.com/site-icons/kiyomizu.or.jp');
    // 金阁寺搜到了条目但一条都没提到它 —— 必须记下原因，而不是静默消失
    assert.equal(misses['金阁寺'].reason, 'no_match');
    assert.ok(misses['金阁寺'].detail.includes('没有一条'));
    assert.ok(misses['金阁寺'].query.includes('金阁寺'));
    // 占位名不搜，但也要说明为什么
    assert.equal(misses['（示例）'].reason, 'not_concrete');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('collectSpotFacts：搜索关掉时不发任何请求', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error('不该发请求'); };
  try {
    const { facts, misses } = await collectSpotFacts([{ name: '清水寺' }], { cfg: { provider: 'off' }, destination: '京都' });
    assert.deepEqual(facts, {});
    assert.equal(called, 0);
    // 没开检索也要说清楚，不能留白
    assert.equal(misses['清水寺'].reason, 'search_off');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ---------- 免密钥搜索源：Bing 中国 / 搜狗 ---------- */

// 造一个返回 HTML 的假 fetch
function fakeHtmlFetch(html, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return html; },
      async json() { return {}; },
    };
  };
  fn.calls = calls;
  return fn;
}

const BING_HTML = `
<ol id="b_results">
<li class="b_algo"><h2><a href="/ck/a?u=a1aHR0cHM6Ly93d3cubGluZ3lpbnNpLm9yZy9kZXRhaWxfMzBfMTQwMTQuaHRtbA">灵隐寺开放时间 &amp; 门票</a></h2>
<p class="b_lineclamp2">每天 07:30-17:30&ensp;开放，门票 30 元。</p></li>
<li class="b_algo"><h2><a href="https://www.hangzhou.gov.cn/">杭州市人民政府</a></h2>
<p>权威发布。</p></li>
<li class="b_algo"><h2><a href="https://x.example/no-p">没有摘要的结果</a></h2></li>
</ol>`;

test('searchBing：解析 b_algo，解码 ck/a 跳转，解 HTML 实体', async () => {
  const f = fakeHtmlFetch(BING_HTML);
  const out = await searchBing(['灵隐寺 开放时间'], { fetchImpl: f });
  assert.ok(f.calls[0].url.startsWith('https://cn.bing.com/search?q='));
  assert.equal(out[0].results.length, 3);
  // 跳转壳必须还原成真实站点，否则「信息来源」面板全是 bing.com
  assert.equal(out[0].results[0].url, 'https://www.lingyinsi.org/detail_30_14014.html');
  assert.equal(out[0].results[0].title, '灵隐寺开放时间 & 门票');
  assert.equal(out[0].results[0].snippet, '每天 07:30-17:30 开放，门票 30 元。');
  assert.equal(out[0].results[0].site, 'lingyinsi.org');
});

test('searchBing：结果为空时不抛错', async () => {
  const f = fakeHtmlFetch('<html><body>没有结果</body></html>');
  const out = await searchBing(['q'], { fetchImpl: f });
  assert.equal(out[0].results.length, 0);
});

test('searchSogou：解析 vrwrap，优先取 data-url 的真实地址', async () => {
  const html = `
<div class="vrwrap"><div class="struct201102">
<h3 class="vr-title"><a href="/link?url=hedJjaC291">杭州<em><!--red_beg-->灵隐寺<!--red_end--></em>开放时间</a></h3>
<div class="text-layout"><div class="fz-mid space-txt">开放时间是每天的 07:30-17:30。</div>
<a class="citeLinkClass" href="/link?url=hedJjaC291"><span>杭州灵隐寺</span><span>https://www.lingyinsi.org/d...</span></a>
</div></div><div class="r-sech" data-url="https://www.lingyinsi.org/detail_30_14014.html" data-hint="sugg"></div>
</div>`;
  const f = fakeHtmlFetch(html);
  const out = await searchSogou(['灵隐寺 开放时间'], { fetchImpl: f });
  assert.ok(f.calls[0].url.startsWith('https://www.sogou.com/web?query='));
  assert.equal(out[0].results.length, 1);
  assert.equal(out[0].results[0].url, 'https://www.lingyinsi.org/detail_30_14014.html');
  // 高亮注释 <!--red_beg--> 不能残留在标题里
  assert.equal(out[0].results[0].title, '杭州灵隐寺开放时间');
  assert.equal(out[0].results[0].snippet, '开放时间是每天的 07:30-17:30。');
  assert.equal(out[0].results[0].site, '杭州灵隐寺');
});

test('searchSogou：命中反爬验证页要抛错，不假装成功', async () => {
  const f = fakeHtmlFetch('<html><body>请输入验证码 antispider</body></html>');
  await assert.rejects(() => searchSogou(['q'], { fetchImpl: f }), /反爬|验证/);
});

test('runWebSearch auto：搜狗被限流时自动回退 Bing', async () => {
  resetSearchState(); // 前一条用例可能已把搜狗打进冷却
  const seen = [];
  const f = async (url) => {
    seen.push(String(url));
    if (String(url).includes('sogou.com')) {
      return { ok: true, status: 200, async text() { return '<p>antispider 验证码</p>'; }, async json() { return {}; } };
    }
    return { ok: true, status: 200, async text() { return BING_HTML; }, async json() { return {}; } };
  };
  const out = await runWebSearch(['嘉兴 南湖 门票 开放时间'], { provider: 'auto', fetchImpl: f });
  assert.equal(out[0].results.length, 3);
  assert.ok(seen.some((u) => u.includes('sogou.com')), '应先试搜狗');
  assert.ok(seen.some((u) => u.includes('cn.bing.com')), '失败后应回退 Bing');
});

test('SEARCH_PROVIDER_LABEL：免密钥源有中文名', () => {
  assert.equal(SEARCH_PROVIDER_LABEL.bing, 'Bing 中国（免密钥）');
  assert.equal(SEARCH_PROVIDER_LABEL.sogou, '搜狗（免密钥）');
  assert.match(SEARCH_PROVIDER_LABEL.auto, /免密钥/);
});
