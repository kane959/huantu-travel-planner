// 联网抓取层：百度结果解析 + 网页正文提取 + 正文补全。全部离线，用假 fetch 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBaiduResults,
  searchBaidu,
  extractArticleText,
  fetchArticleText,
  enrichWithBodies,
  resetSearchState,
} from '../server.mjs';

// 百度结果页的最小结构：c-container 块 + h3 标题 + mu 真实地址 + 一段摘要文本
const BAIDU_HTML = `
<html><head><title>百度搜索</title></head><body>
<div id="content_left">
  <div class="result c-container xpath-log new-pmd" mu="https://www.lingyinsi.org/detail_18462.html">
    <h3 class="t"><a href="http://www.baidu.com/link?url=AAA">参访寺院:来灵隐寺参观礼佛</a></h3>
    <div class="c-abstract">灵隐寺开放时间 07:00-18:00，门票 30 元，需提前预约。</div>
  </div>
  <div class="result c-container xpath-log new-pmd" mu="https://hz.bendibao.com/tour/2025/123456.shtm">
    <h3 class="t"><a href="http://www.baidu.com/link?url=BBB">2025杭州灵隐寺开放时间一览</a></h3>
    <div class="c-abstract">售票时间 07:00，清场 17:30，飞来峰景区 45 元。</div>
  </div>
  <div class="c-container ec_2">
    <h3><a href="https://union-click.jd.com/xyz">灵隐寺门票团购</a></h3>
    <div>推广广告</div>
  </div>
</div>
</body></html>`;

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>灵隐寺开放时间-杭州本地宝</title></head>
<body>
<nav><a href="/">首页</a><a href="/tour">旅游</a></nav>
<div class="article-content">
  <h1>灵隐寺开放时间</h1>
  <p>灵隐寺每日 07:00 开放，17:30 停止入场，18:00 清场。</p>
  <p>门票价格为 30 元，飞来峰景区另行收费 45 元，需提前在官方渠道预约。</p>
  <p>节假日人流量大，建议早上 8 点前抵达。</p>
</div>
<footer>版权所有</footer>
<script>console.log('不该出现在正文里')</script>
</body></html>`;

function fakeFetch(body, { status = 200, type = 'text/html; charset=utf-8', url = '' } = {}) {
  const calls = [];
  const fn = async (target, opts) => {
    calls.push({ url: String(target), opts });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    return {
      ok: status >= 200 && status < 300,
      status,
      url: url || String(target),
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? type : null) },
      text: async () => String(body),
      arrayBuffer: async () => buf,
      json: async () => JSON.parse(String(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

test('parseBaiduResults：取 mu 的真实地址，不用跳转链', () => {
  const items = parseBaiduResults(BAIDU_HTML);
  assert.equal(items.length, 2, '广告位与无 h3 的块应被跳过');
  assert.equal(items[0].url, 'https://www.lingyinsi.org/detail_18462.html');
  assert.match(items[0].title, /灵隐寺/);
  assert.match(items[0].snippet, /07:00/);
  assert.equal(items[1].url, 'https://hz.bendibao.com/tour/2025/123456.shtm');
});

test('parseBaiduResults：空页面不炸，返回空数组', () => {
  assert.deepEqual(parseBaiduResults(''), []);
  assert.deepEqual(parseBaiduResults('<html><body>无结果</body></html>'), []);
});

test('searchBaidu：正常返回结构化结果并写缓存', async () => {
  resetSearchState();
  const f = fakeFetch(BAIDU_HTML);
  const out = await searchBaidu(['杭州灵隐寺 门票'], { fetchImpl: f });
  assert.equal(out.length, 1);
  assert.equal(out[0].query, '杭州灵隐寺 门票');
  assert.equal(out[0].results.length, 2);
  assert.ok(out[0].results[0].site, '应带上站点名，用于来源展示');
  // 第二次走缓存，不再发请求
  const before = f.calls.length;
  await searchBaidu(['杭州灵隐寺 门票'], { fetchImpl: f });
  assert.equal(f.calls.length, before);
});

test('searchBaidu：命中验证码页直接失败，并进入冷却', async () => {
  resetSearchState();
  const captcha = `<html><body><div>百度安全验证</div></body></html>`;
  const f = fakeFetch(captcha);
  await assert.rejects(() => searchBaidu(['杭州 景点'], { fetchImpl: f }), /验证码/);
  // 冷却期内不再发请求，直接拒绝：避免每次生成都白等一次
  const callsBefore = f.calls.length;
  await assert.rejects(() => searchBaidu(['杭州 景点'], { fetchImpl: f }), /冷却/);
  assert.equal(f.calls.length, callsBefore);
  resetSearchState();
});

test('searchBaidu：跟随跳转后落到 wappass 也算被拦', async () => {
  resetSearchState();
  const f = fakeFetch(BAIDU_HTML, { url: 'https://wappass.baidu.com/static/captcha/x.html' });
  await assert.rejects(() => searchBaidu(['苏州 园林'], { fetchImpl: f }), /验证码/);
  resetSearchState();
});

test('extractArticleText：去掉导航与脚本，只留正文', () => {
  const { title, text } = extractArticleText(ARTICLE_HTML);
  assert.equal(title, '灵隐寺开放时间-杭州本地宝');
  assert.match(text, /07:00 开放/);
  assert.match(text, /30 元/);
  assert.doesNotMatch(text, /首页|版权所有|不该出现在正文里/);
});

test('extractArticleText：没有 article 容器时退回整页并滤掉单字碎片', () => {
  const html = '<html><body><div>好</div><div>灵隐寺每天七点开门，门票三十元，建议早到。</div></body></html>';
  const { text } = extractArticleText(html);
  assert.match(text, /灵隐寺每天七点开门/);
  assert.doesNotMatch(text, /^好$/m);
});

test('extractArticleText：解码实体与换行分块', () => {
  const html = '<article><p>门票&nbsp;30&ensp;元</p><p>A &amp; B</p></article>';
  const { text } = extractArticleText(html);
  assert.match(text, /门票 30 元/);
  assert.match(text, /A & B/);
});

test('fetchArticleText：正常抓取并截断', async () => {
  const f = fakeFetch(ARTICLE_HTML);
  const page = await fetchArticleText('https://hz.bendibao.com/tour/x.htm', { fetchImpl: f, maxChars: 40 });
  assert.ok(page);
  assert.equal(page.chars, 40);
  assert.equal(page.truncated, true);
});

test('fetchArticleText：GBK 页面按 charset 解码不乱码', async () => {
  // 真实 GBK 字节（国内老站点常见），按 utf-8 解会整片乱码，必须读 charset 再解码
  const gbk = Buffer.from(
    'PGh0bWw+PGhlYWQ+PG1ldGEgY2hhcnNldD0iZ2JrIj48dGl0bGU+wenS/svCv6q3xcqxvOQ8L3RpdGxlPjwvaGVhZD48Ym9keT48ZGl2IGNsYXNzPSJjb250ZW50Ij48cD7B6dL+y8LDv8zsxt+147+qw8WjrMquxt+148j9yq631s2j1rnI67Oho6zKrrDLtePH5bOhoaPDxcaxyP3KrtSqo6y3ycC0t+W+sMf4we3Q0MrVt9HLxMquzuXUqqGj0OjM4cew1Nq52be9x/61wNSk1LyjrL3avNnI1cjLwffBv7Tzo6y9qNLp1OfJz7DLtePHsLXWtO+jrNLUw+KzpMqxvOTFxbbTtci68qGjy8LUusTazOG5qcPit9HP49byo6yyu9Do0qrB7c3iubrC8qGj1tyx39PQzaOztbOho6y1q73avNnI1bO1zru99NXFo6zNxrz21/i5q727x7DN+aGjPC9wPjwvZGl2PjwvYm9keT48L2h0bWw+',
    'base64',
  );
  const f = fakeFetch(gbk, { type: 'text/html; charset=gbk' });
  const page = await fetchArticleText('https://example.com/gbk.htm', { fetchImpl: f });
  assert.ok(page, '声明 gbk 也应能处理，不能整条失败');
  assert.match(page.title, /灵隐寺/);
  assert.match(page.text, /门票三十元/);
});

test('fetchArticleText：非 HTML、404、空正文都返回 null', async () => {
  assert.equal(await fetchArticleText('https://x.com/a.pdf', {
    fetchImpl: fakeFetch('%PDF', { type: 'application/pdf' }),
  }), null);
  assert.equal(await fetchArticleText('https://x.com/404', {
    fetchImpl: fakeFetch('not found', { status: 404 }),
  }), null);
  assert.equal(await fetchArticleText('https://x.com/js', {
    fetchImpl: fakeFetch('<div id="app"></div>'),
  }), null);
  assert.equal(await fetchArticleText('ftp://x.com/a', { fetchImpl: fakeFetch('x') }), null);
});

test('enrichWithBodies：每类取前两条、去重、受 max 限制', async () => {
  const groups = {
    attractions: [
      { results: [{ title: 'A', url: 'https://a.com/1', snippet: 's' }, { title: 'B', url: 'https://b.com/1', snippet: 's' }] },
      { results: [{ title: 'C', url: 'https://c.com/1', snippet: 's' }] },
    ],
    hotels: [
      { results: [{ title: 'D', url: 'https://d.com/1', snippet: 's' }] },
    ],
    transport: [
      { results: [{ title: 'E', url: 'https://e.com/1', snippet: 's' }] },
    ],
  };
  const f = fakeFetch(ARTICLE_HTML);
  const r = await enrichWithBodies(groups, { max: 3, fetchImpl: f });
  assert.equal(r.attempted, 3);
  assert.equal(r.ok, 3);
  const withBody = groups.attractions[0].results.filter((x) => x.body);
  assert.ok(withBody.length >= 1, '正文应挂回原来的 hit 上');
});

test('enrichWithBodies：没有搜索结果时不发请求', async () => {
  const f = fakeFetch(ARTICLE_HTML);
  const r = await enrichWithBodies(null, { fetchImpl: f });
  assert.deepEqual(r, { attempted: 0, ok: 0 });
  assert.equal(f.calls.length, 0);
});

test('enrichWithBodies：单条抓取失败不影响其余', async () => {
  let n = 0;
  const flaky = async (url, opts) => {
    n += 1;
    if (n === 1) throw new Error('boom');
    return fakeFetch(ARTICLE_HTML)(url, opts);
  };
  const groups = {
    attractions: [{ results: [
      { title: 'X', url: 'https://x.com/1', snippet: 's' },
      { title: 'Y', url: 'https://y.com/1', snippet: 's' },
    ] }],
  };
  const r = await enrichWithBodies(groups, { max: 2, fetchImpl: flaky });
  assert.equal(r.attempted, 2);
  assert.equal(r.ok, 1);
});
