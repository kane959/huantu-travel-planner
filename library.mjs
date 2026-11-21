/**
 * 寰途 · 搜索知识库（持久化缓存）
 *
 * 解决的问题：每次生成行程都要重新搜「XX 景点门票」「XX 酒店评价」，
 * 同一座城市反复问、反复抓，慢且容易被反爬。搜到的东西应该留下来。
 *
 * 设计取舍：
 * 1. 零依赖：一个城市一个 JSON 文件，直接放 <dataDir>/library/ 下。
 *    部署脚本不覆盖 .data/，所以升级代码不会把积累的知识清掉。
 * 2. 按城市分桶：跨城市的条目几乎不会互相命中，分桶后单文件小、写入快、
 *    也方便人直接打开看（或拷走备份）。
 * 3. 三级新鲜度：fresh（直接用）/ stale（先用旧的，后台顺手刷新）/
 *    expired（必须重搜）。票价、开放时间是有保质期的，不能永久当事实。
 * 4. 写穿：搜索一拿到结果就落盘，不等行程生成完。进程被 kill 也不丢。
 * 5. 原子写：先写临时文件再 rename，避免写一半断电留下半截 JSON。
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LIBRARY_VERSION = 1;

/** 各类条目的默认保质期（天）。门票/开放时间变动慢，图片更慢。 */
export const DEFAULT_TTL_DAYS = {
  search: 7,   // 整类搜索结果（景点/酒店/交通）
  spot: 14,    // 单个景点的门票、开放时间、预约要求
  photo: 30,   // 地点配图 URL
  digest: 30,  // 模型确认过的结构化事实
};

/** 过期后还能「先用旧的」的倍数：stale 期 = TTL × 该系数。 */
export const STALE_FACTOR = 3;

const MAX_ENTRIES_PER_CITY = 300;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const FLUSH_DEBOUNCE_MS = 250;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 键归一化：全角空格、连续空白、大小写差异都不该产生两条重复记录。 */
export function normalizeKey(value) {
  return String(value ?? '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 目的地 → 城市桶名。
 * 「日本京都」「京都」「京都府」应该落到同一个桶里，否则换个写法就重搜一遍。
 */
export function cityOf(destination) {
  const raw = String(destination || '').trim().replace(/\s+/g, '');
  if (!raw) return '';
  let name = raw;
  const countryPrefix = /^(中国|日本|韩国|泰国|越南|新加坡|马来西亚|印度尼西亚|菲律宾|美国|英国|法国|德国|意大利|西班牙|葡萄牙|荷兰|瑞士|奥地利|捷克|匈牙利|波兰|冰岛|挪威|瑞典|芬兰|丹麦|俄罗斯|土耳其|埃及|摩洛哥|南非|肯尼亚|以色列|约旦|阿联酋|澳大利亚|新西兰)/u;
  if (name.length > 3) name = name.replace(countryPrefix, '');
  // 「京都府」「大阪府」「东京都」这类行政区后缀去掉；但剥完至少留两个字
  const stripped = name.replace(/(特别行政区|自治区|地区|省|市|县|府|州|都)$/u, '');
  if (stripped.length >= 2) name = stripped;
  return name || raw;
}

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

/** 文件名要能在 Linux 上安全创建，同时保留中文便于人工排查。 */
function slugOf(city) {
  const safe = String(city || 'unknown')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 40);
  // 加短哈希：避免「京都」和「京都_」这类清洗后撞名
  return `${safe || 'city'}-${sha1(city).slice(0, 6)}`;
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 搜索结果会带正文（最多 1200 字），入库前统一收口，防止单个城市文件失控。 */
function compactResults(results, limit = 8) {
  return (Array.isArray(results) ? results : []).slice(0, limit).map((r) => {
    const out = {
      title: truncate(r?.title, 160),
      url: String(r?.url || '').slice(0, 500),
      snippet: truncate(r?.snippet, 400),
    };
    if (r?.site) out.site = truncate(r.site, 60);
    if (r?.body) out.body = truncate(r.body, 2000);
    return out;
  }).filter((r) => r.title || r.url);
}

function compactSources(sources, limit = 12) {
  return (Array.isArray(sources) ? sources : []).slice(0, limit).map((s) => ({
    title: truncate(s?.title, 160),
    url: String(s?.url || '').slice(0, 500),
    site: truncate(s?.site, 60),
  })).filter((s) => s.url);
}

function entryId(kind, key) {
  return `${kind}:${sha1(normalizeKey(key)).slice(0, 12)}`;
}

export function createLibrary({
  dir,
  logger = console,
  now = () => Date.now(),
  ttlDays = {},
  staleFactor = STALE_FACTOR,
  maxEntriesPerCity = MAX_ENTRIES_PER_CITY,
  flushDebounceMs = FLUSH_DEBOUNCE_MS,
} = {}) {
  if (!dir) throw new Error('createLibrary 需要 dir');
  const ttl = { ...DEFAULT_TTL_DAYS, ...ttlDays };

  /** slug -> { city, file, entries: Map<id, entry>, loaded, bytes } */
  const buckets = new Map();
  const locks = new Map();
  const dirty = new Set();
  let flushTimer = null;
  let closed = false;

  const stats = { writes: 0, errors: 0, evictions: 0 };

  function bucketFor(city, { create = false } = {}) {
    const name = cityOf(city) || '未知';
    const slug = slugOf(name);
    let b = buckets.get(slug);
    if (!b && create) {
      // load() 启动时已经把磁盘上所有城市文件扫进来了，所以「运行时新建的桶」
      // 一定是磁盘上还没有的，直接算已加载，不需要再读一遍空文件。
      b = { city: name, slug, file: path.join(dir, `${slug}.json`), entries: new Map(), loaded: true };
      buckets.set(slug, b);
    }
    return b || null;
  }

  async function ensureLoaded(b) {
    if (!b || b.loaded) return b;
    b.loaded = true;
    try {
      const raw = JSON.parse(await readFile(b.file, 'utf8'));
      const entries = raw?.entries && typeof raw.entries === 'object' ? raw.entries : {};
      for (const [id, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') continue;
        b.entries.set(id, entry);
      }
      if (raw?.city) b.city = String(raw.city);
    } catch (e) {
      if (e.code !== 'ENOENT') logger?.warn?.(`知识库读取失败（${b.slug}）：${e.message}`);
    }
    return b;
  }

  async function load() {
    await mkdir(dir, { recursive: true });
    let files = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch { /* 目录刚建好，空 */ }
    for (const f of files) {
      const city = f.replace(/-[0-9a-f]{6}\.json$/, '');
      const slug = f.replace(/\.json$/, '');
      const b = buckets.get(slug) || {
        city, slug, file: path.join(dir, f), entries: new Map(), loaded: false,
      };
      buckets.set(slug, b);
      await ensureLoaded(b);
    }
    return summary();
  }

  function stateOf(entry, at = now()) {
    // 手动标废的不走 stale 宽限，必须重搜
    if (entry.expiredByUser) return 'expired';
    const updated = Date.parse(entry.updatedAt) || 0;
    const expires = Date.parse(entry.expiresAt) || 0;
    if (!updated) return 'expired';
    if (at < expires) return 'fresh';
    const ttlMs = Math.max(expires - updated, DAY_MS);
    if (at < updated + ttlMs * staleFactor) return 'stale';
    return 'expired';
  }

  function ageDaysOf(entry, at = now()) {
    const updated = Date.parse(entry.updatedAt) || at;
    return Math.max(0, Math.round(((at - updated) / DAY_MS) * 10) / 10);
  }

  /**
   * 查一条。
   * @returns {{hit:true, entry, state, ageDays, stale:boolean} | {hit:false, reason:string}}
   */
  function lookup({ city, kind, key, allowStale = true }) {
    const b = bucketFor(city);
    if (!b || !b.loaded) return { hit: false, reason: 'miss' };
    const entry = b.entries.get(entryId(kind, key));
    if (!entry) return { hit: false, reason: 'miss' };
    const state = stateOf(entry);
    if (state === 'expired' || (state === 'stale' && !allowStale)) {
      return { hit: false, reason: state, entry };
    }
    entry.hits = (entry.hits || 0) + 1;
    entry.lastHitAt = new Date(now()).toISOString();
    markDirty(b);
    return { hit: true, entry, state, ageDays: ageDaysOf(entry), stale: state === 'stale' };
  }

  function store({ city, kind, key, data, query = '', provider = '', sources = [], origin = 'search', note = '', ttlDaysOverride = null }) {
    const b = bucketFor(city, { create: true });
    if (!b) return null;
    const at = now();
    const id = entryId(kind, key);
    const existing = b.entries.get(id);
    const days = Number(ttlDaysOverride || ttl[kind] || DEFAULT_TTL_DAYS.search);
    const entry = {
      id,
      kind,
      key: truncate(key, 200),
      city: b.city,
      query: truncate(query, 300),
      provider: truncate(provider, 40),
      data,
      sources: compactSources(sources),
      origin,
      note: truncate(note, 300),
      createdAt: existing?.createdAt || new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + days * DAY_MS).toISOString(),
      hits: existing?.hits || 0,
      lastHitAt: existing?.lastHitAt || null,
      revisions: (existing?.revisions || 0) + 1,
      expiredByUser: false,
    };
    b.entries.set(id, entry);
    evict(b);
    markDirty(b);
    return entry;
  }

  function markHit({ city, kind, key }) {
    const b = bucketFor(city);
    const entry = b?.entries.get(entryId(kind, key));
    if (!entry) return false;
    entry.hits = (entry.hits || 0) + 1;
    entry.lastHitAt = new Date(now()).toISOString();
    markDirty(b);
    return true;
  }

  /** 立刻作废：下次读取一定重搜。用于「我要看最新的」按钮。 */
  function expire({ city, kind, key }) {
    const b = bucketFor(city);
    const entry = b?.entries.get(entryId(kind, key));
    if (!entry) return false;
    entry.expiredByUser = true;
    entry.expiresAt = new Date(now() - 1).toISOString();
    markDirty(b);
    return true;
  }

  function forget({ city, kind, key }) {
    const b = bucketFor(city);
    if (!b) return false;
    const ok = b.entries.delete(entryId(kind, key));
    if (ok) markDirty(b);
    return ok;
  }

  function list({ city = '', kind = '' } = {}) {
    const out = [];
    const pool = city ? [bucketFor(city)].filter(Boolean) : [...buckets.values()];
    for (const b of pool) {
      for (const entry of b.entries.values()) {
        if (kind && entry.kind !== kind) continue;
        out.push({
          ...entry,
          state: stateOf(entry),
          ageDays: ageDaysOf(entry),
        });
      }
    }
    out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return out;
  }

  function cities() {
    return [...buckets.values()]
      .map((b) => {
        const entries = [...b.entries.values()];
        const fresh = entries.filter((e) => stateOf(e) === 'fresh').length;
        return {
          city: b.city,
          slug: b.slug,
          total: entries.length,
          fresh,
          stale: entries.filter((e) => stateOf(e) === 'stale').length,
          expired: entries.filter((e) => stateOf(e) === 'expired').length,
          updatedAt: entries.reduce((max, e) => (Date.parse(e.updatedAt) > Date.parse(max || 0) ? e.updatedAt : max), ''),
        };
      })
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

  function summary() {
    const all = list();
    return {
      version: LIBRARY_VERSION,
      dir,
      cities: cities().length,
      entries: all.length,
      fresh: all.filter((e) => e.state === 'fresh').length,
      stale: all.filter((e) => e.state === 'stale').length,
      expired: all.filter((e) => e.state === 'expired').length,
      ttlDays: ttl,
      writes: stats.writes,
      errors: stats.errors,
      evictions: stats.evictions,
    };
  }

  function evict(b) {
    if (b.entries.size <= maxEntriesPerCity) return;
    const ordered = [...b.entries.values()].sort((x, y) => {
      const xa = Date.parse(x.lastHitAt || x.updatedAt) || 0;
      const ya = Date.parse(y.lastHitAt || y.updatedAt) || 0;
      return xa - ya;
    });
    const target = Math.floor(maxEntriesPerCity * 0.9);
    while (b.entries.size > target && ordered.length) {
      const victim = ordered.shift();
      b.entries.delete(victim.id);
      stats.evictions += 1;
    }
  }

  function markDirty(b) {
    dirty.add(b.slug);
    if (closed) return;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch((e) => logger?.warn?.(`知识库落盘失败：${e.message}`));
    }, flushDebounceMs);
    flushTimer.unref?.();
  }

  function withLock(slug, fn) {
    const prev = locks.get(slug) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(slug, next);
    return next.finally(() => {
      if (locks.get(slug) === next) locks.delete(slug);
    });
  }

  async function writeBucket(b) {
    const payload = {
      version: LIBRARY_VERSION,
      city: b.city,
      updatedAt: new Date(now()).toISOString(),
      entries: Object.fromEntries(b.entries),
    };
    let text = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      // 单城文件过大时先丢最久没被用过的
      const ordered = [...b.entries.values()].sort(
        (x, y) => (Date.parse(x.lastHitAt || x.updatedAt) || 0) - (Date.parse(y.lastHitAt || y.updatedAt) || 0),
      );
      while (Buffer.byteLength(text) > MAX_FILE_BYTES && ordered.length > 20) {
        b.entries.delete(ordered.shift().id);
        stats.evictions += 1;
        text = JSON.stringify({ ...payload, entries: Object.fromEntries(b.entries) }, null, 2);
      }
    }
    await mkdir(dir, { recursive: true });
    const tmp = `${b.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, b.file);
    stats.writes += 1;
  }

  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const slugs = [...dirty];
    dirty.clear();
    for (const slug of slugs) {
      const b = buckets.get(slug);
      if (!b) continue;
      try {
        await withLock(slug, () => writeBucket(b));
      } catch (e) {
        stats.errors += 1;
        logger?.warn?.(`知识库写入失败（${slug}）：${e.message}`);
      }
    }
  }

  async function close() {
    await flush();
    closed = true;
  }

  return {
    dir,
    load,
    lookup,
    store,
    markHit,
    expire,
    forget,
    list,
    cities,
    summary,
    flush,
    close,
    stateOf,
    ageDaysOf,
    // 测试用
    _buckets: buckets,
    _stats: stats,
  };
}
