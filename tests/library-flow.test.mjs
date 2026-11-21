/**
 * 知识库接入链路测试（离线）
 *
 * 验证三件事：
 *   1. 第一次搜索会联网，并把结果写进知识库
 *   2. 第二次同样的问法一次网都不上，直接命中知识库
 *   3. /api/library 能看到沉淀了什么，也能手动作废
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runSearchByCategory,
  collectSpotFacts,
  collectPlacePhotos,
  createApp,
  resetSearchState,
} from '../server.mjs';
import { createLibrary } from '../library.mjs';

process.env.HUANTU_WEATHER = 'off';
process.env.HUANTU_GEOCODE = 'off';

const BAIDU_HTML = `
<html><head><title>百度搜索</title></head><body>
<div id="content_left">
  <div class="result c-container" mu="https://www.lingyinsi.org/detail_18462.html">
    <h3 class="t"><a href="http://www.baidu.com/link?url=AAA">杭州灵隐寺参观礼佛</a></h3>
    <div class="c-abstract">灵隐寺开放时间 07:00-18:00，门票 30 元，需提前预约。</div>
  </div>
  <div class="result c-container" mu="https://hz.bendibao.com/tour/2025/123456.shtm">
    <h3 class="t"><a href="http://www.baidu.com/link?url=BBB">杭州灵隐寺开放时间一览</a></h3>
    <div class="c-abstract">飞来峰景区 45 元，灵隐寺需预约。</div>
  </div>
</div>
</body></html>`;

const PAGE_HTML = `<!DOCTYPE html><html><head>
<meta property="og:image" content="https://img.example.com/lingsi-hero.jpg" />
<title>杭州灵隐寺</title></head><body><p>灵隐寺</p></body></html>`;

function fakeFetch(body, { url = '' } = {}) {
  const calls = [];
  const fn = async (target) => {
    calls.push(String(target));
    return {
      ok: true,
      status: 200,
      url: url || String(target),
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
      text: async () => body,
      arrayBuffer: async () => Buffer.from(body, 'utf8'),
      json: async () => JSON.parse(body),
    };
  };
  fn.calls = calls;
  return fn;
}

function usageRecorder() {
  const hits = [];
  const misses = [];
  return {
    hits,
    misses,
    noteHit: (x) => hits.push(x),
    noteMiss: (x) => misses.push(x),
    noteFail: () => {},
  };
}

const tripInput = {
  origin: '上海',
  destination: '杭州',
  startDate: '2026-11-10',
  days: 2,
  travelers: 2,
  budget: '5000',
  interests: ['人文'],
  pace: 'balanced',
  transport: 'public',
  hotelPreference: 'comfort',
};

async function withLib(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'huantu-flow-'));
  const lib = createLibrary({ dir, logger: { warn() {}, info() {} } });
  await lib.load();
  try {
    return await fn(lib, dir);
  } finally {
    await lib.flush();
    await rm(dir, { recursive: true, force: true });
  }
}

async function withFetch(fn, body = BAIDU_HTML) {
  const real = globalThis.fetch;
  const stub = fakeFetch(body);
  globalThis.fetch = stub;
  try {
    return await fn(stub);
  } finally {
    globalThis.fetch = real;
  }
}

/* ---------------- 三类搜索 ---------------- */

test('第一次搜索联网并入库，第二次同城同问完全命中', async () => {
  await withLib(async (lib) => {
    resetSearchState();
    const cfg = { provider: 'baidu', library: lib, usage: usageRecorder() };
    let firstCalls = 0;
    let r1;
    await withFetch(async (stub) => {
      r1 = await runSearchByCategory(tripInput, cfg);
      firstCalls = stub.calls.length;
    });
    assert.ok(firstCalls > 0, '第一次必须真的联网');
    assert.ok(r1.attractions?.length, '第一次应拿到景点结果');
    assert.equal(lib.list({ city: '杭州', kind: 'search' }).length, 3, '三类搜索都应落库');

    // 清掉 10 分钟的内存搜索缓存，逼它只能靠知识库
    resetSearchState();
    const u2 = usageRecorder();
    let secondCalls = 0;
    let r2;
    await withFetch(async (stub) => {
      r2 = await runSearchByCategory(tripInput, { provider: 'baidu', library: lib, usage: u2 });
      secondCalls = stub.calls.length;
    });
    assert.equal(secondCalls, 0, '第二次一次网都不该上');
    assert.equal(u2.hits.length, 3, '三个类别都应命中知识库');
    assert.deepEqual(
      r2.attractions.flatMap((g) => g.results.map((x) => x.url)),
      r1.attractions.flatMap((g) => g.results.map((x) => x.url)),
      '命中缓存的内容应与第一次一致',
    );
  });
});

test('换城市不会误命中（各自单独联网）', async () => {
  await withLib(async (lib) => {
    resetSearchState();
    await withFetch(async () => {
      await runSearchByCategory(tripInput, { provider: 'baidu', library: lib });
    });
    resetSearchState();
    let calls = 0;
    await withFetch(async (stub) => {
      await runSearchByCategory({ ...tripInput, destination: '苏州' }, { provider: 'baidu', library: lib });
      calls = stub.calls.length;
    });
    assert.ok(calls > 0, '换城市应重新联网');
    assert.equal(lib.list({ city: '苏州', kind: 'search' }).length, 3);
  });
});

/* ---------------- 景点事实 ---------------- */

test('景点票价：首次联网，二次直接用库里的，并标记 cached', async () => {
  await withLib(async (lib) => {
    resetSearchState();
    await withFetch(async () => {
      const r1 = await collectSpotFacts([{ name: '灵隐寺' }], {
        cfg: { provider: 'baidu' }, destination: '杭州', library: lib, usage: usageRecorder(),
      });
      assert.ok(r1.facts['灵隐寺'], '第一次应搜到灵隐寺');
      assert.equal(r1.facts['灵隐寺'].cached, undefined);
    });

    resetSearchState();
    let calls = 0;
    await withFetch(async (stub) => {
      const u = usageRecorder();
      const r2 = await collectSpotFacts([{ name: '灵隐寺' }], {
        cfg: { provider: 'baidu' }, destination: '杭州', library: lib, usage: u,
      });
      calls = stub.calls.length;
      assert.equal(r2.facts['灵隐寺'].cached, true);
      assert.ok(r2.facts['灵隐寺'].cachedAt);
      assert.equal(u.hits.length, 1);
      assert.ok(r2.facts['灵隐寺'].results.length > 0);
    });
    assert.equal(calls, 0, '第二次不该联网');
  });
});

test('关掉联网搜索时，知识库里已有的景点仍可用', async () => {
  await withLib(async (lib) => {
    resetSearchState();
    await withFetch(async () => {
      await collectSpotFacts([{ name: '灵隐寺' }], {
        cfg: { provider: 'baidu' }, destination: '杭州', library: lib,
      });
    });
    resetSearchState();
    const r = await collectSpotFacts([{ name: '灵隐寺' }, { name: '从未搜过的塔' }], {
      cfg: { provider: 'off' }, destination: '杭州', library: lib,
    });
    assert.ok(r.facts['灵隐寺'], '库里的应该照用');
    assert.equal(r.facts['灵隐寺'].cached, true);
    assert.equal(r.misses['从未搜过的塔'].reason, 'search_off');
  });
});

/* ---------------- 配图 ---------------- */

test('配图：抓一次 og:image 后入库存图片地址', async () => {
  await withLib(async (lib) => {
    const groups = [{ results: [{ title: '杭州灵隐寺', url: 'https://www.lingyinsi.org/a.html' }] }];
    let first;
    await withFetch(async () => {
      first = await collectPlacePhotos([{ name: '灵隐寺', kind: 'attraction' }], {
        cfg: { provider: 'off' }, groups, destination: '杭州', library: lib, usage: usageRecorder(),
      });
    }, PAGE_HTML);
    assert.equal(first['灵隐寺'].image, 'https://img.example.com/lingsi-hero.jpg');

    let calls = 0;
    await withFetch(async (stub) => {
      const u = usageRecorder();
      const second = await collectPlacePhotos([{ name: '灵隐寺', kind: 'attraction' }], {
        cfg: { provider: 'off' }, groups, destination: '杭州', library: lib, usage: u,
      });
      calls = stub.calls.length;
      assert.equal(second['灵隐寺'].image, 'https://img.example.com/lingsi-hero.jpg');
      assert.equal(second['灵隐寺'].cached, true);
      assert.equal(u.hits.length, 1);
    }, PAGE_HTML);
    assert.equal(calls, 0, '第二张图不该再去抓页面');
  });
});

/* ---------------- HTTP 接口 ---------------- */

test('/api/library 能看到沉淀条目，刷新接口能把条目标废', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'huantu-libapi-'));
  const seed = createLibrary({ dir: path.join(dir, 'library'), logger: { warn() {} } });
  await seed.load();
  seed.store({
    city: '杭州',
    kind: 'spot',
    key: '灵隐寺',
    data: { name: '灵隐寺', results: [{ title: '灵隐寺开放时间', url: 'https://example.com/a', snippet: '07:00-18:00' }] },
    query: '杭州 灵隐寺 门票 开放时间',
    provider: 'baidu',
  });
  await seed.flush();

  const app = await createApp({
    dataDir: dir,
    allowLocalUpstream: true,
    logger: { error() {}, warn() {}, info() {} },
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;

  try {
    let cookie = '';
    let csrf = '';
    const req = async (route, method = 'GET', body) => {
      const res = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json', cookie, 'X-Huantu-CSRF': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const value = await res.json();
      if (value.csrf) csrf = value.csrf;
      return { status: res.status, value };
    };

    const list = await req('/api/library');
    assert.equal(list.status, 200);
    assert.equal(list.value.enabled, true);
    assert.equal(list.value.summary.entries, 1);
    assert.equal(list.value.cities[0].city, '杭州');

    const detail = await req('/api/library?city=' + encodeURIComponent('杭州'));
    assert.equal(detail.value.items.length, 1);
    assert.equal(detail.value.items[0].key, '灵隐寺');
    assert.match(detail.value.items[0].preview, /灵隐寺开放时间/);
    assert.equal(detail.value.items[0].state, 'fresh');

    // 拿 csrf
    await req('/api/public');

    const refreshed = await req('/api/library/refresh', 'POST', { city: '杭州' });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.value.expired, 1);

    const after = await req('/api/library?city=' + encodeURIComponent('杭州'));
    assert.equal(after.value.items[0].state, 'expired');

    const removed = await req('/api/library/item', 'DELETE', { city: '杭州', kind: 'spot', key: '灵隐寺' });
    assert.equal(removed.value.ok, true);
    const empty = await req('/api/library?city=' + encodeURIComponent('杭州'));
    assert.equal(empty.value.items.length, 0);
  } finally {
    await new Promise((r) => app.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
