/**
 * 搜索知识库测试
 *
 * 关注四件事：
 *   1. 写进去能读出来，重启进程还在（持久化）
 *   2. 过期判定分三档：fresh / stale / expired
 *   3. 手动作废后必须重搜（「我要最新的」按钮）
 *   4. 键归一化 —— 「京都」「 京都 」「日本京都」不能各存一份
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLibrary, normalizeKey, cityOf, DEFAULT_TTL_DAYS } from '../library.mjs';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'huantu-lib-'));
}

const DAY = 24 * 60 * 60 * 1000;

function fakeClock(start = Date.parse('2026-11-03T12:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    advance(days) { t += days * DAY; },
  };
}

const sampleData = {
  groups: [{
    query: '杭州 景点 门票',
    results: [
      { title: '灵隐寺门票', url: 'https://example.com/lingsi', snippet: '飞来峰景区 45 元', site: 'example.com', body: '灵隐飞来峰自 2025 年 12 月起免费开放，需提前预约。' },
      { title: '西湖游船', url: 'https://example.com/xihu', snippet: '55 元/人' },
    ],
  }],
};

/* ---------------- 归一化 ---------------- */

test('normalizeKey 抹平全角/空白/大小写差异', () => {
  assert.equal(normalizeKey('杭州 景点　门票'), '杭州 景点 门票');
  assert.equal(normalizeKey('  Kyoto  Kyoto '), 'kyoto kyoto');
  assert.equal(normalizeKey('ＡＢＣ'), 'abc');
});

test('cityOf 把「日本京都」「京都府」「京都」并成同一个桶', () => {
  const a = cityOf('京都');
  assert.equal(cityOf('京都府'), a);
  assert.equal(cityOf('日本京都'), a);
  assert.equal(cityOf(' 京都 '), a);
  assert.notEqual(cityOf('京都'), cityOf('大阪'));
});

/* ---------------- 基本读写 ---------------- */

test('写入后能查到，并且命中计数会累加', async () => {
  const dir = await tempDir();
  const clock = fakeClock();
  const lib = createLibrary({ dir, now: clock.now, logger: { warn() {} } });
  await lib.load();

  lib.store({ city: '杭州', kind: 'search', key: '景点', data: sampleData, query: '杭州 景点 门票', provider: 'baidu' });

  const first = lib.lookup({ city: '杭州', kind: 'search', key: '景点' });
  assert.equal(first.hit, true);
  assert.equal(first.state, 'fresh');
  assert.equal(first.entry.hits, 1);
  assert.equal(first.entry.data.groups[0].results[0].title, '灵隐寺门票');

  const second = lib.lookup({ city: '杭州', kind: 'search', key: '景点' });
  assert.equal(second.entry.hits, 2);

  await lib.flush();
  await rm(dir, { recursive: true, force: true });
});

test('换城市查不到（分桶隔离）', async () => {
  const dir = await tempDir();
  const lib = createLibrary({ dir, now: fakeClock().now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'search', key: '景点', data: sampleData });
  assert.equal(lib.lookup({ city: '大阪', kind: 'search', key: '景点' }).hit, false);
  await rm(dir, { recursive: true, force: true });
});

test('落盘是原子写：目录里只有最终 json，不留临时文件', async () => {
  const dir = await tempDir();
  const lib = createLibrary({ dir, now: fakeClock().now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'spot', key: '灵隐寺', data: { name: '灵隐寺' } });
  await lib.flush();

  const files = await readdir(dir);
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 1);
  assert.equal(files.filter((f) => f.includes('.tmp-')).length, 0);

  const raw = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
  assert.equal(raw.city, '杭州');
  assert.equal(Object.keys(raw.entries).length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('新进程重新加载后数据还在', async () => {
  const dir = await tempDir();
  const clock = fakeClock();
  const a = createLibrary({ dir, now: clock.now, logger: { warn() {} } });
  await a.load();
  a.store({
    city: '杭州', kind: 'spot', key: '灵隐寺', data: { name: '灵隐寺', ticket: '免费（需预约）' },
    sources: [{ title: '杭州本地宝', url: 'https://example.com/a', site: 'example.com' }],
  });
  await a.flush();
  await a.close();

  const b = createLibrary({ dir, now: clock.now, logger: { warn() {} } });
  const sum = await b.load();
  assert.equal(sum.entries, 1);
  const hit = b.lookup({ city: '杭州', kind: 'spot', key: '灵隐寺' });
  assert.equal(hit.hit, true);
  assert.equal(hit.entry.data.ticket, '免费（需预约）');
  assert.equal(hit.entry.sources.length, 1);
  await rm(dir, { recursive: true, force: true });
});

/* ---------------- 新鲜度 ---------------- */

test('保质期内是 fresh，过期后 stale，再久就是 expired', async () => {
  const dir = await tempDir();
  const clock = fakeClock();
  const lib = createLibrary({ dir, now: clock.now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'spot', key: '灵隐寺', data: {} });

  assert.equal(lib.lookup({ city: '杭州', kind: 'spot', key: '灵隐寺' }).state, 'fresh');

  clock.advance(DEFAULT_TTL_DAYS.spot + 1);
  const stale = lib.lookup({ city: '杭州', kind: 'spot', key: '灵隐寺' });
  assert.equal(stale.hit, true, 'stale 仍然可命中，先用旧值');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.stale, true);

  clock.advance(DEFAULT_TTL_DAYS.spot * 3 + 1);
  const dead = lib.lookup({ city: '杭州', kind: 'spot', key: '灵隐寺' });
  assert.equal(dead.hit, false, '超过宽限期必须重搜');
  assert.equal(dead.reason, 'expired');

  await rm(dir, { recursive: true, force: true });
});

test('allowStale=false 时 stale 条目视为未命中', async () => {
  const dir = await tempDir();
  const clock = fakeClock();
  const lib = createLibrary({ dir, now: clock.now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'search', key: '景点', data: sampleData });
  clock.advance(DEFAULT_TTL_DAYS.search + 1);

  assert.equal(lib.lookup({ city: '杭州', kind: 'search', key: '景点', allowStale: false }).hit, false);
  assert.equal(lib.lookup({ city: '杭州', kind: 'search', key: '景点' }).hit, true);
  await rm(dir, { recursive: true, force: true });
});

test('expire 之后立即失效，用于「拉最新」', async () => {
  const dir = await tempDir();
  const lib = createLibrary({ dir, now: fakeClock().now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'search', key: '景点', data: sampleData });
  assert.equal(lib.lookup({ city: '杭州', kind: 'search', key: '景点' }).hit, true);

  assert.equal(lib.expire({ city: '杭州', kind: 'search', key: '景点' }), true);
  assert.equal(lib.lookup({ city: '杭州', kind: 'search', key: '景点' }).hit, false);
  await rm(dir, { recursive: true, force: true });
});

test('再次 store 同一 key 是更新而不是新增，revisions 递增', async () => {
  const dir = await tempDir();
  const lib = createLibrary({ dir, now: fakeClock().now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'spot', key: '灵隐寺', data: { v: 1 } });
  const e2 = lib.store({ city: '杭州', kind: 'spot', key: '灵隐寺', data: { v: 2 } });
  assert.equal(e2.revisions, 2);
  assert.equal(lib.list({ city: '杭州' }).length, 1);
  assert.equal(lib.lookup({ city: '杭州', kind: 'spot', key: '灵隐寺' }).entry.data.v, 2);
  await rm(dir, { recursive: true, force: true });
});

/* ---------------- 容量与统计 ---------------- */

test('超出单城上限时按「最久没用」淘汰', async () => {
  const dir = await tempDir();
  const clock = fakeClock();
  const lib = createLibrary({ dir, now: clock.now, logger: { warn() {} }, maxEntriesPerCity: 10 });
  await lib.load();
  for (let i = 0; i < 10; i++) {
    lib.store({ city: '杭州', kind: 'spot', key: `景点${i}`, data: { i } });
    clock.advance(0.01);
  }
  // 让 0 号成为最近用过的，1 号最久没动
  lib.lookup({ city: '杭州', kind: 'spot', key: '景点0' });
  lib.store({ city: '杭州', kind: 'spot', key: '景点新', data: {} });

  const keys = lib.list({ city: '杭州' }).map((e) => e.key);
  assert.ok(keys.length <= 10, `淘汰后条目数应 <= 10，实际 ${keys.length}`);
  assert.ok(keys.includes('景点0'), '刚被用过的应该留下');
  assert.ok(keys.includes('景点新'), '新写入的必须留下');
  assert.equal(keys.includes('景点1'), false, '最久没用的应被淘汰');
  await rm(dir, { recursive: true, force: true });
});

test('summary 统计各状态数量', async () => {
  const dir = await tempDir();
  const clock = fakeClock();
  const lib = createLibrary({ dir, now: clock.now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'spot', key: 'A', data: {} });
  lib.store({ city: '杭州', kind: 'search', key: 'B', data: sampleData });
  clock.advance(DEFAULT_TTL_DAYS.search + 1); // search 过期，spot 还新鲜
  lib.store({ city: '大阪', kind: 'photo', key: 'C', data: { image: 'https://x/y.jpg' } });

  const sum = lib.summary();
  assert.equal(sum.entries, 3);
  assert.equal(sum.cities, 2);
  assert.equal(sum.fresh, 2);
  assert.equal(sum.stale, 1);
  await rm(dir, { recursive: true, force: true });
});

test('forget 只删指定条目', async () => {
  const dir = await tempDir();
  const lib = createLibrary({ dir, now: fakeClock().now, logger: { warn() {} } });
  await lib.load();
  lib.store({ city: '杭州', kind: 'spot', key: 'A', data: {} });
  lib.store({ city: '杭州', kind: 'spot', key: 'B', data: {} });
  assert.equal(lib.forget({ city: '杭州', kind: 'spot', key: 'A' }), true);
  assert.equal(lib.list({ city: '杭州' }).length, 1);
  assert.equal(lib.list({ city: '杭州' })[0].key, 'B');
  await rm(dir, { recursive: true, force: true });
});
