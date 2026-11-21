/**
 * 寰途｜AI 智能旅行策划师 — 本机后端
 *
 * 设计原则：
 * 1. 模型密钥只存在进程内存，永不返回前端、永不写日志、永不落盘。
 * 2. 没有真实模型连接时，规划接口直接报错，绝不使用固定模板冒充模型输出。
 * 3. 所有时效信息（天气/房价/营业时间/班次）一律标为「待核实」，查询时间由后端写入，
 *    模型自己声称的查询时间会被丢弃。
 * 4. 日历：只提供 .ics 下载与 Google 创建链接；OAuth 未配置时如实显示「尚未授权」。
 * 5. 不代订、不付款、不自动发消息；删除日历事件必须显式确认。
 */

import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createQueue, STAGE_LABEL, TERMINAL_STATUS, JOB_STATUS } from './queue.mjs';
import { createLibrary, cityOf as libraryCityOf, normalizeKey as libraryKey } from './library.mjs';
import { planToStops, cityCenterOf, isValidCoord, haversineKm, wgs2gcj } from './public/travel-map-core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

const MAX_BODY = 96 * 1024;
const TBD = '待核实';

export function sanitizeText(value, max = 300, { multiline = false } = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  let s = value.replace(/\r\n?/g, '\n');
  // 模型输出的 HTML 不允许被当作标记执行：这里直接剥掉标签与伪协议。
  s = s.replace(/<[^>\n]{0,400}>/g, ' ');
  s = s.replace(/javascript:/gi, '');
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  s = multiline ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\n+/g, ' ');
  s = s.replace(/[ \t]{2,}/g, ' ').trim();
  return s.slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asArray(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

export function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function weekdayCN(dateStr) {
  if (!isValidDateString(dateStr)) return '';
  return WEEKDAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

function normalizeTime(value) {
  const m = String(value || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!m) return '';
  const h = Math.min(23, Number(m[1]));
  const mi = Math.min(59, Number(m[2]));
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

function timePlusMinutes(time, minutes) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * 目的地 → IANA 时区。日历时间必须按当地时间折算，
 * 否则出境行程会整体偏几个小时（例如京都比北京时间晚 1 小时的换算错误）。
 */
const TIMEZONE_HINTS = [
  [/京都|东京|大阪|奈良|北海道|札幌|冲绳|福冈|名古屋|镰仓|日本/, 'Asia/Tokyo'],
  [/首尔|釜山|济州|韩国/, 'Asia/Seoul'],
  [/曼谷|清迈|普吉|苏梅|泰国/, 'Asia/Bangkok'],
  [/新加坡|狮城/, 'Asia/Singapore'],
  [/吉隆坡|槟城|沙巴|马来西亚/, 'Asia/Kuala_Lumpur'],
  [/巴厘|雅加达|日惹|印度尼西亚/, 'Asia/Jakarta'],
  [/河内|胡志明|岘港|越南/, 'Asia/Ho_Chi_Minh'],
  [/马尼拉|长滩|菲律宾/, 'Asia/Manila'],
  [/伦敦|爱丁堡|英国/, 'Europe/London'],
  [/巴黎|尼斯|法国/, 'Europe/Paris'],
  [/罗马|米兰|威尼斯|佛罗伦萨|意大利/, 'Europe/Rome'],
  [/巴塞罗那|马德里|西班牙/, 'Europe/Madrid'],
  [/里斯本|葡萄牙/, 'Europe/Lisbon'],
  [/柏林|慕尼黑|法兰克福|德国/, 'Europe/Berlin'],
  [/阿姆斯特丹|荷兰/, 'Europe/Amsterdam'],
  [/苏黎世|因特拉肯|瑞士/, 'Europe/Zurich'],
  [/维也纳|奥地利/, 'Europe/Vienna'],
  [/布拉格|捷克/, 'Europe/Prague'],
  [/布达佩斯|匈牙利/, 'Europe/Budapest'],
  [/雅典|圣托里尼|希腊/, 'Europe/Athens'],
  [/莫斯科|圣彼得堡|俄罗斯/, 'Europe/Moscow'],
  [/伊斯坦布尔|土耳其/, 'Europe/Istanbul'],
  [/雷克雅未克|冰岛/, 'Atlantic/Reykjavik'],
  [/迪拜|阿布扎比|阿联酋/, 'Asia/Dubai'],
  [/多哈|卡塔尔/, 'Asia/Qatar'],
  [/特拉维夫|以色列/, 'Asia/Jerusalem'],
  [/新德里|孟买|斋普尔|印度/, 'Asia/Kolkata'],
  [/加德满都|尼泊尔/, 'Asia/Kathmandu'],
  [/纽约|波士顿|华盛顿|费城|美国东部/, 'America/New_York'],
  [/芝加哥|美国中部/, 'America/Chicago'],
  [/丹佛|美国山地/, 'America/Denver'],
  [/洛杉矶|旧金山|西雅图|拉斯维加斯|圣地亚哥|美国西部/, 'America/Los_Angeles'],
  [/温哥华|加拿大西部/, 'America/Vancouver'],
  [/多伦多|蒙特利尔|加拿大东部/, 'America/Toronto'],
  [/墨西哥城|墨西哥/, 'America/Mexico_City'],
  [/圣保罗|里约|巴西/, 'America/Sao_Paulo'],
  [/布宜诺斯艾利斯|阿根廷/, 'America/Argentina/Buenos_Aires'],
  [/利马|秘鲁/, 'America/Lima'],
  [/悉尼|墨尔本|布里斯班|珀斯|澳大利亚/, 'Australia/Sydney'],
  [/奥克兰|皇后镇|新西兰/, 'Pacific/Auckland'],
  [/开罗|埃及/, 'Africa/Cairo'],
  [/开普敦|约翰内斯堡|南非/, 'Africa/Johannesburg'],
  [/内罗毕|肯尼亚/, 'Africa/Nairobi'],
  [/马拉喀什|摩洛哥/, 'Africa/Casablanca'],
  [/夏威夷|檀香山/, 'Pacific/Honolulu'],
  [/香港/, 'Asia/Hong_Kong'],
  [/澳门/, 'Asia/Macau'],
  [/台北|台中|高雄|台湾/, 'Asia/Taipei'],
  [/乌鲁木齐/, 'Asia/Urumqi'],
  [/拉萨/, 'Asia/Shanghai'],
];

export function guessTimeZone(destination) {
  const text = String(destination || '');
  for (const [pattern, tz] of TIMEZONE_HINTS) if (pattern.test(text)) return tz;
  return 'Asia/Shanghai';
}

/* ------------------------------------------------------------------ *
 * 时区换算（用于 Google Calendar 的 UTC 时间）
 * ------------------------------------------------------------------ */

function tzOffsetMs(tz, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour) % 24, Number(map.minute), Number(map.second),
  );
  return asUtc - utcMs;
}

/** 把某个时区的墙上时间（YYYY-MM-DD + HH:MM）换算成真实 UTC 时间戳 */
export function zonedTimeToUtc(dateStr, timeStr, tz = 'Asia/Shanghai') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let offset = tzOffsetMs(tz, guess);
  let result = guess - offset;
  const offset2 = tzOffsetMs(tz, result);
  if (offset2 !== offset) result = guess - offset2;
  return result;
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/* ------------------------------------------------------------------ *
 * 行程输入校验
 * ------------------------------------------------------------------ */

export const INTEREST_POOL = [
  '美术馆', '博物馆', '历史古迹', '自然风光', '徒步', '海边', '温泉',
  '美食', '咖啡', '市集', '夜生活', '建筑', '摄影', '购物', '亲子', '小众探索',
];
const PACES = new Set(['relaxed', 'balanced', 'intense']);
const HOTEL_PREFS = new Set(['budget', 'comfort', 'boutique', 'luxury', 'homestay', 'any']);
const TRANSPORT_PREFS = new Set(['public', 'drive', 'walk', 'mixed', 'any']);

export function validateTripInput(raw) {
  if (!raw || typeof raw !== 'object') fail('请填写完整的旅行需求。', 400);

  const origin = sanitizeText(raw.origin, 60);
  const destination = sanitizeText(raw.destination, 60);
  if (!origin) fail('请填写出发地。');
  if (!destination) fail('请填写目的地。');
  if (origin === destination) fail('出发地与目的地相同，请确认目的地。');

  const startDate = String(raw.startDate || '').slice(0, 10);
  if (!isValidDateString(startDate)) fail('请选择有效的出发日期。');

  const days = Math.trunc(Number(raw.days));
  if (!Number.isFinite(days) || days < 1 || days > 21) fail('旅行天数需在 1 至 21 天之间。');

  const travelers = Math.trunc(Number(raw.travelers ?? 1));
  if (!Number.isFinite(travelers) || travelers < 1 || travelers > 20) fail('出行人数需在 1 至 20 人之间。');
  const children = clampInt(raw.children, 0, travelers, 0);

  let budget = sanitizeText(
    typeof raw.budget === 'object' && raw.budget !== null
      ? [raw.budget.amount, raw.budget.currency].filter(Boolean).join(' ')
      : raw.budget,
    60,
  );

  let interests = [];
  if (Array.isArray(raw.interests)) {
    interests = raw.interests
      .map((x) => sanitizeText(x, 20))
      .filter(Boolean);
  } else if (typeof raw.interests === 'string') {
    interests = raw.interests.split(/[,，、;；\s]+/).map((x) => sanitizeText(x, 20)).filter(Boolean);
  }
  interests = [...new Set(interests)].slice(0, 8);

  const pace = PACES.has(raw.pace) ? raw.pace : 'balanced';
  const hotelPreference = HOTEL_PREFS.has(raw.hotel) ? raw.hotel : 'comfort';
  const transport = TRANSPORT_PREFS.has(raw.transport) ? raw.transport : 'public';
  const special = sanitizeText(raw.special, 600, { multiline: true });
  // 时区：用户指定优先，其次按目的地推断（出境行程不能沿用北京时间）
  const tz = isValidTimeZone(raw.timezone) ? raw.timezone : guessTimeZone(destination);

  return {
    origin,
    destination,
    startDate,
    endDate: addDays(startDate, days - 1),
    days,
    travelers,
    children,
    budget: budget || '未填写',
    interests,
    pace,
    hotelPreference,
    transport,
    special,
    timezone: tz,
  };
}

const PACE_LABEL = { relaxed: '慢节奏', balanced: '适中', intense: '紧凑' };
const HOTEL_LABEL = { budget: '经济', comfort: '舒适', boutique: '设计感/精品', luxury: '高端', homestay: '民宿', any: '不限' };
const TRANSPORT_LABEL = { public: '公共交通优先', drive: '自驾/包车', walk: '步行优先', mixed: '混合', any: '不限' };

/* ------------------------------------------------------------------ *
 * 知识库检索（按 ## 段落切分，命中即取）
 * ------------------------------------------------------------------ */

function splitKnowledge(text) {
  return String(text)
    .split(/(?=^##\s)/m)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((section, index) => ({
      id: index + 1,
      text: section,
      title: section.match(/^##\s+(.+)$/m)?.[1] || '知识段落',
    }));
}

function queryTerms(query) {
  const raw = String(query || '').toLowerCase();
  const terms = new Set(raw.match(/[a-z]{3,}|\d+/g) || []);
  for (const segment of raw.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let size = 2; size <= Math.min(4, segment.length); size++) {
      for (let i = 0; i + size <= segment.length; i++) terms.add(segment.slice(i, i + size));
    }
  }
  return [...terms];
}

/* ------------------------------------------------------------------ *
 * 实时联网搜索（零依赖，可插拔 provider）
 * ------------------------------------------------------------------ */

const SEARCH_TIMEOUT_MS = 8000;

export function buildSearchQueries(input) {
  const d = String(input?.destination || '').trim();
  if (!d) return [];
  const origin = String(input?.origin || '').trim();
  const queries = [
    `${d} 主要景点 开放时间 门票价格 2026`,
    `${d} 最佳旅游季节 天气 注意事项`,
    `${d} 推荐住宿区域 怎么去 交通`,
  ];
  if (origin && origin !== d) queries.push(`${origin} 到 ${d} 交通方式 时长`);
  return queries.slice(0, 4);
}

export function buildSearchQueriesByCategory(input) {
  const d = String(input?.destination || '').trim();
  if (!d) return { attractions: [], hotels: [], transport: [] };
  const budget = String(input?.budget || '').trim();
  const hotelLabel = {
    budget: '经济型', comfort: '舒适型', boutique: '设计感/精品',
    luxury: '高端', homestay: '民宿', any: '',
  }[input?.hotelPreference] || '';
  return {
    // 注意措辞：加了「价格」二字反而更容易搜到国内票务站，用「景点 门票 开放时间 官网」更准。
    attractions: [
      `${d} 景点 门票 开放时间 官网 2026`,
      `${d} 热门景点 是否需要预约 闭馆 检修`,
    ],
    // 实测「住宿 推荐 酒店 评分 评价」最干净；带上携程/Booking 这些站名反而会炸出聚合站和地图页
    hotels: [
      `${d} 住宿 推荐 酒店 评分 评价`,
      `${d}${hotelLabel ? ' ' + hotelLabel : ''}${budget ? ' 预算' + budget : ''} 酒店 口碑 评价 性价比`,
    ],
    transport: [
      `${d} 地铁 公交 线路 停运 施工 公告`,
      `${d} 交通 最新 调整 通知 2026`,
    ],
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function searchTavily(queries, { apiKey, signal, timeoutMs }) {
  const out = [];
  for (const q of queries) {
    const res = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ api_key: apiKey, query: q, max_results: 5, search_depth: 'basic' }),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const data = await res.json();
    out.push(packHits(q, (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content || r.snippet || '',
    }))));
  }
  return out;
}

/* ---------- 国产搜索：DeepSeek / 博查 / 智谱 ---------- */

// 各家把结果放在不同字段，统一归一化成 [{ query, results:[{title,url,snippet,site,icon}] }]
// site/icon 用来在前端「来源」旁边显示站点名和图标，没给图标就留空由前端退化成首字母块。
function packHits(query, items) {
  return {
    query,
    results: items
      .map((it) => {
        const url = String(it.url || '');
        let host = '';
        try { host = new URL(url).hostname.replace(/^www\./u, ''); } catch { host = ''; }
        return {
          title: sanitizeText(it.title, 160, { multiline: true }),
          url,
          snippet: sanitizeText(it.snippet, 320, { multiline: true }),
          site: sanitizeText(it.site || host, 48),
          icon: /^https?:\/\//u.test(String(it.icon || '')) ? String(it.icon) : '',
        };
      })
      .filter((r) => r.title || r.snippet)
      .slice(0, 5),
  };
}

// DeepSeek 官方搜索：POST /v1/tools/search，返回 { results:[{title,url,snippet,summary,content,...}] }
// 和模型共用同一把 key，不用另注册平台；按成功请求计费（失败、无结果不计费）。
export async function searchDeepseek(queries, { apiKey, signal, timeoutMs, baseUrl, fetchImpl } = {}) {
  const root = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  const doFetch = fetchImpl || fetchWithTimeout;
  const out = [];
  for (const q of queries) {
    const res = await doFetch(
      `${root}/v1/tools/search`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ query: q, count: 5, need_content: false }),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`deepseek ${res.status}`);
    const data = await res.json();
    out.push(packHits(q, (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      // summary 是给模型读的长摘要（600~800 字），优先用它
      snippet: r.summary || r.snippet || r.content || '',
      site: r.site_name,
      icon: r.site_icon,
    }))));
  }
  return out;
}

// 博查 Bocha：POST /v1/web-search，返回 { code, data:{ webPages:{ value:[{name,url,snippet,summary,...}] } } }
export async function searchBocha(queries, { apiKey, signal, timeoutMs, baseUrl, fetchImpl } = {}) {
  const root = String(baseUrl || 'https://api.bochaai.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  const doFetch = fetchImpl || fetchWithTimeout;
  const out = [];
  for (const q of queries) {
    const res = await doFetch(
      `${root}/v1/web-search`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ query: q, summary: true, freshness: 'noLimit', count: 5 }),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`bocha ${res.status}`);
    const data = await res.json();
    if (data.code && data.code !== 200) throw new Error(`bocha ${data.code} ${data.msg || ''}`.trim());
    const pages = data?.data?.webPages?.value || [];
    out.push(packHits(q, pages.map((r) => ({
      title: r.name,
      url: r.url,
      snippet: r.summary || r.snippet || '',
      site: r.siteName,
      icon: r.siteIcon,
    }))));
  }
  return out;
}

// 智谱 Web Search：POST /api/paas/v4/web_search，返回 { search_result:[{title,link,content,media,...}] }
export async function searchZhipu(queries, { apiKey, signal, timeoutMs, baseUrl, engine = 'search_pro', fetchImpl } = {}) {
  const root = String(baseUrl || 'https://open.bigmodel.cn').replace(/\/+$/, '');
  const doFetch = fetchImpl || fetchWithTimeout;
  const out = [];
  for (const q of queries) {
    const res = await doFetch(
      `${root}/api/paas/v4/web_search`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          search_engine: engine, search_query: q, count: 5,
          search_recency_filter: 'noLimit', content_size: 'high',
        }),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`zhipu ${res.status}`);
    const data = await res.json();
    out.push(packHits(q, (data.search_result || []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.content || '',
      site: r.media,
      icon: r.icon,
    }))));
  }
  return out;
}


async function searchSerper(queries, { apiKey, signal, timeoutMs }) {
  const out = [];
  for (const q of queries) {
    const res = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
        body: JSON.stringify({ q }),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`serper ${res.status}`);
    const data = await res.json();
    out.push(packHits(q, (data.organic || []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet || '',
    }))));
  }
  return out;
}

async function searchSearxng(queries, { baseUrl, signal, timeoutMs }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) throw new Error('searxng 需要配置 HUANTU_SEARCH_BASE_URL');
  const out = [];
  for (const q of queries) {
    const u = `${root}/search?q=${encodeURIComponent(q)}&format=json`;
    const res = await fetchWithTimeout(u, { signal, headers: { Accept: 'application/json' } }, timeoutMs);
    if (!res.ok) throw new Error(`searxng ${res.status}`);
    const data = await res.json();
    out.push(packHits(q, (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content || r.snippet || '',
    }))));
  }
  return out;
}

async function searchDuckDuckGo(queries, { signal, timeoutMs }) {
  const out = [];
  for (const q of queries) {
    const res = await fetchWithTimeout(
      'https://lite.duckduckgo.com/lite/',
      {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; Huantu/1.0)',
        },
        body: new URLSearchParams({ q, kl: 'cn-zh', b: '' }).toString(),
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
    const html = await res.text();
    const titles = [];
    const linkRe = /class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = linkRe.exec(html))) titles.push({ url: m[1], title: stripTags(m[2]) });
    const snippets = [];
    while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));
    out.push(packHits(q, titles.map((t, i) => ({
      title: t.title,
      url: t.url,
      snippet: snippets[i] || '',
    }))));
  }
  return out;
}

// Bing 的搜索结果链接是跳转壳：https://www.bing.com/ck/a?...&u=a1<base64url>
// 不解码的话「信息来源」面板里全是 bing 跳转，用户看不出真实站点。
function decodeBingUrl(href) {
  const h = String(href || '');
  const m = /[?&]u=a1([^&]+)/u.exec(h);
  if (!m) return h;
  try {
    let b = decodeURIComponent(m[1]).replace(/-/gu, '+').replace(/_/gu, '/');
    while (b.length % 4) b += '=';
    const real = Buffer.from(b, 'base64').toString('utf8');
    return /^https?:\/\//iu.test(real) ? real : h;
  } catch {
    return h;
  }
}

// Bing 结果页里的摘要常带实体（&ensp; / &#0183;），要先解码再去标签
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/gu, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/giu, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&ensp;|&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'");
}

// Bing 中国：零成本、免密钥，直接解析 /search 结果页的 <li class="b_algo">。
// 只在能访问 cn.bing.com 的网络里可用（国内直连正常；被墙环境会超时，由 runWebSearch 兜成 null）。
export async function searchBing(queries, { signal, timeoutMs, fetchImpl, market = 'zh-CN' } = {}) {
  const doFetch = fetchImpl || fetchWithTimeout;
  const out = [];
  for (const q of queries) {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}`
      + `&form=QBRE&setlang=zh-Hans&mkt=${encodeURIComponent(market)}`;
    const res = await doFetch(url, {
      method: 'GET',
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
    }, timeoutMs);
    if (!res.ok) throw new Error(`bing ${res.status}`);
    const html = await res.text();
    // b_algo 内部还有嵌套 li，按下一个 b_algo 切块再截断，避免摘要串到别的结果上
    const blocks = html.split(/<li class="b_algo"/u).slice(1);
    const items = blocks.map((b) => {
      const chunk = b.slice(0, 4000);
      const t = /<h2[^>]*>([\s\S]*?)<\/h2>/u.exec(chunk);
      const a = /<a[^>]+href="([^"]+)"/u.exec(chunk);
      const p = /<p[^>]*>([\s\S]*?)<\/p>/u.exec(chunk);
      return {
        title: decodeEntities(stripTags(t ? t[1] : '')),
        url: decodeBingUrl(a ? a[1] : ''),
        snippet: decodeEntities(stripTags(p ? p[1] : '')),
      };
    }).filter((it) => it.title && /^https?:\/\//u.test(it.url));
    const packed = packHits(q, items);
    writeSearchCache('bing', q, packed);
    out.push(packed);
  }
  return out;
}

// 搜索结果缓存：同一查询 10 分钟内复用，避免重复抓取触发反爬（也省时间）
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function readSearchCache(provider, q) {
  const key = `${provider}\u0000${q}`;
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.data;
}

function writeSearchCache(provider, q, data) {
  if (searchCache.size >= 200) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
  searchCache.set(`${provider}\u0000${q}`, { at: Date.now(), data });
}

// 仅供测试：清空搜索缓存与限流冷却，避免用例之间互相污染
export function resetSearchState() {
  searchCache.clear();
  sogouCooldownUntil = 0;
  baiduCooldownUntil = 0;
}

// 搜狗：零成本、免密钥。中文长尾查询（开放时间/门票/预约）的相关性明显好于 Bing。
// 结果块 <div class="vrwrap">；真实地址在 data-url 上，href 是 /link?url= 跳转壳。
// 注意：连续请求会被 302 到 antispider 验证页，所以要限速（SOGOU_GAP_MS）；
// 一旦被抓就冷却 5 分钟，冷却期内直接快速失败交给 auto 走 Bing，不再拖慢主流程。
const SOGOU_GAP_MS = 800;
const SOGOU_COOLDOWN_MS = 5 * 60 * 1000;
let sogouCooldownUntil = 0;

export async function searchSogou(queries, { signal, timeoutMs, fetchImpl } = {}) {
  if (Date.now() < sogouCooldownUntil) {
    throw new Error('sogou 冷却中（上次触发反爬）');
  }
  const doFetch = fetchImpl || fetchWithTimeout;
  const out = [];
  let fresh = 0;
  let lastErr = null;
  for (const q of queries) {
    const cached = readSearchCache('sogou', q);
    if (cached) {
      out.push(cached);
      continue;
    }
    if (fresh++ > 0) await sleep(SOGOU_GAP_MS);
    // 单条失败不算整体失败：中途被限流时保住已拿到的结果，全挂了才让上层换源
    try {
      const res = await doFetch(
        `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
        {
          method: 'GET',
          signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Accept: 'text/html,application/xhtml+xml',
          },
        },
        timeoutMs,
      );
      if (!res.ok) throw new Error(`sogou ${res.status}`);
      const html = await res.text();
      // 命中反爬验证就不硬啃，交给上层换源
      if (/antispider|请输入验证码|验证码/u.test(html.slice(0, 20000))) throw new Error('sogou 触发反爬验证');
      const clean = (s) => decodeEntities(stripTags(String(s || '').replace(/<!--[\s\S]*?-->/gu, '')));
      const blocks = html.split(/<div class="vrwrap"/u).slice(1);
      const items = blocks.map((b) => {
        const chunk = b.slice(0, 6000);
        const title = /<h3[^>]*>([\s\S]*?)<\/h3>/u.exec(chunk);
        const dataUrl = /data-url="(https?:\/\/[^"]+)"/u.exec(chunk);
        const href = /<a[^>]+href="([^"]+)"/u.exec(chunk);
        const snippet = /class="(?:fz-mid[^"]*|star-wiki[^"]*|space-txt[^"]*)"[^>]*>([\s\S]*?)<\//u.exec(chunk);
        const cite = /class="citeLinkClass[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/u.exec(chunk);
        let url = dataUrl ? dataUrl[1] : (href ? href[1] : '');
        if (url.startsWith('/link')) url = `https://www.sogou.com${url}`;
        return {
          title: clean(title ? title[1] : ''),
          url,
          snippet: clean(snippet ? snippet[1] : ''),
          site: clean(cite ? cite[1] : ''),
        };
      }).filter((it) => it.title && /^https?:\/\//u.test(it.url));
      const packed = packHits(q, items);
      writeSearchCache('sogou', q, packed);
      out.push(packed);
    } catch (e) {
      lastErr = e;
      if (/反爬|验证/u.test(e.message)) sogouCooldownUntil = Date.now() + SOGOU_COOLDOWN_MS;
    }
  }
  if (!out.length && lastErr) throw lastErr;
  return out;
}

// 百度：中文长尾（开放时间 / 门票 / 是否要预约）相关性明显好于 Bing，
// 且结果块的 mu 属性直接给出目标地址，不用去解 /link?url= 跳转链。
// 代价是风控最严：命中图形验证码就把整个通道冷却半小时，期间直接快速失败不拖慢生成。
const BAIDU_GAP_MS = 900;
const BAIDU_COOLDOWN_MS = 30 * 60 * 1000;
let baiduCooldownUntil = 0;

// 解析百度结果页。返回 [{title,url,snippet}]。
// 结果块是 <div class="result c-container"> 这类；内部还有 cosc-card 之类的新版卡片，
// 统一按 c-container 切块，拿不到 h3 的块直接跳过（广告位、百科卡片常没有 h3）。
export function parseBaiduResults(html) {
  const clean = (s) => decodeEntities(stripTags(String(s || '').replace(/<!--[\s\S]*?-->/gu, '')));
  const blocks = String(html || '').split(/<div[^>]+class="[^"]*c-container/u).slice(1);
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    // split 把开标签切在 c-container 处，块开头还残留半截属性（srcid/tpl/mu…）。
    // 不跳过这段，「摘要」里就会混进 xpath-log new-pmd" srcid="1599" 这类垃圾。
    const tagEnd = b.indexOf('>');
    if (tagEnd < 0) continue;
    const attrs = b.slice(0, tagEnd);
    const chunk = b.slice(tagEnd + 1, tagEnd + 1 + 6000);
    const t = /<h3[^>]*>([\s\S]*?)<\/h3>/u.exec(chunk);
    if (!t) continue;
    const title = clean(t[1]);
    if (!title) continue;
    // mu 是目标站真实地址，可能在开标签上，也可能在块内子元素上
    const mu = /mu="(https?:\/\/[^"]+)"/u.exec(attrs) || /mu="(https?:\/\/[^"]+)"/u.exec(chunk);
    const href = /<a[^>]+href="(https?:\/\/[^"]+)"/u.exec(chunk);
    // 属性里的 & 常被转义成 &amp;，不解开会得到坏链
    const url = decodeEntities(mu ? mu[1] : (href ? href[1] : '')).replace(/&amp;/gu, '&');
    if (!url || seen.has(url)) continue;
    // 竞价广告：ec_* 推广位没有 mu，只有跳转链
    if (!mu && /ec_/u.test(attrs + chunk.slice(0, 500))) continue;
    seen.add(url);
    const plain = clean(
      chunk
        .replace(/<script[\s\S]*?<\/script>/giu, ' ')
        .replace(/<style[\s\S]*?<\/style>/giu, ' ')
        .replace(/<[^>]+>/gu, ' '),
    ).replace(/\s+/gu, ' ').trim();
    const snippet = plain.replace(title, '').trim().slice(0, 220);
    out.push({ title, url, snippet });
  }
  return out;
}

export async function searchBaidu(queries, { signal, timeoutMs, fetchImpl } = {}) {
  if (Date.now() < baiduCooldownUntil) {
    throw new Error('baidu 冷却中（出口 IP 被要求过验证码）');
  }
  const doFetch = fetchImpl || fetchWithTimeout;
  const out = [];
  let fresh = 0;
  let lastErr = null;
  for (const q of queries) {
    const cached = readSearchCache('baidu', q);
    if (cached) {
      out.push(cached);
      continue;
    }
    if (fresh++ > 0) await sleep(BAIDU_GAP_MS);
    // 单条失败不整体失败：中途被拦时保住已拿到的结果，全挂了才让上层换通道
    try {
      const res = await doFetch(
        `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=10&ie=utf-8`,
        {
          method: 'GET',
          signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Accept: 'text/html,application/xhtml+xml',
          },
        },
        timeoutMs,
      );
      if (!res.ok) throw new Error(`baidu ${res.status}`);
      // 云主机出口经常被 302 到 wappass 图形验证码，跟随跳转后 URL 会变
      if (/wappass\.baidu\.com|captcha/u.test(res.url || '')) throw new Error('baidu 要求验证码');
      const html = await res.text();
      if (/wappass\.baidu\.com|百度安全验证|请输入验证码/u.test(html.slice(0, 8000))) {
        throw new Error('baidu 要求验证码');
      }
      const items = parseBaiduResults(html);
      if (!items.length) throw new Error('baidu 结果为空（可能被风控）');
      const packed = packHits(q, items);
      writeSearchCache('baidu', q, packed);
      out.push(packed);
    } catch (e) {
      lastErr = e;
      if (/验证码|验证/u.test(e.message)) baiduCooldownUntil = Date.now() + BAIDU_COOLDOWN_MS;
    }
  }
  if (!out.length && lastErr) throw lastErr;
  return out;
}

// 搜索 provider 的中文展示名，用于「信息来源」面板
export const SEARCH_PROVIDER_LABEL = {
  auto: '百度 + 搜狗 + Bing（免密钥）',
  baidu: '百度（免密钥）',
  sogou: '搜狗（免密钥）',
  bing: 'Bing 中国（免密钥）',
  deepseek: 'DeepSeek 搜索',
  bocha: '博查 Bocha',
  zhipu: '智谱 Web Search',
  tavily: 'Tavily',
  serper: 'Serper',
  searxng: 'SearXNG',
  duckduckgo: 'DuckDuckGo',
  off: '未启用',
};

// 返回 [{ query, results:[{title,url,snippet}] }] 或 null（失败/未启用时降级为 null，不阻断主流程）。
export async function runWebSearch(queries, { provider = 'auto', apiKey = '', baseUrl = '', engine = '', signal, timeoutMs = SEARCH_TIMEOUT_MS, logger, fetchImpl } = {}) {
  if (!queries?.length) return null;
  try {
    switch (provider) {
      // auto：百度（中文长尾最准）→ 搜狗 → Bing（最稳但容易泛化）。
      // 三连都会先查缓存；任一通道给出结果就停，全挂才返回 null 让上层降级。
      case 'auto': {
        const chain = [
          ['百度', () => searchBaidu(queries, { signal, timeoutMs, fetchImpl })],
          ['搜狗', () => searchSogou(queries, { signal, timeoutMs, fetchImpl })],
          ['Bing', () => searchBing(queries, { signal, timeoutMs, fetchImpl })],
        ];
        let lastErr = null;
        for (const [name, run] of chain) {
          try {
            const r = await run();
            if (r?.some((x) => x.results?.length)) return r;
            logger?.warn?.(`${name}无结果，换下一个通道`);
          } catch (e) {
            lastErr = e;
            logger?.warn?.(`${name}失败（${e.message}），换下一个通道`);
          }
        }
        if (lastErr) throw lastErr;
        return [];
      }
      case 'baidu': return await searchBaidu(queries, { signal, timeoutMs, fetchImpl });
      case 'sogou': return await searchSogou(queries, { signal, timeoutMs, fetchImpl });
      case 'bing': return await searchBing(queries, { signal, timeoutMs, fetchImpl });
      case 'deepseek': return await searchDeepseek(queries, { apiKey, baseUrl, signal, timeoutMs, fetchImpl });
      case 'bocha': return await searchBocha(queries, { apiKey, baseUrl, signal, timeoutMs, fetchImpl });
      case 'zhipu': return await searchZhipu(queries, { apiKey, baseUrl, engine, signal, timeoutMs, fetchImpl });
      case 'tavily': return await searchTavily(queries, { apiKey, signal, timeoutMs });
      case 'serper': return await searchSerper(queries, { apiKey, signal, timeoutMs });
      case 'searxng': return await searchSearxng(queries, { baseUrl, signal, timeoutMs });
      case 'duckduckgo':
      default: return await searchDuckDuckGo(queries, { signal, timeoutMs });
    }
  } catch (e) {
    logger?.warn?.(`实时搜索失败（${provider}）：${e.message}`);
    return null;
  }
}

/**
 * 一类搜索的缓存键：由查询词内容决定，同城但预算/住宿偏好不同会落到不同条目。
 * 这样「杭州 经济型」和「杭州 高端」不会互相串味，而同样的问法能整年复用。
 */
export function searchCacheKey(category, queries) {
  const sig = createHash('sha1').update((queries || []).join('|')).digest('hex').slice(0, 10);
  return `${category}:${sig}`;
}

export async function runSearchByCategory(input, cfg = {}, signal) {
  const q = buildSearchQueriesByCategory(input);
  const { library, usage } = cfg;
  const city = library ? libraryCityOf(input?.destination) : '';

  // 每一类都是「先查知识库，没有再联网，搜到立刻回写」
  const one = async (category) => {
    const list = q[category];
    if (!list?.length) return null;
    if (!library) return runWebSearch(list, { ...cfg, signal });

    const key = searchCacheKey(category, list);
    const look = library.lookup({ city, kind: 'search', key });
    if (look.hit) {
      usage?.noteHit?.({ kind: 'search', label: category, state: look.state, ageDays: look.ageDays });
      // 打上 cached 标记，向上层（prompt）说明这批结果不是刚抓的
      return (look.entry.data?.groups || []).map((g) => ({
        ...g,
        cached: true,
        cachedAt: look.entry.updatedAt,
        ageDays: look.ageDays,
        stale: Boolean(look.stale),
      }));
    }

    const found = await runWebSearch(list, { ...cfg, signal });
    if (found && found.some((g) => g.results?.length)) {
      library.store({
        city,
        kind: 'search',
        key,
        data: { groups: found },
        query: list.join(' | '),
        provider: String(cfg.provider || 'auto'),
        sources: found.flatMap((g) => g.results || []),
      });
      usage?.noteMiss?.({ kind: 'search', label: category, reason: look.reason });
    } else {
      usage?.noteFail?.({ kind: 'search', label: category });
    }
    return found;
  };

  const [attractions, hotels, transport] = await Promise.all([
    one('attractions'),
    one('hotels'),
    one('transport'),
  ]);
  const d = input?.destination;
  return {
    attractions: filterRelevantHits(attractions, d),
    hotels: filterRelevantHits(hotels, d),
    transport: filterRelevantHits(transport, d),
  };
}

/* ------------------------------------------------------------------ *
 * 实时天气（Open-Meteo，免费、免 key）
 * ------------------------------------------------------------------ */

const WEATHER_TIMEOUT_MS = 8000;

const WEATHER_CODE_CN = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '强毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪',
  95: '雷雨', 96: '雷雨伴小冰雹', 99: '雷雨伴大冰雹',
};

function weatherCodeCN(code) {
  return WEATHER_CODE_CN[code] || `天气代码${code}`;
}

// 常见国家/地区前缀：用来从「日本京都」「泰国曼谷」里剥出真正的地名。
const COUNTRY_PREFIXES = [
  '日本', '中国', '韩国', '朝鲜', '泰国', '越南', '新加坡', '马来西亚', '印度尼西亚', '印尼',
  '菲律宾', '柬埔寨', '老挝', '缅甸', '尼泊尔', '不丹', '蒙古', '印度', '斯里兰卡', '马尔代夫',
  '美国', '加拿大', '墨西哥', '巴西', '阿根廷', '智利', '秘鲁', '古巴',
  '英国', '爱尔兰', '法国', '德国', '意大利', '西班牙', '葡萄牙', '希腊', '荷兰', '比利时',
  '瑞士', '奥地利', '捷克', '匈牙利', '波兰', '冰岛', '挪威', '瑞典', '芬兰', '丹麦', '俄罗斯',
  '土耳其', '埃及', '摩洛哥', '南非', '肯尼亚', '以色列', '约旦', '阿联酋', '澳大利亚', '新西兰',
];

/** 把「日本京都」这类写法拆成候选地名：['日本京都', '京都'] */
export function destinationTokens(destination) {
  const d = String(destination || '').trim();
  if (!d) return [];
  const set = new Set([d]);
  for (const p of COUNTRY_PREFIXES) {
    if (d.startsWith(p) && d.length > p.length + 1) set.add(d.slice(p.length).trim());
  }
  for (const t of [...set]) {
    const stripped = t.replace(/(特别行政区|自治区|地区|市|省|县|府|州|都)$/u, '').trim();
    // 剥完至少剩两个字才算有效（「京都」剥「都」只剩「京」，那就别剥）
    if (stripped.length >= 2 && stripped !== t) set.add(stripped);
  }
  return [...set].filter(Boolean);
}

// 去掉与目的地完全无关的搜索结果（例如搜「京都景点」却返回抽奖页面）。
// 过滤后太少（<3 条）就退回原结果：宁可留点噪音，也不要把结果削没。
export function filterRelevantHits(groups, destination) {
  if (!groups) return groups;
  const tokens = destinationTokens(destination).map((t) => t.toLowerCase());
  if (!tokens.length) return groups;
  return (groups || []).map((g) => {
    const all = g.results || [];
    const kept = all.filter((r) => {
      const hay = `${r.title || ''} ${r.snippet || ''} ${r.url || ''}`.toLowerCase();
      return tokens.some((t) => hay.includes(t));
    });
    return { ...g, results: kept.length >= 3 ? kept : all };
  });
}

async function geocodeDestination(name) {
  for (const candidate of destinationTokens(name)) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=1&language=zh&format=json`;
    const res = await fetchWithTimeout(url, {}, WEATHER_TIMEOUT_MS);
    if (!res.ok) throw new Error(`geocoding ${res.status}`);
    const data = await res.json();
    const hit = (data.results || [])[0];
    if (hit) {
      return { lat: hit.latitude, lon: hit.longitude, timezone: hit.timezone || 'auto', name: hit.name, country: hit.country };
    }
  }
  return null;
}

// 预报只覆盖未来约 16 天；出行日期更远时改用去年同期实测，标明是气候参考而非预报。
export async function fetchHistoricalSamePeriod(geo, startDate, endDate) {
  const shift = (iso, years) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    return d.toISOString().slice(0, 10);
  };
  const params = new URLSearchParams({
    latitude: String(geo.lat),
    longitude: String(geo.lon),
    start_date: shift(startDate, 1),
    end_date: shift(endDate, 1),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: geo.timezone || 'auto',
  });
  const res = await fetchWithTimeout(`https://archive-api.open-meteo.com/v1/archive?${params}`, {}, WEATHER_TIMEOUT_MS);
  if (!res.ok) throw new Error(`archive ${res.status}`);
  const data = await res.json();
  const daily = data.daily || {};
  const times = daily.time || [];
  // 历史接口给的是去年日期，对外统一映射回本次出行年份，否则页面会显示成去年的日子。
  const tripStart = new Date(`${startDate}T00:00:00Z`);
  const days = times.map((t, i) => {
    const mapped = new Date(tripStart.getTime());
    mapped.setUTCDate(mapped.getUTCDate() + i);
    const safeDate = Number.isNaN(mapped.getTime()) ? t : mapped.toISOString().slice(0, 10);
    return {
      date: safeDate,
      archiveDate: t,
      summary: weatherCodeCN(daily.weather_code?.[i]),
      tmax: daily.temperature_2m_max?.[i],
      tmin: daily.temperature_2m_min?.[i],
      precip: null,
      rainMm: daily.precipitation_sum?.[i],
      label: '去年同期实测',
    };
  });
  return days;
}

export async function getTripWeather(destination, startDate, endDate, logger) {
  try {
    const geo = await geocodeDestination(destination);
    if (!geo) return null;
    const params = new URLSearchParams({
      latitude: String(geo.lat),
      longitude: String(geo.lon),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: geo.timezone || 'auto',
      start_date: startDate,
      end_date: endDate,
    });
    const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${params}`, {}, WEATHER_TIMEOUT_MS);
    if (!res.ok) throw new Error(`forecast ${res.status}`);
    const data = await res.json();
    const daily = data.daily || {};
    const times = daily.time || [];
    const days = times.map((t, i) => ({
      date: t,
      summary: weatherCodeCN(daily.weather_code?.[i]),
      tmax: daily.temperature_2m_max?.[i],
      tmin: daily.temperature_2m_min?.[i],
      precip: daily.precipitation_probability_max?.[i],
      label: '预报',
    }));
    if (!days.length) return null;
    return {
      source: 'Open-Meteo（ECMWF/GFS 数值预报）',
      url: 'https://open-meteo.com/',
      place: geo.name,
      timezone: geo.timezone,
      kind: 'forecast',
      days,
    };
  } catch (e) {
    logger?.warn?.(`实时天气获取失败：${e.message}`);
    // 兜底一：日期超出预报范围 → 去年同期实测（气候参考）
    try {
      const geo = await geocodeDestination(destination);
      if (geo) {
        const days = await fetchHistoricalSamePeriod(geo, startDate, endDate);
        if (days.length) {
          logger?.warn?.('出行日期超出现报范围，改用去年同期实测作为气候参考');
          return {
            source: 'Open-Meteo 历史同期数据',
            url: 'https://open-meteo.com/',
            place: geo.name,
            timezone: geo.timezone,
            kind: 'climate',
            days,
          };
        }
      }
    } catch (e2) {
      logger?.warn?.(`历史气候兜底也失败：${e2.message}`);
    }
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 地点配图（零 key：抓搜索结果页面的 og:image）
 * ------------------------------------------------------------------ */

const PHOTO_TIMEOUT_MS = 9000;
const PHOTO_MAX_HTML = 400 * 1024;

// 从页面 HTML 里抠 og:image / twitter:image，相对路径补全成绝对地址
export function extractOgImage(html, pageUrl) {
  const head = String(html || '').slice(0, PHOTO_MAX_HTML);
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]*content=["']([^"']+)["']/iu,
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/iu,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/iu,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/iu,
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (!m) continue;
    let raw = m[1].trim().replace(/&amp;/gu, '&');
    try {
      const abs = new URL(raw, pageUrl);
      // CSP 只放行 https 图片，http 一律升级，升级不了就放弃
      if (abs.protocol === 'http:') abs.protocol = 'https:';
      if (abs.protocol !== 'https:') continue;
      return abs.toString();
    } catch { continue; }
  }
  return '';
}

async function fetchPageOgImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Huantu/1.0; +https://open-meteo.com/)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return '';
    const type = String(res.headers.get('content-type') || '');
    if (!type.includes('html')) return '';
    const html = await res.text();
    return extractOgImage(html, res.url || url);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 站点默认分享图（ogp / logo / banner 这类）没有辨识度，宁可没有图也不用它
export function isSiteDefaultImage(imageUrl) {
  const p = (() => { try { return new URL(imageUrl).pathname.toLowerCase(); } catch { return ''; } })();
  if (/(ogp|og-image|og_image|default|placeholder|logo|banner|share-?(default|image)|site-?image)/u.test(p)) return true;
  // 社交站的分享图：/fb.png、/sns.jpg 这类基本是通用图，不是景点照片
  return /(^|\/)(fb|sns|social|share)\.(png|jpe?g|webp|gif)$/u.test(p);
}

/* ---------- 网页正文抓取 ---------- */
//
// 搜索结果只有一两句摘要，门票价格、开放时间、是否需要预约这些细节基本写不全。
// 把前几条结果的真实网页正文抓回来喂给模型，研究质量才上得来。
// 这里只做「粗提取」——按标签切、去掉导航与脚本、取主干、压空白，不追求还原版式；
// 拿不到正文就返回 null，让上层退回摘要，绝不编造。

const ARTICLE_TIMEOUT_MS = 8000;
const ARTICLE_MAX_BYTES = 2 * 1024 * 1024;
const BODY_CONCURRENCY = 3;

// 从 HTML 里抠出标题与正文纯文本。纯函数，测试里直接喂字符串。
export function extractArticleText(html) {
  const raw = String(html || '');
  if (!raw) return { title: '', text: '', chars: 0 };
  const title = decodeEntities(
    (/<title[^>]*>([\s\S]{0,300}?)<\/title>/iu.exec(raw)?.[1] || '').trim(),
  ).replace(/\s+/gu, ' ').trim();

  // 整块删除：这些标签里的字符永远不会是正文
  let body = raw.replace(
    /<(script|style|nav|header|footer|aside|form|iframe|noscript|svg|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1>/giu,
    ' ',
  );
  // 主干优先：article > main > 带 content/article/main/detail 的容器；
  // 都匹配不到就用整页，靠后面的段落启发式把导航碎片筛掉。
  const main = /<article\b[^>]*>([\s\S]*?)<\/article>/iu.exec(body)
    || /<main\b[^>]*>([\s\S]*?)<\/main>/iu.exec(body)
    || /<div[^>]+(?:id|class)="[^"]*(?:article|content|main|detail|post|entry)[^"]*"[^>]*>([\s\S]*)/iu.exec(body);
  if (main) body = main[1];

  const toText = (frag) => decodeEntities(
    String(frag)
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|dd|dt)>/giu, '\n')
      .replace(/<[^>]+>/gu, ' '),
  )
    .replace(/[ \t\u00a0\u3000]+/gu, ' ')
    .split('\n')
    .map((l) => l.trim())
    // 单字行基本都是导航/按钮碎片，留下来只会污染 prompt
    .filter((l) => l.length > 1)
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  // 段落优先：有足够多 <p> 说明这是篇文章，导航菜单几乎不会写成 <p>。
  // 命中就只用段落拼正文，能把大半站点的菜单噪声挡在外面；否则退回整页文本。
  const paras = [];
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)) {
    const t = toText(m[1]).replace(/\n+/gu, ' ').trim();
    if (t.length >= 20) paras.push(t);
  }
  const text = paras.length >= 3 ? paras.join('\n') : toText(body);

  return { title, text, chars: text.length };
}

// 抓一篇文章正文。失败一律返回 null（非 HTML、超大页面、被拦都算），不抛异常。
export async function fetchArticleText(url, { maxChars = 1200, timeoutMs = ARTICLE_TIMEOUT_MS, signal, fetchImpl } = {}) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (!/^https?:$/u.test(parsed.protocol)) return null;
  const doFetch = fetchImpl || fetchWithTimeout;
  try {
    const res = await doFetch(url, {
      method: 'GET',
      signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    }, timeoutMs);
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '');
    // 只读网页；PDF/图片/JSON 一律跳过
    if (type && !/text\/html|text\/plain|application\/xhtml/u.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > ARTICLE_MAX_BYTES) return null;
    // 国内站点大量是 GBK/GB2312，按 utf-8 解会整片乱码
    const head = buf.subarray(0, 4096).toString('latin1');
    const charset = (
      /charset\s*=\s*["']?([\w-]+)/iu.exec(type)?.[1]
      || /charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1]
      || 'utf-8'
    ).toLowerCase();
    let html = '';
    try { html = new TextDecoder(charset, { fatal: false }).decode(buf); }
    catch { html = buf.toString('utf8'); }

    const { title, text } = extractArticleText(html);
    if (text.length < 80) return null; // 纯 JS 渲染或登录墙，宁可没有
    const cut = text.length > maxChars ? text.slice(0, maxChars) : text;
    return { title, url: res.url || url, text: cut, chars: cut.length, truncated: text.length > maxChars };
  } catch {
    return null;
  }
}

/**
 * 给搜索结果补正文：每类取前 2 条 → 全局去重 → 最多抓 max 篇（并发 3）。
 * 抓到就把正文挂在 hit.body 上，研究 prompt 优先用 body，没抓到退回 snippet。
 */
export async function enrichWithBodies(groups, { max = 6, maxChars = 1200, signal, fetchImpl, logger } = {}) {
  const picks = [];
  const seen = new Set();
  for (const key of ['attractions', 'hotels', 'transport']) {
    for (const g of groups?.[key] || []) {
      for (const r of (g.results || []).slice(0, 2)) {
        if (!r?.url || seen.has(r.url)) continue;
        seen.add(r.url);
        picks.push(r);
      }
    }
  }
  const queue = picks.slice(0, max);
  const attempted = queue.length;
  if (!attempted) return { attempted: 0, ok: 0 };
  let ok = 0;
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) return;
      const hit = queue.shift();
      const page = await fetchArticleText(hit.url, { maxChars, signal, fetchImpl });
      if (!page) continue;
      hit.body = page.text;
      ok += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BODY_CONCURRENCY, attempted) }, worker));
  logger?.info?.(`正文抓取：${ok}/${attempted} 篇`);
  return { attempted, ok };
}


function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return ''; }
}

// 「京都站周边舒适型酒店（示例）」这种不是具体地点，搜出来也是错的图，直接跳过
export function isConcretePlace(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 40) return false;
  if (/(示例|待定|周边|一带|区域|附近|类型|某|TBD|待核实)/u.test(n)) return false;
  return true;
}

/**
 * 给「推荐的地方」找一张实景图：
 * 1) 先看已有搜索结果里标题包含该地名的链接（不额外搜索）
 * 2) 没有再补一次搜索，取前两条候选页面
 * 3) 抓页面的 og:image，失败就放弃（前端不显示图，不会留空框）
 */
export async function collectPlacePhotos(places, { cfg = {}, groups = null, destination = '', logger, signal, library = null, usage = null } = {}) {
  const list = (places || []).filter((p) => p && isConcretePlace(p.name)).slice(0, 9);
  if (!list.length) return {};
  const canSearch = Boolean(cfg.provider) && cfg.provider !== 'off';
  const fromGroups = (groups || []).flatMap((g) => g.results || []);
  const city = library ? libraryCityOf(destination) : '';

  const job = async (place) => {
    const name = String(place.name).trim();

    // 配图 URL 是最值得缓存的东西：抓一次 og:image 要打开一整个页面，几百 KB 就为了一张图。
    if (library) {
      const look = library.lookup({ city, kind: 'photo', key: name });
      if (look.hit && look.entry.data?.image) {
        usage?.noteHit?.({ kind: 'photo', label: name, state: look.state, ageDays: look.ageDays });
        return {
          name,
          image: look.entry.data.image,
          sourceUrl: look.entry.data.sourceUrl || '',
          sourceName: look.entry.data.sourceName || '',
          cached: true,
          cachedAt: look.entry.updatedAt,
        };
      }
    }

    const urls = [];
    // 标题里带这个地名的页面，图最可能对得上
    for (const r of fromGroups) {
      if (r && r.url && String(r.title || '').includes(name) && !urls.includes(r.url)) urls.push(r.url);
    }
    if (canSearch && urls.length < 3) {
      const q = `${name} ${destination} ${place.kind === 'hotel' ? '酒店 官网' : '景点 官网'}`.trim();
      const found = await runWebSearch([q], { ...cfg, signal, logger });
      for (const g of found || []) {
        for (const r of g.results || []) {
          if (r.url && !urls.includes(r.url)) urls.push(r.url);
        }
      }
    }
    for (const url of urls.slice(0, 4)) {
      const image = await fetchPageOgImage(url);
      if (image && !isSiteDefaultImage(image)) {
        const hit = { name, image, sourceUrl: url, sourceName: hostLabel(url) };
        if (library) {
          library.store({
            city,
            kind: 'photo',
            key: name,
            data: hit,
            query: `${name} 官网配图`,
            provider: String(cfg.provider || ''),
            sources: [{ title: name, url, site: hit.sourceName }],
          });
        }
        usage?.noteMiss?.({ kind: 'photo', label: name, reason: 'miss' });
        return hit;
      }
    }
    return null;
  };

  // 并发上限 5，避免把对方站点打爆
  const results = [];
  const queue = [...list];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const place = queue.shift();
      try {
        const r = await job(place);
        if (r) results.push(r);
      } catch (e) {
        logger?.warn?.(`配图失败（${place?.name}）：${e.message}`);
      }
    }
  });
  await Promise.all(workers);

  const out = {};
  for (const r of results) {
    out[r.name] = {
      image: r.image,
      sourceUrl: r.sourceUrl,
      sourceName: r.sourceName,
      ...(r.cached ? { cached: true, cachedAt: r.cachedAt } : {}),
    };
  }
  return out;
}
// 单个景点卡片的「实时查到」：把官网/媒体里带具体票价、开放时间的条目挑出来，
// 免得每张卡片只剩一句「待核实」——那不是谨慎，是白搜了一场。
const OFFICIAL_HOST_HINT = /(\.go\.jp$|\.or\.jp$|\.jp$|\.travel$|\.gov$|\.lg\.jp$)/iu;

export function pickSpotFacts(name, results, limit = 3) {
  const key = String(name || '').trim();
  if (!key) return [];
  const hits = (results || []).filter((r) => r && r.url && `${r.title || ''} ${r.snippet || ''}`.includes(key));
  const scored = hits.map((r, i) => ({
    r,
    i,
    // 标题里就点名这个景点的，比「摘要里顺带提一句」更可能是它自己的页面
    inTitle: String(r.title || '').includes(key) ? 0 : 1,
    official: OFFICIAL_HOST_HINT.test(hostLabel(r.url)) ? 0 : 1,
  }));
  scored.sort((a, b) => a.inTitle - b.inTitle || a.official - b.official || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.r);
}

export async function collectSpotFacts(places, { cfg = {}, destination = '', signal, logger, maxPlaces = 8, library = null, usage = null } = {}) {
  const facts = {};
  const misses = {};
  const searchOn = Boolean(cfg.provider) && cfg.provider !== 'off';
  const city = library ? libraryCityOf(destination) : '';

  // 先把不能搜、搜不了的挑出来，逐条记下原因——这些东西比一句「待核实」有用得多
  const names = [];
  for (const p of places || []) {
    const n = String(p?.name || '').trim();
    if (!n) continue;
    if (!isConcretePlace(n)) {
      misses[n] = { reason: 'not_concrete', detail: '这更像一个类型词或占位名，不是能直接搜的地点' };
      continue;
    }
    if (!names.includes(n)) names.push(n);
  }

  // 先吃掉知识库里已有的：同一座城市的同一个景点，没必要每次都重搜一遍。
  // 注意这一步放在「没开搜索」判断之前 —— 即使这次关掉联网，库里的旧账也还能用。
  const pending = [];
  for (const n of names) {
    if (library) {
      const look = library.lookup({ city, kind: 'spot', key: n });
      if (look.hit) {
        facts[n] = {
          ...(look.entry.data || {}),
          name: n,
          cached: true,
          cachedAt: look.entry.updatedAt,
          ageDays: look.ageDays,
          stale: Boolean(look.stale),
        };
        usage?.noteHit?.({ kind: 'spot', label: n, state: look.state, ageDays: look.ageDays });
        continue;
      }
    }
    pending.push(n);
  }

  if (!searchOn) {
    for (const n of pending) {
      misses[n] = { reason: 'search_off', detail: '这次没有开启联网检索，知识库里也还没有这个景点的记录' };
    }
    return { facts, misses };
  }

  const list = pending.slice(0, maxPlaces);
  for (const n of pending.slice(maxPlaces)) {
    misses[n] = { reason: 'over_limit', detail: `一次最多核对前 ${maxPlaces} 个景点，这个排在后面没有查` };
  }

  const job = async (name) => {
    // 「岚山竹林与渡月桥」这种复合名，整串拿去搜命中率很低，取前半段
    const shortName = name.split(/[与·、/／]/u)[0].trim();
    const q = `${destination} ${shortName || name} 门票 开放时间 官网`.trim();

    let found = null;
    try {
      found = await runWebSearch([q], { ...cfg, signal, logger });
    } catch (e) {
      misses[name] = { reason: 'failed', query: q, detail: `搜索接口报错：${String(e.message).slice(0, 60)}` };
      return;
    }
    if (found === null) {
      misses[name] = { reason: 'failed', query: q, detail: '搜索接口没有正常返回（网络不通、超时或配额用尽）' };
      return;
    }

    const all = (found || []).flatMap((g) => g.results || []);
    if (!all.length) {
      misses[name] = { reason: 'no_results', query: q, detail: '搜索引擎没有返回任何条目' };
      return;
    }

    let picked = pickSpotFacts(name, all, 3);
    if (!picked.length && shortName && shortName !== name) picked = pickSpotFacts(shortName, all, 3);
    if (!picked.length) {
      misses[name] = {
        reason: 'no_match',
        query: q,
        detail: `搜到 ${all.length} 条，但没有一条是「${shortName || name}」自己的页面，命中的多是攻略、游记或别的景点`,
      };
      return;
    }
    facts[name] = { name, query: q, results: picked };
    // 搜到就立刻落库：同一景点下次再来，直接拿这份，不再打搜索引擎
    if (library) {
      library.store({
        city,
        kind: 'spot',
        key: name,
        data: { name, query: q, results: picked },
        query: q,
        provider: String(cfg.provider || ''),
        sources: picked,
      });
    }
    usage?.noteMiss?.({ kind: 'spot', label: name, reason: 'miss' });
  };

  const queue = [...list];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const name = queue.shift();
      try {
        await job(name);
      } catch (e) {
        logger?.warn?.(`景点票价补搜失败（${name}）：${e.message}`);
        misses[name] = { reason: 'failed', detail: `补搜过程出错：${String(e.message).slice(0, 60)}` };
      }
    }
  });
  await Promise.all(workers);
  return { facts, misses };
}


export function retrieveKnowledge(query, knowledge, limit = 3) {
  const sections = splitKnowledge(knowledge);
  const terms = queryTerms(query);
  return sections
    .map((section) => {
      const hay = section.text.toLowerCase();
      return {
        section,
        score: terms.reduce((score, term) => score + (hay.includes(term) ? term.length : 0), 0),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.section.id - b.section.id)
    .slice(0, Math.max(1, limit))
    .map((item) => item.section);
}

/* ------------------------------------------------------------------ *
 * 行程结果规范化 —— 后端是唯一的真实性关口
 * ------------------------------------------------------------------ */

function verifyStub(note) {
  return {
    status: 'unverified',
    label: TBD,
    checkedAt: null,
    note: note || '本机未接入实时数据源，请以官方渠道核实。',
  };
}

function normalizeOverview(raw, input) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    title: sanitizeText(o.title, 60) || `${input.destination} ${input.days} 日行程`,
    summary: sanitizeText(o.summary, 400, { multiline: true }),
    highlights: asArray(o.highlights, 6).map((x) => sanitizeText(x, 80)).filter(Boolean),
    paceNote: sanitizeText(o.paceNote, 200) || `按${PACE_LABEL[input.pace]}安排，每天保留自由时间。`,
    bestFor: sanitizeText(o.bestFor, 160),
  };
}

function normalizeAttraction(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return {
    name: sanitizeText(a.name, 60),
    area: sanitizeText(a.area, 40),
    why: sanitizeText(a.why, 220),
    type: sanitizeText(a.type, 20),
    suggestedDuration: sanitizeText(a.suggestedDuration, 40) || TBD,
    bestTime: sanitizeText(a.bestTime, 60) || TBD,
    openingHours: sanitizeText(a.openingHours, 60) || TBD,
    ticket: sanitizeText(a.ticket, 60) || TBD,
    crowd: sanitizeText(a.crowd, 80),
    suitableFor: asArray(a.suitableFor, 6).map((x) => sanitizeText(x, 16)).filter(Boolean),
    booking: sanitizeText(a.booking, 120),
    backup: sanitizeText(a.backup, 160),
    verify: verifyStub('开放时间、门票与预约规则可能调整。'),
  };
}

function normalizeHotel(raw) {
  const h = raw && typeof raw === 'object' ? raw : {};
  return {
    name: sanitizeText(h.name, 80),
    area: sanitizeText(h.area, 50),
    priceRange: sanitizeText(h.priceRange, 60) || TBD,
    rating: sanitizeText(h.rating, 30) || TBD,
    ratingSource: sanitizeText(h.ratingSource, 60) || '未经核验',
    distanceToSights: sanitizeText(h.distanceToSights, 80) || TBD,
    distanceToTransit: sanitizeText(h.distanceToTransit, 80) || TBD,
    suitableFor: asArray(h.suitableFor, 6).map((x) => sanitizeText(x, 16)).filter(Boolean),
    reason: sanitizeText(h.reason, 300),
    needCheck: asArray(h.needCheck, 6).map((x) => sanitizeText(x, 80)).filter(Boolean),
    bookingUrl: '',
    verify: verifyStub('房价、可订状态与评分需在预订平台自行核实；寰途不代订。'),
  };
}

const ITEM_TYPES = new Set(['景点', '餐饮', '交通', '休息', '自由', '购物', '活动']);

/* ------------------------------------------------------------------ *
 * 坐标可信度：三档策略的服务端执行部分
 *
 * 1. 模型自报的坐标先过合理性校验：偏离目的地城市中心超过 50km 直接丢弃
 *    （大概率是串了城市，或者把同名景点套错了地方）。
 * 2. 通过校验的保留，source = 'model'。
 * 3. 仍然为空的，按「地名 + 城市」走地理编码兜底：
 *    高德 POI 搜索优先（GCJ-02 原生、中文 POI 最准），其次 Nominatim（WGS-84，转 GCJ-02）。
 *    补到的一律再核一次 50km 半径，避免把同名的外地点补进来。
 * 4. 补不到的保持 null，交给用户手动定位，界面标「未定位」。
 * ------------------------------------------------------------------ */

const CITY_RADIUS_KM = 50;
const GEOCODE_TIMEOUT_MS = 7000;
const GEOCODE_MAX_PER_PLAN = 16;
const GEOCODE_FALLBACK_MAX = 4;
const GEOCODE_CONCURRENCY = 3;
const GEOCODE_TTL_MS = 24 * 3600 * 1000;
const geocodeCache = new Map();
let geocodeAmapWarned = false;

export function resetGeocodeState() {
  geocodeCache.clear();
  geocodeAmapWarned = false;
}

function geocodeCacheGet(key) {
  const hit = geocodeCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > GEOCODE_TTL_MS) {
    geocodeCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function geocodeCacheSet(key, value) {
  if (geocodeCache.size > 600) geocodeCache.clear();
  geocodeCache.set(key, { at: Date.now(), value });
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;

/** 高德 POI 关键字搜索：直接返回 GCJ-02，中文地名命中率最高 */
async function amapSpotSearch(name, city, key, signal) {
  const params = new URLSearchParams({
    key,
    keywords: name,
    city: city || '',
    citylimit: city ? 'true' : 'false',
    offset: '1',
    page: '1',
    extensions: 'base',
  });
  const res = await fetchWithTimeout(`https://restapi.amap.com/v3/place/text?${params}`, { signal }, GEOCODE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`amap ${res.status}`);
  const data = await res.json();
  if (String(data.status) !== '1') throw new Error(`amap ${data.info || 'error'}`);
  const poi = Array.isArray(data.pois) ? data.pois[0] : null;
  if (!poi || typeof poi.location !== 'string') return null;
  const [lngRaw, latRaw] = poi.location.split(',');
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!isValidCoord(lat, lng)) return null;
  return { lat: round5(lat), lng: round5(lng), via: 'amap', matched: sanitizeText(poi.name, 60) };
}

/** Nominatim（OSM）：免 key，坐标是 WGS-84，必须转 GCJ-02 再入库 */
async function nominatimSpotSearch(name, city, signal) {
  const q = [name, city].filter(Boolean).join(' ');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-CN&q=${encodeURIComponent(q)}`;
  const res = await fetchWithTimeout(url, {
    signal,
    headers: { 'User-Agent': 'Huantu/1.0 (self-hosted travel planner)' },
  }, GEOCODE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const list = await res.json();
  const hit = Array.isArray(list) ? list[0] : null;
  if (!hit) return null;
  const wgs = { lat: Number(hit.lat), lng: Number(hit.lon) };
  if (!isValidCoord(wgs.lat, wgs.lng)) return null;
  const gcj = wgs2gcj(wgs.lat, wgs.lng);
  if (!gcj) return null;
  return { lat: round5(gcj.lat), lng: round5(gcj.lng), via: 'nominatim', matched: sanitizeText(hit.display_name, 80) };
}

/** 单个地名 → GCJ-02 坐标。带 24 小时缓存，避免重新规划时重复打接口。 */
export async function geocodeSpot(name, city, { amapKey = '', signal, logger } = {}) {
  const q = sanitizeText(name, 60);
  if (!q) return null;
  const key = `${city || ''}|${q}`;
  const cached = geocodeCacheGet(key);
  if (cached !== undefined) return cached;

  let hit = null;
  if (amapKey) {
    try {
      hit = await amapSpotSearch(q, city, amapKey, signal);
    } catch (error) {
      if (!geocodeAmapWarned) {
        geocodeAmapWarned = true;
        logger?.warn?.(`高德地理编码不可用，改用 Nominatim 兜底：${error.message}`);
      }
    }
  }
  if (!hit) {
    try {
      hit = await nominatimSpotSearch(q, city, signal);
    } catch {
      hit = null;
    }
  }
  geocodeCacheSet(key, hit);
  return hit;
}

/**
 * 目的地城市中心，作为「50km 合理性半径」的圆心。
 * 先用内置城市表（快、离线），查不到才走 Open-Meteo 地理编码，最后退回站点包围盒。
 */
export async function resolveCityCenterForGeo(destination, plan) {
  const quick = cityCenterOf(destination, planToStops(plan).stops);
  if (quick?.source === 'city-table') return quick;
  try {
    const geo = await geocodeDestination(destination);
    if (geo && isValidCoord(geo.lat, geo.lon)) {
      return { name: destination, lat: geo.lat, lng: geo.lon, source: 'open-meteo' };
    }
  } catch {
    /* 拿不到就退回包围盒，不影响主流程 */
  }
  return quick;
}

/**
 * 第一档校验：把明显不像目的地的坐标挑出来丢掉。
 * 只处理模型给的坐标；用户手动定位（source=manual）永不覆盖。
 */
export function rejectFarStops(plan, center, radiusKm = CITY_RADIUS_KM) {
  const rejected = [];
  let checked = 0;
  if (!isValidCoord(center?.lat, center?.lng)) return { rejected, checked };
  for (const day of plan.days || []) {
    for (const item of day.items || []) {
      const geo = item.geo || {};
      if (!isValidCoord(geo.lat, geo.lng) || geo.source === 'manual') continue;
      checked += 1;
      const km = haversineKm({ lat: center.lat, lng: center.lng }, { lat: geo.lat, lng: geo.lng });
      if (km > radiusKm) {
        rejected.push({ day: day.day, title: item.title, km: Math.round(km) });
        item.geo = { lat: null, lng: null, source: 'rejected', rejectedKm: Math.round(km) };
      }
    }
  }
  return { rejected, checked };
}

/** 第三档：给仍然没坐标的站点做地理编码补全（小并发 + 上限 + 二次半径校验） */
export async function fillMissingGeo(plan, { city, center, amapKey = '', signal, logger } = {}) {
  const targets = [];
  for (const day of plan.days || []) {
    for (const item of day.items || []) {
      const geo = item.geo || {};
      if (isValidCoord(geo.lat, geo.lng)) continue;
      if (!item.title) continue;
      // 休息 / 自由 是时段不是地点，不需要坐标
      if (item.type === '休息' || item.type === '自由') continue;
      targets.push(item);
    }
  }
  if (!targets.length) return { attempted: 0, filled: 0, skipped: 0 };

  // 高德单次 ~200ms，可以多补一些；Nominatim 有 1 req/s 的使用政策，
  // 没有高德 key 时只补最关键的前几个，且串行，绝不为了坐标把生成拖成 5 分钟。
  const maxItems = amapKey ? GEOCODE_MAX_PER_PLAN : GEOCODE_FALLBACK_MAX;
  const concurrency = amapKey ? GEOCODE_CONCURRENCY : 1;
  const queue = targets.slice(0, maxItems);
  const attempted = queue.length;
  let filled = 0;
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) return;
      const item = queue.shift();
      const hit = await geocodeSpot(item.title, city, { amapKey, signal, logger });
      if (!hit || !isValidCoord(hit.lat, hit.lng)) continue;
      // 补到也要过半径校验：Nominatim 常把同名地点匹配到别的省市
      if (isValidCoord(center?.lat, center?.lng)) {
        const km = haversineKm({ lat: center.lat, lng: center.lng }, { lat: hit.lat, lng: hit.lng });
        if (km > CITY_RADIUS_KM) continue;
      }
      item.geo = { lat: hit.lat, lng: hit.lng, source: 'geocoded', via: hit.via || '', matched: hit.matched || '' };
      filled += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { attempted, filled, skipped: Math.max(0, targets.length - attempted) };
}

/**
 * 站点的地理坐标。
 *
 * 坐标可能来自三处：模型自报、地理编码补全、用户在页面上手动定位。
 * 这里只做「像不像一个真坐标」的硬校验，不做任何猜测：
 * 越界、NaN、0/0 占位一律当作没有坐标，界面会明确显示「未定位」。
 */
function normalizeGeo(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const lat = Number(g.lat);
  const lng = Number(g.lng);
  if (!isValidCoord(lat, lng)) return { lat: null, lng: null, source: 'none' };
  const round = (v) => Math.round(v * 1e5) / 1e5;
  return {
    lat: round(lat),
    lng: round(lng),
    source: g.source === 'manual' ? 'manual' : 'model',
  };
}

function normalizeItem(raw, index) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const durationMin = clampInt(it.durationMin, 15, 720, 90);
  const time = normalizeTime(it.time);
  const type = ITEM_TYPES.has(it.type) ? it.type : '景点';
  return {
    index,
    time,
    endTime: timePlusMinutes(time, durationMin),
    title: sanitizeText(it.title, 80) || '（未命名安排）',
    type,
    area: sanitizeText(it.area, 50),
    durationMin,
    detail: sanitizeText(it.detail, 500, { multiline: true }),
    transportFromPrev: sanitizeText(it.transportFromPrev, 120),
    transportMin: clampInt(it.transportMin, 0, 240, 0),
    cost: sanitizeText(it.cost, 60) || TBD,
    backup: sanitizeText(it.backup, 200),
    booking: sanitizeText(it.booking, 160),
    geo: normalizeGeo(it.geo ?? { lat: it.lat, lng: it.lng }),
    locked: false,
    verify: verifyStub('时段、开放情况与交通耗时需出发前核实。'),
  };
}

function normalizeMeals(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const one = (v) => (typeof v === 'string' ? { suggestion: sanitizeText(v, 160), note: '' }
    : { suggestion: sanitizeText(v?.suggestion, 160), note: sanitizeText(v?.note, 120) });
  return { breakfast: one(m.breakfast), lunch: one(m.lunch), dinner: one(m.dinner) };
}

function normalizeDay(raw, index, input) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const date = addDays(input.startDate, index);
  const items = asArray(d.items, 14)
    .map((it, i) => normalizeItem(it, i))
    .filter((it) => it.title);
  // 模型偶尔会在主题里自带「Day 1｜」，和列表里的 Day 标签重复
  const theme = sanitizeText(d.theme, 60)
    .replace(/^\s*(?:Day|DAY|D)\s*\d+\s*[·:：|｜\-—、.，,]*\s*/i, '')
    .replace(/^\s*第\s*[0-9一二三四五六七八九十]+\s*天\s*[·:：|｜\-—、.，,]*\s*/, '');
  return {
    day: index + 1,
    label: `Day ${index + 1}`,
    date,
    weekday: weekdayCN(date),
    theme: theme || `第 ${index + 1} 天`,
    area: sanitizeText(d.area, 60),
    items,
    meals: normalizeMeals(d.meals),
    rest: sanitizeText(d.rest, 160),
    freeTime: sanitizeText(d.freeTime, 160),
    backupPlan: sanitizeText(d.backupPlan, 300),
    notes: sanitizeText(d.notes, 300),
    locked: false,
  };
}

const BUDGET_CATEGORIES = ['交通', '住宿', '门票', '餐饮', '其他'];
const BUDGET_CATEGORY_NOTE = {
  交通: '往返大交通与市内交通',
  住宿: '按晚数折算到人均',
  门票: '景区门票与演出票',
  餐饮: '正餐与咖啡',
  其他: '购物、保险、杂项',
};

/** 把模型的费用结构规整成可求和的数字。模型的算术不可信，一律由后端重新求和。 */
export function normalizeBudget(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const items = asArray(b.items, 24).map((it) => {
    const amount = Number(it?.amount);
    return {
      category: BUDGET_CATEGORIES.includes(it?.category) ? it.category : '其他',
      label: sanitizeText(it?.label, 60),
      amount: Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null,
      basis: sanitizeText(it?.basis, 120),
      confidence: it?.confidence === '待核实' ? '待核实' : '估',
    };
  }).filter((it) => it.amount !== null || it.label);

  const byCategory = Object.fromEntries(BUDGET_CATEGORIES.map((c) => [c, 0]));
  for (const it of items) if (it.amount) byCategory[it.category] += it.amount;
  const estimatedTotal = BUDGET_CATEGORIES.reduce((sum, c) => sum + byCategory[c], 0);
  const modelTotal = Number(b.estimatedTotal);
  const hasModelTotal = Number.isFinite(modelTotal) && modelTotal > 0;

  return {
    currency: 'CNY',
    perPerson: b.perPerson !== false,
    items,
    byCategory,
    estimatedTotal,
    modelEstimatedTotal: hasModelTotal ? Math.round(modelTotal) : null,
    // 模型自报的合计与逐项求和差得太多，说明某一边漏算，前端据此提示「合计待核」
    totalMismatch: hasModelTotal && Math.abs(Math.round(modelTotal) - estimatedTotal) > Math.max(50, estimatedTotal * 0.1),
    note: sanitizeText(b.note, 300),
  };
}

/** 从「两人合计 8000 元，不含机票」这类自由文本里抠出金额与口径 */
export function parseBudgetText(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '未填写') return { amount: null, scope: 'total', raw };
  const compact = raw.replace(/[,，\s]/g, '');
  const m = compact.match(/(\d+(?:\.\d+)?)(万)?/);
  if (!m) return { amount: null, scope: 'total', raw };
  let amount = Number(m[1]);
  if (m[2]) amount *= 10000;
  if (!Number.isFinite(amount) || amount <= 0) return { amount: null, scope: 'total', raw };
  const perPersonHint = /人均|每人|单人|一位/.test(raw);
  const totalHint = /合计|总共|总计|一共|两人|三人|四人|一家/.test(raw);
  const scope = perPersonHint && !totalHint ? 'perPerson' : 'total';
  return { amount: Math.round(amount), scope, raw };
}

/**
 * 预算对比。预算是用户填的自由文本，口径可能是「两人合计」也可能是「人均」，
 * 这里统一折算成总预算与人均两个口径再比，避免把 8000 的总预算当成人均。
 */
export function computeBudgetCheck(budget, input) {
  const travelers = Math.max(1, Number(input?.travelers) || 1);
  const parsed = parseBudgetText(input?.budget);
  const perPersonModel = budget?.estimatedTotal ?? 0;
  const estPerPerson = budget?.perPerson === false
    ? Math.round(perPersonModel / travelers)
    : Math.round(perPersonModel);
  const estTotal = budget?.perPerson === false ? Math.round(perPersonModel) : Math.round(perPersonModel * travelers);

  const base = {
    provided: Boolean(parsed.amount),
    raw: parsed.raw,
    scope: parsed.scope,
    travelers,
    estimatedPerPerson: estPerPerson,
    estimatedTotal: estTotal,
    limitPerPerson: null,
    limitTotal: null,
    diffTotal: null,
    over: false,
    overBy: 0,
    ratio: null,
    level: 'none',
    headline: '',
    advice: '',
    byCategory: budget?.byCategory || {},
    items: budget?.items || [],
    totalMismatch: Boolean(budget?.totalMismatch),
    note: budget?.note || '',
  };
  if (!parsed.amount) return base;

  const limitTotal = parsed.scope === 'perPerson' ? parsed.amount * travelers : parsed.amount;
  // 一项费用都没估出来时，不能说「在预算内」——那等于替模型打了包票
  if (estTotal <= 0) {
    return {
      ...base,
      limitTotal,
      limitPerPerson: Math.round(limitTotal / travelers),
      level: 'unknown',
      headline: '费用未估出，无法与预算比对',
      advice: '模型这次没有给出可求和的费用明细，请以实际报价为准。',
    };
  }
  const diffTotal = estTotal - limitTotal;
  const ratio = limitTotal > 0 ? estTotal / limitTotal : null;
  const level = diffTotal > 0 ? 'over' : (ratio !== null && ratio > 0.9 ? 'tight' : 'ok');

  const yuan = (n) => `¥${Math.abs(Math.round(n)).toLocaleString('zh-CN')}`;
  let headline = '';
  if (level === 'over') headline = `超出预算 ${yuan(diffTotal)}（约 ${Math.round((ratio - 1) * 100)}%）`;
  else if (level === 'tight') headline = `贴近预算上限，仅结余 ${yuan(diffTotal)}`;
  else headline = `预算内，结余 ${yuan(diffTotal)}（占总预算 ${Math.round((1 - ratio) * 100)}%）`;

  let advice = '';
  const entries = Object.entries(base.byCategory).filter(([, v]) => v > 0);
  if (entries.length) {
    const [topCat, topVal] = entries.sort((a, b) => b[1] - a[1])[0];
    const share = Math.round((topVal / Math.max(1, estPerPerson)) * 100);
    advice = `${topCat}是最大头（${yuan(topVal)}，占人均 ${share}%，${BUDGET_CATEGORY_NOTE[topCat] || ''}）。`;
    if (level === 'over') {
      advice += `要压回预算，优先从${topCat}下手：` + (topCat === '住宿'
        ? '换到地铁沿线但非核心景区的片区，通常能省三成。'
        : topCat === '交通'
          ? '改早班或错峰车次，市内多用公共交通替代打车。'
          : topCat === '门票'
            ? '核对是否有联票、淡季票或免票政策，去掉可替代的付费项目。'
            : topCat === '餐饮'
              ? '把一顿正餐换成当地市场或小馆，人均可控在一半以内。'
              : '逐项核对是否必要。');
    } else if (level === 'tight') {
      advice += '留给临场加项（打车、伴手礼、临时门票）的空间不多，建议预留 10% 机动。';
    }
  }

  return {
    ...base,
    limitTotal,
    limitPerPerson: Math.round(limitTotal / travelers),
    diffTotal,
    over: diffTotal > 0,
    overBy: diffTotal > 0 ? diffTotal : 0,
    ratio,
    level,
    headline,
    advice,
  };
}

export function normalizePlan(raw, input, { now = new Date(), planId = '', model = null, protocol = null } = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const ins = p.insights && typeof p.insights === 'object' ? p.insights : {};

  const attractions = asArray(ins.attractions, 20).map(normalizeAttraction).filter((a) => a.name);
  const hiddenGems = asArray(ins.hiddenGems, 12).map((g) => ({
    name: sanitizeText(g?.name, 60),
    area: sanitizeText(g?.area, 40),
    why: sanitizeText(g?.why, 220),
    note: sanitizeText(g?.note, 160),
  })).filter((g) => g.name);
  const activities = asArray(ins.activities, 12).map((a) => ({
    name: sanitizeText(a?.name, 60),
    area: sanitizeText(a?.area, 40),
    why: sanitizeText(a?.why, 200),
    duration: sanitizeText(a?.duration, 40) || TBD,
    booking: sanitizeText(a?.booking, 120),
  })).filter((a) => a.name);
  const food = asArray(ins.food, 16).map((f) => ({
    name: sanitizeText(f?.name, 60),
    type: sanitizeText(f?.type, 30),
    area: sanitizeText(f?.area, 40),
    why: sanitizeText(f?.why, 180),
    priceRange: sanitizeText(f?.priceRange, 50) || TBD,
  })).filter((f) => f.name);
  const cafes = asArray(ins.cafes, 12).map((c) => ({
    name: sanitizeText(c?.name, 60),
    area: sanitizeText(c?.area, 40),
    why: sanitizeText(c?.why, 180),
  })).filter((c) => c.name);
  const transport = asArray(ins.transport, 10).map((t) => ({
    mode: sanitizeText(t?.mode, 30),
    detail: sanitizeText(t?.detail, 260),
    cost: sanitizeText(t?.cost, 50) || TBD,
    note: sanitizeText(t?.note, 160),
  })).filter((t) => t.mode || t.detail);

  const season = {
    summary: sanitizeText(ins.season?.summary, 300),
    tips: asArray(ins.season?.tips, 6).map((x) => sanitizeText(x, 120)).filter(Boolean),
    weather: sanitizeText(ins.season?.weather, 200) || TBD,
    verify: verifyStub('天气需以出行前官方预报为准，此处仅为季节常识。'),
  };

  const suitability = {
    family: sanitizeText(ins.suitability?.family, 200),
    couples: sanitizeText(ins.suitability?.couples, 200),
    seniors: sanitizeText(ins.suitability?.seniors, 200),
    solo: sanitizeText(ins.suitability?.solo, 200),
  };

  const days = Array.from({ length: input.days }, (_, i) => normalizeDay(asArray(p.days, 21)[i], i, input));

  const warnings = [
    '实时天气与公开网页搜索是否可用取决于本次运行配置；房价、营业时间、门票与班次即使有来源也必须在出行前再次核实，均保留“待核实”边界。',
    '寰途不代订酒店、不代付款、不自动发送消息；预订请前往官方渠道。',
    ...asArray(p.warnings, 6).map((w) => sanitizeText(w, 200)).filter(Boolean),
  ];

  const modelSources = asArray(p.sources, 8).map((s) => ({
    label: sanitizeText(s?.label, 80) || '模型陈述',
    type: 'model',
    status: 'unverified',
    retrievedAt: null,
    note: sanitizeText(s?.note, 120) || '模型知识，未经实时核验',
  })).filter((s) => s.label);

  const budget = normalizeBudget(p.budget);
  const budgetCheck = computeBudgetCheck(budget, input);
  // 超支必须显式写在提醒里，不能只藏在费用卡片里
  if (budgetCheck.level === 'over') {
    warnings.unshift(
      `费用估算${budgetCheck.headline}：人均约 ¥${budgetCheck.estimatedPerPerson.toLocaleString('zh-CN')}`
      + `${budgetCheck.travelers > 1 ? `（${budgetCheck.travelers} 人合计约 ¥${budgetCheck.estimatedTotal.toLocaleString('zh-CN')}）` : ''}。`
      + budgetCheck.advice,
    );
  }

  return {
    planId,
    meta: {
      generatedAt: now.toISOString(),
      engine: 'model',
      model,
      protocol,
      destination: input.destination,
      itineraryDays: input.days,
      timezone: input.timezone,
    },
    input,
    overview: normalizeOverview(p.overview, input),
    insights: { attractions, hiddenGems, activities, food, cafes, transport, season, suitability },
    hotels: asArray(p.hotels, 8).map(normalizeHotel).filter((h) => h.name),
    days,
    route: {
      hotelArea: sanitizeText(p.route?.hotelArea, 80),
      logic: sanitizeText(p.route?.logic, 300),
      notes: sanitizeText(p.route?.notes, 300),
    },
    budget,
    budgetCheck,
    confidence: {
      level: ['高', '中', '低'].includes(p.confidence?.level) ? p.confidence.level : '中',
      missing: asArray(p.confidence?.missing, 8).map((x) => sanitizeText(x, 100)).filter(Boolean),
    },
    warnings,
    sources: modelSources,
  };
}

/* ------------------------------------------------------------------ *
 * ICS 生成（RFC 5545）
 * ------------------------------------------------------------------ */

function escapeIcs(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function foldLine(line) {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes <= 75) return line;
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    const limit = chunks.length === 0 ? 75 : 74; // 续行首字符是空格，占 1 字节
    if (currentBytes + b > limit) {
      chunks.push(current);
      current = ch;
      currentBytes = b;
    } else {
      current += ch;
      currentBytes += b;
    }
  }
  if (current) chunks.push(current);
  return chunks.join('\r\n ');
}

function localStamp(dateStr, timeStr) {
  return `${dateStr.replace(/-/g, '')}T${(timeStr || '09:00').replace(':', '')}00`;
}

/**
 * 生成标准 .ics。时间使用「浮动本地时间」（不带 Z），导入后按手机所在时区显示，
 * 这样跨时区旅行时不会因为服务器时区而错位。
 */
export function buildIcs(plan, { now = new Date(), planId = 'plan' } = {}) {
  const tz = plan?.input?.timezone || 'Asia/Shanghai';
  const destination = plan?.input?.destination || plan?.overview?.title || '旅行';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Huantu//AI Travel Planner//ZH-CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(`寰途 · ${destination}`)}`,
    `X-WR-TIMEZONE:${escapeIcs(tz)}`,
    `X-WR-CALDESC:${escapeIcs('由寰途生成的行程（时间为浮动本地时间，请核对时区）。天气、开放时间与交通需自行核实。')}`,
  ];
  const stamp = utcStamp(now.getTime());
  const hotelName = plan?.hotels?.[0]?.name || '';
  const hotelArea = plan?.route?.hotelArea || plan?.hotels?.[0]?.area || '';

  for (const day of plan?.days || []) {
    const datedItems = (day.items || []).filter((item) => item.time);
    for (const item of datedItems) {
      const endTime = item.endTime || timePlusMinutes(item.time, item.durationMin || 90);
      const desc = [
        item.detail || '',
        item.transportFromPrev ? `交通：${item.transportFromPrev}${item.transportMin ? `（约 ${item.transportMin} 分钟）` : ''}` : '',
        item.booking ? `预约/门票：${item.booking}` : '',
        item.backup ? `雨天或临时关闭备选：${item.backup}` : '',
        hotelName ? `住宿参考：${hotelName}${hotelArea ? `（${hotelArea}）` : ''}，需自行核实` : '',
        '提示：时间、开放情况与交通班次请出发前核实。',
        `寰途行程编号：${planId}`,
      ].filter(Boolean).join('\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:huantu-${planId}-d${day.day}-i${(item.index ?? 0) + 1}@huantu.local`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${localStamp(day.date, item.time)}`,
        `DTEND:${localStamp(day.date, endTime)}`,
        `SUMMARY:${escapeIcs(`${day.label} · ${item.title}`)}`,
        `LOCATION:${escapeIcs(item.area || destination)}`,
        `DESCRIPTION:${escapeIcs(desc)}`,
        `CATEGORIES:${escapeIcs('寰途行程,' + (item.type || '景点'))}`,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT30M',
        `DESCRIPTION:${escapeIcs(`30 分钟后：${item.title}`)}`,
        'END:VALARM',
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * Google Calendar 创建链接
 * ------------------------------------------------------------------ */

function googleUrl({ text, startMs, endMs, details, location, ctz }) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text,
    dates: `${utcStamp(startMs)}/${utcStamp(endMs)}`,
    details,
    location: location || '',
    ctz,
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

export function buildGoogleLinks(plan, { planId = 'plan' } = {}) {
  const tz = plan?.input?.timezone || 'Asia/Shanghai';
  const destination = plan?.input?.destination || '';
  const events = [];
  for (const day of plan?.days || []) {
    for (const item of day.items || []) {
      if (!item.time) continue;
      const startMs = zonedTimeToUtc(day.date, item.time, tz);
      const endTime = item.endTime || timePlusMinutes(item.time, item.durationMin || 90);
      let endMs = zonedTimeToUtc(day.date, endTime, tz);
      if (endMs <= startMs) endMs = startMs + 60 * 60 * 1000;
      const details = [
        item.detail || '',
        item.transportFromPrev ? `交通：${item.transportFromPrev}（约 ${item.transportMin || 0} 分钟）` : '',
        item.backup ? `备选：${item.backup}` : '',
        '由寰途生成；时间、开放情况与交通请自行核实。',
      ].filter(Boolean).join('\n');
      events.push({
        day: day.day,
        date: day.date,
        title: `${day.label} · ${item.title}`,
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(endMs).toISOString(),
        location: item.area || destination,
        url: googleUrl({
          text: `${day.label} · ${item.title}`,
          startMs, endMs,
          details,
          location: item.area || destination,
          ctz: tz,
        }),
      });
    }
  }
  const firstDate = plan?.days?.[0]?.date;
  const lastDay = plan?.days?.[plan.days.length - 1];
  const tripUrl = firstDate
    ? googleUrl({
      text: `寰途 · ${destination} ${plan.input.days} 日行程`,
      startMs: zonedTimeToUtc(firstDate, '09:00', tz),
      endMs: zonedTimeToUtc(lastDay.date, '18:00', tz),
      details: (plan.overview?.summary || '') + `\n寰途行程编号：${planId}\n逐项行程请下载 .ics 导入，或在下方逐条创建。`,
      location: destination,
      ctz: tz,
    })
    : '';
  return { timezone: tz, events, trip: { url: tripUrl } };
}

/* ------------------------------------------------------------------ *
 * 路线可视化（服务端 SVG，基于行程数据的示意图，不是实时地图）
 * ------------------------------------------------------------------ */

function svgEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function wrapChars(text, perLine, maxLines) {
  const s = String(text || '');
  const lines = [];
  for (let i = 0; i < s.length && lines.length < maxLines; i += perLine) {
    lines.push(s.slice(i, i + perLine));
  }
  if (s.length > perLine * maxLines && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, perLine - 1) + '…';
  }
  return lines;
}

export function buildRouteSvg(plan) {
  const days = plan?.days || [];
  const W = 1200;
  const rowH = 236;
  const headerH = 210;
  const footerH = 96;
  const H = headerH + Math.max(1, days.length) * rowH + footerH;
  const ink = '#0f2b26';
  const cream = '#f6f2e8';
  const gold = '#c9a961';
  const sage = '#8aa79a';
  const title = plan?.overview?.title || `${plan?.input?.destination || '目的地'} 行程`;
  const dateRange = `${plan?.input?.startDate || ''} 至 ${plan?.input?.endDate || ''} · ${plan?.input?.days || days.length} 天 · ${plan?.input?.travelers || 1} 人`;
  const hotelLine = plan?.route?.hotelArea || plan?.hotels?.[0]?.area || '住宿区域待定';
  const hotelShort = String(hotelLine).split(/[；;，,、]/)[0].slice(0, 12);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${svgEscape(title)} 路线示意图">`);
  out.push(`<title>${svgEscape(title)}</title>`);
  out.push(`<desc>基于寰途行程数据生成的路线示意图，不是实时地图，不代表真实地理比例。</desc>`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${ink}"/>`);
  out.push(`<rect x="28" y="28" width="${W - 56}" height="${H - 56}" fill="none" stroke="#2b4a43" stroke-width="1"/>`);
  // 页眉
  const titleText = String(title);
  const titleSize = titleText.length > 26 ? 28 : titleText.length > 20 ? 32 : 40;
  out.push(`<text x="70" y="96" fill="${gold}" font-size="17" letter-spacing="6" font-family="Georgia, 'Songti SC', serif">HUANTU · ITINERARY</text>`);
  out.push(`<text x="70" y="146" fill="${cream}" font-size="${titleSize}" font-weight="600" font-family="Georgia, 'Songti SC', serif">${svgEscape(titleText.slice(0, 30))}${titleText.length > 30 ? '…' : ''}</text>`);
  out.push(`<text x="70" y="180" fill="${sage}" font-size="17" font-family="'PingFang SC', 'Microsoft YaHei', sans-serif">${svgEscape(dateRange)}</text>`);
  out.push(`<line x1="70" y1="${headerH - 26}" x2="${W - 70}" y2="${headerH - 26}" stroke="#34524b" stroke-width="1"/>`);
  if (plan?.input?.origin) {
    out.push(`<text x="${W - 70}" y="96" fill="${sage}" font-size="15" text-anchor="end" font-family="'PingFang SC', 'Microsoft YaHei', sans-serif">出发地 · ${svgEscape(plan.input.origin)}</text>`);
  }
  out.push(`<text x="${W - 70}" y="122" fill="${gold}" font-size="14" text-anchor="end" font-family="'PingFang SC', 'Microsoft YaHei', sans-serif">住宿参考 · ${svgEscape(hotelShort)}</text>`);
  out.push(`<text x="${W - 70}" y="146" fill="#6f8e83" font-size="13" text-anchor="end" font-family="'PingFang SC', 'Microsoft YaHei', sans-serif">${svgEscape(`${plan?.input?.days || days.length} 天 · ${plan?.input?.travelers || 1} 人 · ${plan?.input?.timezone || 'Asia/Shanghai'}`)}</text>`);

  if (!days.length) {
    out.push(`<text x="70" y="${headerH + 60}" fill="${sage}" font-size="20" font-family="'PingFang SC', sans-serif">暂无每日行程数据。</text>`);
  }

  days.forEach((day, di) => {
    const y = headerH + di * rowH;
    out.push(`<g>`);
    out.push(`<text x="70" y="${y + 30}" fill="${gold}" font-size="16" letter-spacing="3" font-family="Georgia, serif">${svgEscape(day.label || `DAY ${di + 1}`)}</text>`);
    out.push(`<text x="70" y="${y + 60}" fill="${cream}" font-size="20" font-weight="600" font-family="'Songti SC', 'PingFang SC', serif">${svgEscape(String(day.theme || '').slice(0, 11))}</text>`);
    out.push(`<text x="70" y="${y + 86}" fill="${sage}" font-size="14" font-family="'PingFang SC', sans-serif">${svgEscape(`${day.date || ''} ${day.weekday || ''}`)}</text>`);
    out.push(`<text x="70" y="${y + 108}" fill="${sage}" font-size="13" font-family="'PingFang SC', sans-serif">${svgEscape(String(day.area || '').slice(0, 12))}</text>`);
    out.push(`<line x1="300" y1="${y + 16}" x2="300" y2="${y + rowH - 40}" stroke="#2b4a43" stroke-width="1"/>`);

    const items = (day.items || []).slice(0, 6);
    const startX = 336;
    // 右侧留出半个节点文字的宽度，避免最后一个节点的标签压到边框
    const trackW = W - 150 - startX;
    const step = items.length > 1 ? trackW / (items.length - 1) : 0;
    const baseY = y + 152;
    out.push(`<line x1="${startX}" y1="${baseY}" x2="${items.length > 1 ? startX + trackW : startX + 40}" y2="${baseY}" stroke="#3c5c54" stroke-width="2" stroke-dasharray="5 6"/>`);

    items.forEach((item, ii) => {
      const x = startX + ii * step;
      out.push(`<circle cx="${x}" cy="${baseY}" r="9" fill="${ink}" stroke="${gold}" stroke-width="2.5"/>`);
      out.push(`<text x="${x}" y="${baseY + 4}" fill="${gold}" font-size="11" text-anchor="middle" font-family="Georgia, serif">${ii + 1}</text>`);
      out.push(`<text x="${x}" y="${baseY - 22}" fill="${gold}" font-size="13" text-anchor="middle" font-family="'PingFang SC', sans-serif">${svgEscape(item.time || '待定')}</text>`);
      const lines = wrapChars(String(item.title || ''), 9, 2);
      lines.forEach((ln, li) => {
        out.push(`<text x="${x}" y="${baseY + 32 + li * 19}" fill="${cream}" font-size="14" text-anchor="middle" font-family="'PingFang SC', 'Microsoft YaHei', sans-serif">${svgEscape(ln)}</text>`);
      });
      out.push(`<text x="${x}" y="${baseY + 32 + lines.length * 19 + 4}" fill="${sage}" font-size="12" text-anchor="middle" font-family="'PingFang SC', sans-serif">${svgEscape(item.type || '')}${item.durationMin ? ` · ${item.durationMin}分` : ''}</text>`);
      if (ii < items.length - 1) {
        const mx = x + step / 2;
        const label = item.transportMin ? `${item.transportMin}分` : '移动';
        out.push(`<text x="${mx}" y="${baseY - 8}" fill="#6f8e83" font-size="11" text-anchor="middle" font-family="'PingFang SC', sans-serif">${svgEscape(label)}</text>`);
      }
    });
    out.push(`</g>`);
  });

  const footY = H - 54;
  out.push(`<line x1="70" y1="${footY - 22}" x2="${W - 70}" y2="${footY - 22}" stroke="#34524b" stroke-width="1"/>`);
  out.push(`<text x="70" y="${footY + 4}" fill="${sage}" font-size="13" font-family="'PingFang SC', sans-serif">示意图 · 基于寰途行程数据生成，非实时地图，不代表真实地理距离与比例。</text>`);
  out.push(`<text x="${W - 70}" y="${footY + 4}" fill="#6f8e83" font-size="13" text-anchor="end" font-family="'PingFang SC', sans-serif">生成于 ${svgEscape(new Date(plan?.meta?.generatedAt || Date.now()).toLocaleString('zh-CN'))} · 时效信息请核实</text>`);
  out.push('</svg>');
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * 路线地图：给前端交互地图提供站点数据
 * ------------------------------------------------------------------ */

/**
 * 地图组件的数据载荷。
 *
 * 与 /api/visual/svg 的分工：SVG 是排好版的静态示意图，这里是给交互地图用的原始站点，
 * 由前端 TravelMap 负责画线和图标。坐标一律标来源，界面据此显示「模型估计」或「手动定位」。
 */
export function buildMapPayload(plan) {
  const { stops, missing } = planToStops(plan);
  const destination = plan?.meta?.destination || plan?.input?.destination || '';
  const center = cityCenterOf(destination, stops);
  const days = new Set([...stops, ...missing].map((s) => s.day)).size;

  return {
    ok: true,
    city: center,
    destination,
    stops,
    missing: missing.map((m) => ({
      day: m.day,
      order: m.order,
      label: m.label,
      type: m.type,
      time: m.time,
      icon: m.icon,
      dur: m.dur,
      mode: m.mode,
      modeText: m.modeText,
      transportMin: m.transportMin,
      addr: m.addr,
    })),
    stats: {
      total: stops.length + missing.length,
      located: stops.length,
      missing: missing.length,
      manual: stops.filter((s) => s.source === 'manual').length,
      days,
    },
    notice: '坐标为模型估计或你手动定位的结果，未经地理编码核验，只用于示意路线；'
      + '连线是示意弧线，不是真实导航轨迹。',
  };
}

/* ------------------------------------------------------------------ *
 * 合并已确认安排（重新规划时保护用户已锁定的部分）
 * ------------------------------------------------------------------ */

export function mergeConfirmed(oldPlan, newPlan) {
  if (!oldPlan) return newPlan;
  const oldDays = new Map((oldPlan.days || []).map((d) => [d.day, d]));
  let preserved = 0;
  for (const day of newPlan.days || []) {
    const old = oldDays.get(day.day);
    if (!old) continue;
    if (old.locked) {
      day.theme = old.theme || day.theme;
      day.area = old.area || day.area;
      day.items = (old.items || []).map((it) => ({ ...it, locked: true }));
      day.meals = old.meals || day.meals;
      day.rest = old.rest;
      day.freeTime = old.freeTime;
      day.backupPlan = old.backupPlan;
      day.locked = true;
      day.preservedFrom = '已确认保留';
      preserved += 1;
      continue;
    }
    const lockedItems = (old.items || []).filter((it) => it.locked);
    for (const locked of lockedItems) {
      const exists = day.items.some((it) => it.title === locked.title);
      if (exists) {
        for (const it of day.items) if (it.title === locked.title) it.locked = true;
      } else {
        day.items.push({ ...locked, locked: true });
        preserved += 1;
      }
    }
    if (lockedItems.length) {
      day.items.sort((a, b) => String(a.time || '99:99').localeCompare(String(b.time || '99:99')));
      day.items.forEach((it, i) => { it.index = i; });
    }
  }
  newPlan.meta.preservedItems = preserved;
  if (preserved) {
    newPlan.route.notes = [newPlan.route.notes, `已保留 ${preserved} 处你确认过的安排。`].filter(Boolean).join(' ');
  }
  return newPlan;
}

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */

const PROTOCOLS = new Set(['chat-completions', 'responses']);

/** 公开模式下访客可以调用的接口；其余一律 403。 */
const PUBLIC_ALLOWED = new Set([
  'GET /api/health',
  'GET /api/public',
  'POST /api/session',
  'GET /api/state',
  'GET /api/library',
  'POST /api/plan',
  'POST /api/replan',
  'POST /api/jobs',
  'GET /api/jobs',
  'GET /api/plan/latest',
  'DELETE /api/plan',
  'POST /api/calendar/status',
  'POST /api/calendar/ics',
  'POST /api/calendar/google',
  'POST /api/visual/svg',
  'POST /api/visual/map',
  'POST /api/plan/export',
]);

const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml; charset=utf-8'],
  '/travel-map.css': ['travel-map.css', 'text/css; charset=utf-8'],
  '/travel-map.js': ['travel-map.js', 'application/javascript; charset=utf-8'],
  '/travel-map-core.mjs': ['travel-map-core.mjs', 'application/javascript; charset=utf-8'],
  '/icons.js': ['icons.js', 'application/javascript; charset=utf-8'],
  '/vendor/leaflet.js': ['vendor/leaflet.js', 'application/javascript; charset=utf-8'],
  '/vendor/leaflet.css': ['vendor/leaflet.css', 'text/css; charset=utf-8'],
  // 交互原型（纯静态演示，不调用模型，不读密钥）
  '/prototype': ['prototype/index.html', 'text/html; charset=utf-8'],
  '/prototype/': ['prototype/index.html', 'text/html; charset=utf-8'],
  '/prototype/index.html': ['prototype/index.html', 'text/html; charset=utf-8'],
  '/prototype/prototype.css': ['prototype/prototype.css', 'text/css; charset=utf-8'],
  '/prototype/prototype.js': ['prototype/prototype.js', 'application/javascript; charset=utf-8'],
};

/** 去掉端口与 IPv6 方括号，只留主机名 */
export function stripHostPort(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end > 0) return host.slice(1, end);
  }
  // 没加方括号的 IPv6（冒号不止一个）不当作「端口」处理
  if ((host.match(/:/g) || []).length > 1) return host;
  return host.replace(/:\d+$/, '');
}

/**
 * 允许 HUANTU_PUBLIC_HOST 写成：
 *   example.com / https://example.com/path / example.com:443
 *   也可以写成通配后缀 *.trycloudflare.com（隧道每次换子域名时不用改配置）
 */
export function normalizePublicHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const wildcard = raw.startsWith('*.');
  const body = (wildcard ? raw.slice(2) : raw).replace(/\/+$/, '');
  let host = '';
  try {
    host = new URL(body.includes('://') ? body : 'https://' + body).hostname.toLowerCase();
  } catch {
    host = stripHostPort(body);
  }
  host = host.replace(/\.+$/, '');
  return wildcard ? '*.' + host : host;
}

/** Host 是否命中白名单（精确列表 + 可选的通配后缀） */
export function isHostAllowed(hostName, { exact = [], suffix = '' } = {}) {
  const name = stripHostPort(hostName).replace(/\.+$/, '');
  if (!name) return false;
  if (exact.includes(name)) return true;
  if (suffix && name.endsWith('.' + suffix) && name.length > suffix.length + 1) return true;
  return false;
}

/** 绑定地址：默认只监听本机，必须显式配置才会绑到公网网卡 */
export function resolveBindHost(value) {
  const host = String(value ?? '').trim();
  return host || '127.0.0.1';
}

export async function createApp({
  dataDir = path.join(ROOT, '.data'),
  allowLocalUpstream = false,
  // 公开试用模式：需要访问码，访客只读、不能碰模型配置
  publicMode = process.env.HUANTU_PUBLIC === '1',
  // 明确声明「不要访问码」。必须显式打开，避免忘记配置访问码时悄悄放开
  publicNoCode = process.env.HUANTU_PUBLIC_NO_CODE === '1',
  accessCode = process.env.HUANTU_ACCESS_CODE || '',
  // 无访问码时按来源 IP 的每日模型调用额度（0 = 不限，默认关闭）。
  // 需要止损时再打开，例如 HUANTU_PUBLIC_IP_DAILY_CALLS=30。
  ipDailyCalls = Number(process.env.HUANTU_PUBLIC_IP_DAILY_CALLS || 0),
  publicHost = process.env.HUANTU_PUBLIC_HOST || '',
  bindHost = process.env.HUANTU_BIND_HOST || '127.0.0.1',
  trustedProxies = (process.env.HUANTU_TRUSTED_PROXIES || '127.0.0.1,::1')
    .split(',').map((x) => x.trim()).filter(Boolean),
  accessTokenTtlMs = Number(process.env.HUANTU_ACCESS_TTL_MS || 2 * 60 * 60 * 1000),
  // 公开模式默认更保守：不设访问码时每会话 4 次调用（两次完整规划），有码时 8 次
  maxCallsPerSession = Number(process.env.HUANTU_MAX_CALLS || (publicNoCode ? 4 : publicMode ? 8 : 20)),
  // 总时长上限（流式下不再是判定卡死的依据），以及"多久没收到任何数据算卡死"的空闲上限。
  modelTimeoutMs = Number(process.env.HUANTU_MODEL_TIMEOUT_MS || 240000),
  modelIdleMs = Number(process.env.HUANTU_MODEL_IDLE_MS || 75000),
  // 兼容接口 /api/plan 的最长等待时间：超过就返回 202 + jobId，让调用方改走轮询。
  planWaitMs = Number(process.env.HUANTU_PLAN_WAIT_MS || 20000),
  queue = createQueue({ driver: process.env.HUANTU_QUEUE || 'memory' }),
  logger = console,
} = {}) {
  const rules = await readFile(path.join(KNOWLEDGE_DIR, 'travel-rules.md'), 'utf8');
  const destinations = await readFile(path.join(KNOWLEDGE_DIR, 'destinations.md'), 'utf8');
  const sourcesDoc = await readFile(path.join(KNOWLEDGE_DIR, 'sources.md'), 'utf8');
  const knowledgeLoadedAt = new Date().toISOString();

  await mkdir(dataDir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');

  let persisted = null;
  try {
    const saved = JSON.parse(await readFile(configFile, 'utf8'));
    if (saved && typeof saved.baseUrl === 'string' && typeof saved.model === 'string') persisted = saved;
  } catch { /* 首次启动没有配置文件 */ }

  let config = {
    baseUrl: persisted?.baseUrl || process.env.HUANTU_API_BASE_URL || 'https://api.openai.com/v1',
    model: persisted?.model || process.env.HUANTU_MODEL || '',
    apiKey: process.env.HUANTU_API_KEY || '',
    protocol: PROTOCOLS.has(persisted?.protocol) ? persisted.protocol
      : PROTOCOLS.has(process.env.HUANTU_PROTOCOL) ? process.env.HUANTU_PROTOCOL : 'chat-completions',
    role: persisted?.role === 'developer' || process.env.HUANTU_ROLE === 'developer' ? 'developer' : 'system',
  };
  let configSavedAt = persisted?.savedAt || null;
  let verified = null;
  let lastError = null;
  let configRevision = 0;
  const csrf = randomBytes(24).toString('hex');
  const sessions = new Map();

  /* ---------- 公网访问：Host 白名单与访问码 ---------- */

  // HUANTU_PUBLIC_HOST 支持逗号分隔多个（局域网 IP + 隧道域名可以同时放行）
  const publicHosts = String(publicHost || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map(normalizePublicHost);
  const publicHostSuffixes = publicHosts.filter((h) => h.startsWith('*.')).map((h) => h.slice(2));
  const exactHostNames = ['localhost', '127.0.0.1', '::1', ...publicHosts.filter((h) => !h.startsWith('*.'))];
  const allowedHostNames = new Set(exactHostNames);
  const hostIsAllowed = (name) => {
    const stripped = stripHostPort(name).replace(/\.+$/, '');
    if (!stripped) return false;
    if (allowedHostNames.has(stripped)) return true;
    return publicHostSuffixes.some((suffix) => stripped.endsWith('.' + suffix) && stripped.length > suffix.length + 1);
  };

  if (publicMode) {
    if (publicNoCode) {
      logger.error?.(
        `公开模式未启用访问码：任何能访问该地址的人都可以生成行程并消耗你的模型额度。`
        + `已按每 IP 每天 ${ipDailyCalls || '不限'} 次模型调用止损；要恢复访问码，去掉 HUANTU_PUBLIC_NO_CODE 并设置 HUANTU_ACCESS_CODE。`,
      );
    } else if (accessCode.length < 12) {
      throw Object.assign(
        new Error('公开模式必须设置 HUANTU_ACCESS_CODE（至少 12 位），或者显式设置 HUANTU_PUBLIC_NO_CODE=1 表示「不要访问码」。'),
        { status: 500 },
      );
    }
    if (!publicHosts.length) {
      logger.error?.('公开模式未设置 HUANTU_PUBLIC_HOST：目前只允许 localhost 访问，请补上域名、局域网 IP 或隧道域名。');
    }
  }

  const accessTokens = new Map(); // token -> expiresAt
  const accessFailures = new Map(); // 失败计数：key -> { count, resetAt }
  const ipQuotas = new Map(); // 来源 IP -> { count, resetAt }
  const ACCESS_FAIL_LIMIT = 5;
  const ACCESS_FAIL_WINDOW_MS = 10 * 60 * 1000;

  function isTrustedProxy(remoteAddress) {
    const raw = String(remoteAddress || '');
    const short = raw.replace(/^::ffff:/, '');
    return trustedProxies.some((proxy) => proxy === raw || proxy === short);
  }

  function isHttpsRequest(req) {
    if (req.socket?.encrypted) return true;
    const proto = req.headers['x-forwarded-proto'];
    if (!proto) return false;
    if (!isTrustedProxy(req.socket?.remoteAddress)) return false;
    return String(Array.isArray(proto) ? proto[0] : proto).split(',')[0].trim().toLowerCase() === 'https';
  }

  function readAccessToken(req) {
    const match = String(req.headers.cookie || '').match(/(?:^|;\s*)huantu_access=([a-f0-9]{48})(?:;|$)/);
    if (!match) return '';
    const expiresAt = accessTokens.get(match[1]);
    if (!expiresAt) return '';
    if (Date.now() > expiresAt) {
      accessTokens.delete(match[1]);
      return '';
    }
    return match[1];
  }

  function isAuthorized(req) {
    if (!publicMode) return true;
    if (publicNoCode) return true; // 明确声明了不要访问码
    return Boolean(readAccessToken(req));
  }

  function sameCode(a, b) {
    const left = createHash('sha256').update(String(a)).digest();
    const right = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(left, right);
  }

  function clientKey(req) {
    return String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  }

  function failureState(req) {
    const key = clientKey(req);
    const entry = accessFailures.get(key);
    if (!entry || Date.now() > entry.resetAt) {
      const fresh = { count: 0, resetAt: Date.now() + ACCESS_FAIL_WINDOW_MS };
      accessFailures.set(key, fresh);
      return fresh;
    }
    return entry;
  }

  function issueAccessCookie(req, res) {
    const token = randomBytes(24).toString('hex');
    accessTokens.set(token, Date.now() + accessTokenTtlMs);
    const attributes = [
      `huantu_access=${token}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${Math.floor(accessTokenTtlMs / 1000)}`,
    ];
    if (isHttpsRequest(req)) attributes.push('Secure');
    const existing = res.getHeader('Set-Cookie');
    const cookie = attributes.join('; ');
    res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : cookie);
    return token;
  }

  function clearAccessCookie(res) {
    res.setHeader('Set-Cookie', 'huantu_access=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  }

  function publicState(s) {
    return {
      public: true,
      authorized: true,
      noCode: publicNoCode,
      csrf,
      ready: Boolean(verified) && Boolean(config.apiKey && config.model),
      mode: 'public',
      limits: {
        calls: s.calls,
        callLimit: maxCallsPerSession,
        ipDailyLimit: ipDailyCalls || null,
        accessTtlSeconds: publicNoCode ? 0 : Math.floor(accessTokenTtlMs / 1000),
      },
      calendar: calendarStatus(s),
      hasPlan: Boolean(s.latest),
      planUpdatedAt: s.latest ? s.plans.get(s.latest).meta.generatedAt : null,
      jobs: {
        queue: queue.kind,
        active: (() => {
          const running = activeJob(s);
          return running ? publicJob(running) : null;
        })(),
      },
    };
  }

  const oauth = {
    google: Boolean(process.env.HUANTU_GOOGLE_CLIENT_ID && process.env.HUANTU_GOOGLE_CLIENT_SECRET),
    apple: Boolean(process.env.HUANTU_APPLE_CLIENT_ID && process.env.HUANTU_APPLE_CLIENT_SECRET),
  };
  // 实时联网搜索：默认 bing（抓 cn.bing.com，零成本、免密钥，国内直连可达）。
  // 想要结构化结果就换成带 key 的服务：设 HUANTU_SEARCH_PROVIDER=tavily/bocha/zhipu/serper 并填 HUANTU_SEARCH_API_KEY；
  // searxng 需另设 HUANTU_SEARCH_BASE_URL；设 HUANTU_SEARCH_PROVIDER=off 可彻底关闭。
  // 注意 duckduckgo 免 key 但国内直连不通（超时），不要当默认值用。
  const searchProvider = (process.env.HUANTU_SEARCH_PROVIDER || 'auto').toLowerCase();
  const searchBaseUrl = process.env.HUANTU_SEARCH_BASE_URL || '';
  const searchEngine = process.env.HUANTU_SEARCH_ENGINE || 'search_pro'; // 仅 zhipu 生效
  let searchApiKey = process.env.HUANTU_SEARCH_API_KEY || '';
  // deepseek 搜索与模型同 key：没单独填就用模型那把
  if (!searchApiKey && searchProvider === 'deepseek') searchApiKey = process.env.HUANTU_API_KEY || '';
  const searchEnabled = searchProvider !== 'off';
  const searchLabel = SEARCH_PROVIDER_LABEL[searchProvider] || searchProvider;
  // 实时天气：Open-Meteo 免费免 key，默认开启；设 HUANTU_WEATHER=off 可关闭（无外网的机器用）。
  const weatherEnabled = (process.env.HUANTU_WEATHER || 'open-meteo').toLowerCase() !== 'off';
  // 给推荐地点配图：抓搜索结果页面的 og:image，零 key。设 HUANTU_PHOTOS=off 可关。
  const photosEnabled = (process.env.HUANTU_PHOTOS || 'on').toLowerCase() !== 'off';
  // 研究时抓取搜索结果页面的正文（比摘要信息量大得多）。设 HUANTU_FETCH_BODY=off 可关。
  const fetchBodyEnabled = (process.env.HUANTU_FETCH_BODY || 'on').toLowerCase() !== 'off';
  const fetchBodyMax = Math.max(0, Math.min(12, Number(process.env.HUANTU_FETCH_MAX || 6) || 6));
  const adapters = {
    search: searchEnabled,
    maps: Boolean(process.env.HUANTU_MAPS_API_KEY),
    hotels: Boolean(process.env.HUANTU_HOTELS_API_KEY),
    weather: weatherEnabled,
  };

  /* ---------------- 搜索知识库（持久化） ---------------- */
  // 搜过的景点票价、酒店评价、配图全部落盘，下次同城同问直接命中，不再联网。
  // 存 <dataDir>/library/ 而 knowledge/ 目录：部署会覆盖 knowledge/，但不会碰 .data/。
  const libraryEnabled = (process.env.HUANTU_LIBRARY || 'on').toLowerCase() !== 'off';
  const libraryTtlOverride = {};
  for (const [k, env] of [
    ['search', 'HUANTU_LIBRARY_TTL_SEARCH'],
    ['spot', 'HUANTU_LIBRARY_TTL_SPOT'],
    ['photo', 'HUANTU_LIBRARY_TTL_PHOTO'],
    ['digest', 'HUANTU_LIBRARY_TTL_DIGEST'],
  ]) {
    const n = Number(process.env[env] || 0);
    if (Number.isFinite(n) && n > 0) libraryTtlOverride[k] = n;
  }
  const library = libraryEnabled
    ? createLibrary({ dir: path.join(dataDir, 'library'), logger, ttlDays: libraryTtlOverride })
    : null;
  if (library) {
    try {
      const sum = await library.load();
      logger?.info?.(`知识库已加载：${sum.cities} 座城市 / ${sum.entries} 条记录（fresh ${sum.fresh}，stale ${sum.stale}）`);
    } catch (e) {
      logger?.warn?.(`知识库加载失败（不影响生成，只是这次不复用缓存）：${e.message}`);
    }
  }

  /** 一次规划里的知识库使用账本：命中几条、省了几次网络请求，最后给前端看。 */  function newLibraryUsage(city) {
    const hits = [];
    const misses = [];
    const fails = [];
    return {
      city,
      hits,
      misses,
      fails,
      noteHit(item) { hits.push(item); },
      noteMiss(item) { misses.push(item); },
      noteFail(item) { fails.push(item); },
      summary({ reused = false } = {}) {
        const byKind = {};
        for (const h of hits) byKind[h.kind] = (byKind[h.kind] || 0) + 1;
        return {
          enabled: Boolean(library),
          city,
          reused,
          hits: hits.length,
          misses: misses.length,
          fails: fails.length,
          fresh: hits.filter((h) => h.state === 'fresh').length,
          stale: hits.filter((h) => h.state === 'stale').length,
          // 省下的网络请求数：三类搜索 + 每个景点 + 每张图，各算一次
          savedFetches: hits.length,
          hitKinds: byKind,
          items: hits.slice(0, 60),
          missItems: misses.slice(0, 60),
        };
      },
    };
  }

  /**
   * 行程定稿后，把「已确认的结构化事实」回写知识库。
   * 门票、开放时间、片区、坐标这些东西模型已经结合搜索结果定过一次了，
   * 下次同城同景点就不必从零再推一遍 —— 但仍会作为「待复核」注入，不是当真理用。
   */
  function savePlanDigest({ input, plan, city }) {
    if (!library || !city) return 0;
    const at = new Date().toISOString();
    let saved = 0;
    const put = (key, data, query) => {
      if (!key) return;
      library.store({
        city,
        kind: 'digest',
        key,
        data: { ...data, planId: plan.planId, confirmedAt: at },
        query,
        origin: 'model',
        note: `模型结合搜索结果确认于 ${plan.meta?.generatedAt || at}`,
      });
      saved += 1;
    };

    for (const a of plan.insights?.attractions || []) {
      if (!a?.name) continue;
      put(a.name, {
        name: a.name,
        area: a.area,
        ticket: a.ticket,
        openingHours: a.openingHours,
        booking: a.booking,
        suggestedDuration: a.suggestedDuration,
        bestTime: a.bestTime,
      }, `${city} ${a.name} 门票 开放时间`);
    }
    for (const h of plan.hotels || []) {
      if (!h?.name) continue;
      put(h.name, {
        name: h.name,
        area: h.area,
        priceRange: h.priceRange,
        rating: h.rating,
        ratingSource: h.ratingSource,
      }, `${city} ${h.name} 酒店 房价 评分`);
    }
    if (saved) library.flush?.().catch(() => {});
    return saved;
  }

  /** 研究阶段把知识库里确认过的事实捞出来，作为「先用这份、但要复核」的起点。 */
  function libraryDigestText(city, limit = 8) {
    if (!library || !city) return '';
    const rows = [];
    for (const entry of library.list({ city, kind: 'digest' }).slice(0, limit)) {
      const d = entry.data || {};
      const bits = [d.ticket && `门票 ${d.ticket}`, d.openingHours && `开放 ${d.openingHours}`,
        d.booking && `预约 ${d.booking}`, d.priceRange && `价位 ${d.priceRange}`]
        .filter(Boolean).join('；');
      if (!bits) continue;
      rows.push(`- ${entry.key}：${bits}（${entry.ageDays} 天前确认${entry.state === 'stale' ? '，可能已变动' : ''}）`);
    }
    return rows.length
      ? `\n\n【本地知识库 · 之前确认过的结构化事实】（缓存于 ${city}，${rows.length} 条。请以此为起点，但票价/时间仍可能变动，有实时检索结果时以实时结果为准）：\n${rows.join('\n')}`
      : '';
  }

  function json(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  async function readBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) fail('需要 JSON 请求。', 415);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) fail('请求内容过长。', 413);
    }
    try {
      return JSON.parse(raw || '{}');
    } catch {
      fail('请求 JSON 无效。');
    }
  }

  function session(req, res) {
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)huantu_sid=([a-f0-9]{48})(?:;|$)/)?.[1];
    const id = cookie || randomBytes(24).toString('hex');
    if (!cookie) {
      res.setHeader('Set-Cookie', `huantu_sid=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    }
    if (!sessions.has(id)) {
      sessions.set(id, { id, plans: new Map(), latest: null, calls: 0, busy: false, calendar: {}, lastSeen: Date.now(), ip: '' });
    }
    const s = sessions.get(id);
    s.lastSeen = Date.now();
    // 无访问码时按 IP 的日配额是唯一止损手段，所以每个请求都把来源 IP 记在会话上
    s.ip = clientKey(req);
    return s;
  }

  async function saveNonSecretConfig() {
    const savedAt = new Date().toISOString();
    const temp = configFile + '.tmp';
    // 只落盘非秘密字段：baseUrl / model / protocol / role / savedAt
    await writeFile(temp, JSON.stringify({
      baseUrl: config.baseUrl, model: config.model, protocol: config.protocol, role: config.role, savedAt,
    }, null, 2), { mode: 0o600 });
    await rename(temp, configFile);
    configSavedAt = savedAt;
  }

  function modelError(code, message, status = 502) {
    lastError = { code, message, at: new Date().toISOString() };
    fail(message, status);
  }

  function extractContent(body, protocol) {
    if (protocol === 'responses') {
      return body.output
        ?.filter((item) => item.type === 'message' && item.role === 'assistant')
        .flatMap((item) => item.content || [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text)
        .join('\n') || '';
    }
    return body.choices?.[0]?.message?.content || '';
  }

  /**
   * 调用模型。
   *
   * 优先使用流式响应：中转网关通常会在 120 秒左右掐断"长时间无数据"的请求，
   * 而旅行方案这种长 JSON 很容易超时。改成流式后只要模型持续吐字就不会被断开，
   * 同时用「空闲超时」而不是「总时长超时」来判断卡死。
   * 如果服务端不支持流式（返回普通 JSON），自动回退到非流式解析。
   */
  async function modelCall(messages, { signal } = {}) {
    if (!config.apiKey || !config.model) {
      fail('尚未配置模型。请在「模型设置」中填写 API 地址、模型 ID 与密钥后重试；寰途不会用模板冒充模型输出。', 503);
    }
    const cfg = { ...config };
    const revision = configRevision;
    const started = Date.now();
    const isResponses = cfg.protocol === 'responses';

    const controller = new AbortController();
    let abortedBy = '';
    let idleTimer = setTimeout(() => { abortedBy = 'idle'; controller.abort(); }, modelIdleMs);
    const overallTimer = setTimeout(() => { abortedBy = 'overall'; controller.abort(); }, modelTimeoutMs);
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { abortedBy = 'idle'; controller.abort(); }, modelIdleMs);
    };

    // 外部取消（用户点「取消任务」）直接中断上游请求，不等它自己结束
    const onExternalAbort = () => {
      abortedBy = 'cancelled';
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      controller.abort();
    };
    const stopTimers = () => {
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    };
    if (signal) {
      if (signal.aborted) {
        stopTimers();
        fail('任务已取消。', 499);
      }
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response;
    try {
      response = await fetch(cfg.baseUrl + (isResponses ? '/responses' : '/chat/completions'), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          ...(isResponses ? { input: messages } : { messages }),
          stream: true,
          store: false,
        }),
      });
    } catch (error) {
      stopTimers();
      if (abortedBy === 'cancelled') fail('任务已取消。', 499);
      const timeout = abortedBy || error?.name === 'TimeoutError' || error?.name === 'AbortError';
      modelError(
        timeout ? 'timeout' : 'network',
        timeout
          ? `模型服务在 ${abortedBy === 'idle' ? Math.round(modelIdleMs / 1000) + ' 秒内没有返回任何内容' : '限定时间内没有完成'}，已中止请求。请检查服务状态或换一个更快的模型；寰途没有生成替代行程。`
          : '模型服务连接失败。请检查 API 地址、网络或服务状态；寰途没有生成替代行程。',
      );
    }
    if (!response.ok) {
      stopTimers();
      const reasons = {
        400: '请求被拒绝，可能是模型名或参数不被支持',
        401: '密钥无效或已过期',
        403: '当前密钥没有访问权限',
        404: '接口路径或模型 ID 不正确',
        429: '额度不足或请求过于频繁',
      };
      modelError(`http_${response.status}`, `模型服务返回 ${response.status}：${reasons[response.status] || '服务暂时不可用'}。`);
    }

    const contentType = String(response.headers.get('content-type') || '');
    let content = '';
    let streamed = false;

    try {
      if (contentType.includes('text/event-stream')) {
        streamed = true;
        const result = await readModelStream(response, { isResponses, touch });
        content = result.text;
        if (result.error) {
          modelError('stream_error', `模型流式响应中断：${result.error}`);
        }
        if (result.incomplete) {
          modelError('incomplete_response', '模型响应未完成（输出被截断），请重试或缩短行程天数。');
        }
      } else {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          touch();
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            modelError('response_too_large', '模型响应过大，请缩短行程天数或更换模型后重试。');
          }
          chunks.push(value);
        }
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          modelError('invalid_json', '模型服务返回了无效 JSON，请检查兼容接口地址。');
        }
        if (parsed.error) {
          modelError('provider_error', `模型服务返回错误：${sanitizeText(parsed.error?.message || parsed.error, 160)}`);
        }
        if (isResponses && parsed.status && parsed.status !== 'completed') {
          modelError('incomplete_response', '模型响应未完成，请重试或检查服务商兼容性。');
        }
        content = extractContent(parsed, cfg.protocol);
      }
    } catch (error) {
      if (error?.status) throw error;
      if (abortedBy === 'cancelled') fail('任务已取消。', 499);
      const timeout = abortedBy || error?.name === 'AbortError' || error?.name === 'TimeoutError';
      modelError(
        timeout ? 'timeout' : 'stream_failed',
        timeout
          ? '模型输出中途停止（网络或服务商中止）。请重试；寰途没有生成替代行程。'
          : '读取模型响应时连接中断，请重试。',
      );
    } finally {
      stopTimers();
    }

    if (revision !== configRevision) fail('模型配置已改变，请重新提交。', 409);
    if (typeof content !== 'string' || !content.trim()) {
      modelError('empty_response', '模型服务没有返回文本内容。');
    }
    lastError = null;
    return { text: content, model: cfg.model, protocol: cfg.protocol, streamed, elapsedMs: Date.now() - started };
  }

  /** 解析 SSE：兼容 chat.completion.chunk 与 Responses API 的事件流 */
  async function readModelStream(response, { isResponses, touch }) {
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let error = '';
    let incomplete = false;
    let done = false;

    const handlePayload = (payload) => {
      if (!payload || payload === '[DONE]') return;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        return; // 忽略非 JSON 的心跳行
      }
      if (obj.error) {
        error = sanitizeText(obj.error?.message || obj.error, 160);
        return;
      }
      if (isResponses) {
        const type = obj.type || '';
        if (type === 'response.output_text.delta' && typeof obj.delta === 'string') {
          text += obj.delta;
        } else if (type === 'response.output_item.done' && obj.item?.type === 'message') {
          // 某些实现只在结束时给出完整文本，避免重复累加
          const full = (obj.item.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
          if (full && !text.trim()) text = full;
        } else if (type === 'response.completed') {
          if (obj.response?.status && obj.response.status !== 'completed') incomplete = true;
          done = true;
        } else if (type === 'response.incomplete') {
          incomplete = true;
          done = true;
        } else if (type === 'response.failed' || type === 'error') {
          error = sanitizeText(obj.response?.error?.message || obj.message || '模型服务返回失败', 160);
          done = true;
        }
      } else {
        const choice = obj.choices?.[0];
        if (choice?.delta?.content) text += choice.delta.content;
        if (choice?.finish_reason) done = true;
      }
    };

    for await (const chunk of response.body) {
      touch();
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === '\r' ? 4 : 2));
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          handlePayload(line.slice(5).trim());
        }
        if (done) break;
      }
      if (done) break;
    }
    if (buffer.trim().startsWith('data:')) handlePayload(buffer.trim().slice(5).trim());

    return { text, error, incomplete };
  }

  function parseModelJson(raw) {
    const cleaned = String(raw).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      const err = Object.assign(
        new Error('模型没有返回可解析的行程 JSON。已保留原始错误，未展示未经校验的内容。'),
        { status: 502 },
      );
      lastError = { code: 'invalid_model_output', message: err.message, at: new Date().toISOString() };
      throw err;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('模型返回的行程结构不正确。', 502);
    }
    return parsed;
  }

  function checkBudget(s) {
    if (s.calls >= maxCallsPerSession) {
      fail(`这个浏览器的试用次数用完了（每次规划消耗 2 次，上限 ${maxCallsPerSession} 次）。刷新页面可以重新开始。`, 429);
    }
    // 公开模式（尤其是不设访问码时）可选地按来源 IP 记账：清 Cookie 换会话也绕不过去。
    // 默认关闭（0），需要止损时再打开。
    if (ipDailyCalls > 0) {
      const key = s.ip || 'unknown';
      const now = Date.now();
      let entry = ipQuotas.get(key);
      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + 24 * 3600 * 1000 };
        ipQuotas.set(key, entry);
      }
      if (entry.count >= ipDailyCalls) {
        fail(`今天的试用额度用完了（每个网络每天 ${ipDailyCalls} 次调用），明天再试。`, 429);
      }
      entry.count += 1;
    }
    s.calls += 1;
  }

  function tripLabels(input) {
    return [
      `出发地：${input.origin}`,
      `目的地：${input.destination}`,
      `日期：${input.startDate} 至 ${input.endDate}（${input.days} 天）`,
      `人数：${input.travelers} 人${input.children ? `（含儿童 ${input.children} 人）` : ''}`,
      `预算：${input.budget}`,
      `兴趣：${input.interests.length ? input.interests.join('、') : '未指定'}`,
      `节奏：${PACE_LABEL[input.pace]}`,
      `交通偏好：${TRANSPORT_LABEL[input.transport]}`,
      `住宿偏好：${HOTEL_LABEL[input.hotelPreference]}`,
      `特殊需求：${input.special || '无'}`,
    ].join('\n');
  }

  function buildResearchPrompt(input, { change, weather = null, hotels = null, transport = null, attractions = null } = {}) {
    const retrieved = retrieveKnowledge(
      [input.destination, input.origin, ...(input.interests || []), input.special, change].join(' '),
      destinations,
      2,
    );
    const knowledgeText = retrieved.length
      ? retrieved.map((s) => `【${s.title}】\n${s.text}`).join('\n\n')
      : '本次没有命中本地目的地知识段落；请只使用通用旅行常识，并对不确定的信息写“待核实”。';

    const when = new Date().toLocaleString('zh-CN', { hour12: false });
    // 每条结果带上来源站点，模型引用时能写清「据某站」
    // 每条结果带上来源站点，模型引用时能写清「据某站」。
    // 抓到正文的（r.body）优先用正文：摘要常常只有标题复述，正文里才有票价和开放时间。
    const hitsText = (groups) => (groups || [])
      .map((h) => {
        const tag = h.cached
          ? `【本地知识库缓存 · ${h.ageDays ?? '?'} 天前抓取${h.stale ? ' · 已过期，仅供参考' : ''}】`
          : '';
        return `${tag}${(h.results || []).slice(0, 4)
          .map((r) => {
            const src = r.site ? `（来源：${r.site}）` : '';
            const where = r.url ? `（${r.url}）` : '';
            if (r.body) return `- ${r.title}${src}${where}\n  正文节选：${r.body}`;
            return `- ${r.title}${src}：${r.snippet}${where}`;
          }).join('\n')}`;
      })
      .filter(Boolean).join('\n\n');

    let liveText = '';

    if (weather?.days?.length) {
      const lines = weather.days.map((w) =>
        `${w.date}：${w.summary}，${w.tmin ?? '?'}~${w.tmax ?? '?'}℃，${
          w.precip == null ? `降水量 ${w.rainMm ?? '?'} mm` : `降水概率 ${w.precip}%`
        }`).join('\n');
      const kindNote = weather.kind === 'climate'
        ? `注意：出行日期超出现报范围，以下为去年同期实测，只能当作气候参考，不能写成「预报」。`
        : '';
      liveText += `\n\n【实时天气】（来源：${weather.source}，查询于 ${when}）：\n${lines}\n${kindNote}请写入 insights.season.weather，并在季节说明里注明来源为 ${weather.source}；据天气安排活动（雨天优先室内/备选方案）。`;
    }

    const attrText = hitsText(attractions);
    if (attrText) {
      liveText += `\n\n【实时搜索结果 · 景点票价/开放】（来源：公开网页，查询于 ${when}）：\n${attrText}\n请据此填写 insights.attractions 的门票与开放时间。标了「正文节选」的是抓回来的网页原文，其中的具体数字（票价、时间、预约要求）优先采信，摘要次之；官网来源优先于聚合站。在 why 里注明来源；仍无法确认的数值写「待核实」，不得编造。`;
    }

    const hotelText = hitsText(hotels);
    if (hotelText) {
      const pref = { budget: '经济', comfort: '舒适', boutique: '设计感/精品', luxury: '高端', homestay: '民宿', any: '不限' }[input.hotelPreference] || '不限';
      liveText += `\n\n【实时搜索结果 · 酒店评价】（来源：公开网页/评价平台，查询于 ${when}）：\n${hotelText}\n筛选规则：只推荐评价良好（约 ≥4.0/5 或正面为主）的酒店；评价差或负面多的直接排除；必须符合预算（${input.budget}）与住宿偏好（${pref}）；在 reason 里注明评价来源；房态与可订性必须在预订平台确认，标「待核实」。`;
    }

    const transText = hitsText(transport);
    if (transText) {
      liveText += `\n\n【实时搜索结果 · 地铁/公交】（来源：公开网页/官方公告，查询于 ${when}）：\n${transText}\n若某条地铁/公交线路近期停运、施工或调整，规划时避开该线路、改用替代路线，并在 route.notes 写明受影响的线路与替代方案。`;
    }

    const systemExtra = `寰途本地知识库中与本次目的地相关的段落（静态整理，编写于 2026-10，可能过期，不得当作实时事实）：\n\n${knowledgeText}\n\n来源与核验政策摘要：\n${sourcesDoc.slice(0, 1000)}${libraryDigestText(libraryCityOf(input.destination))}${liveText}`;

    return [
      { role: config.role, content: rules },
      { role: 'system', content: systemExtra },
      {
        role: 'user',
        content: `需求：\n${tripLabels(input)}\n\n请按【阶段一 · 目的地研究】输出 JSON。${change ? `\n用户本轮的新要求：${change}` : ''}`,
      },
    ];
  }

  function buildItineraryPrompt(input, research, { change, oldPlan, weather = null, transport = null, spotFacts = null } = {}) {
    const digest = {
      title: research?.overview?.title,
      summary: research?.overview?.summary,
      highlights: research?.overview?.highlights,
      hotelArea: research?.route?.hotelArea,
      routeLogic: research?.route?.logic,
      attractions: (research?.insights?.attractions || []).map((a) => `${a.name}（${a.area || ''}，${a.suggestedDuration || ''}）`),
      food: (research?.insights?.food || []).map((f) => `${f.name}（${f.area || ''}）`),
      transport: (research?.insights?.transport || []).map((t) => `${t.mode}：${t.detail}`),
      season: research?.insights?.season?.summary,
      paceNote: research?.overview?.paceNote,
    };

    const existing = change && oldPlan
      ? `\n\n用户要求改动：${change}\n现有行程（未被要求改动的部分尽量保留，标注锁定的必须原样保留；days 仍为 ${input.days} 天）：\n${JSON.stringify(
        (oldPlan.days || []).map((d) => ({
          day: d.day,
          theme: d.theme,
          locked: Boolean(d.locked),
          items: (d.items || []).map((it) => ({
            time: it.time, title: it.title, type: it.type, durationMin: it.durationMin, locked: Boolean(it.locked),
          })),
        })),
      )}`
      : '';

    let liveNote = '';
    if (weather?.days?.length) {
      const lines = weather.days.map((w) =>
        `${w.date}：${w.summary}，${w.tmin ?? '?'}~${w.tmax ?? '?'}℃，${
          w.precip == null ? `降水量 ${w.rainMm ?? '?'} mm` : `降水概率 ${w.precip}%`
        }`).join('\n');
      const kindNote = weather.kind === 'climate' ? '（去年同期实测，仅作气候参考，不是预报）' : '';
      liveNote += `\n\n实时天气（来源：${weather.source}）${kindNote}：\n${lines}\n安排每日活动时，雨天优先室内/备选方案，并在该天 notes 注明天气与来源。`;
    }
    const transText = (transport || [])
      .map((h) => (h.results || []).slice(0, 3).map((r) => `- ${r.title}：${r.snippet}`).join('\n'))
      .filter(Boolean).join('\n');
    if (transText) {
      liveNote += `\n\n交通/地铁公交实时公告（来源：公开网页/官方公告）：\n${transText}\n若某线路停运/施工/调整，避开该线路、改用替代路线，并在当天 notes 写明替代方案。`;
    }

    // 逐景点补搜到的票价 / 开放时间，直接喂给行程模型，让它有数字可写。
    const factLines = [];
    for (const [name, pack] of Object.entries(spotFacts || {})) {
      for (const r of (pack?.results || []).slice(0, 2)) {
        const snip = String(r.snippet || '').replace(/\s+/gu, ' ').trim().slice(0, 180);
        if (!snip) continue;
        factLines.push(`- ${name}（来源：${r.site || '原文'}）：${snip}（${r.url}）`);
      }
    }
    if (factLines.length) {
      liveNote += `\n\n景点门票与开放时间（已按景点逐个实时检索，覆盖 ${Object.keys(spotFacts || {}).length} 个景点）：\n${factLines.join('\n')}\n`
        + '写 insights.attractions 时：ticket 与 openingHours 必须优先采用上面出现的具体数值，并在 why 或 note 里注明来源站点；'
        + '上面确实没有明确数字的才写「待核实」。不许自己编票价和时刻表。';
    }

    return [
      { role: config.role, content: rules },
      {
        role: 'user',
        content: `需求：\n${tripLabels(input)}\n\n已确认的研究结论（只能使用这里出现的地点和片区，不要临时发明）：\n${JSON.stringify(digest)}\n\n请按【阶段二 · 每日行程】输出 JSON，days 长度必须为 ${input.days}。${liveNote}${existing}`,
      },
    ];
  }

  /**
   * 把逐景点抓到的原文（常常是日文或英文）整理成简体中文要点。
   * 只做「翻译 + 归位」：原文没写的字段一律留空，不许推测、不许估算。
   */
  async function summarizeSpotFacts(spotFacts, { signal } = {}) {
    const packs = Object.entries(spotFacts || {}).filter(([, v]) => Array.isArray(v?.results) && v.results.length);
    if (!packs.length) return {};
    const payload = packs.map(([name, v]) => ({
      name,
      pages: v.results.slice(0, 2).map((r) => ({
        site: r.site || '',
        url: r.url || '',
        text: String(r.snippet || '').replace(/\s+/gu, ' ').trim().slice(0, 900),
      })),
    }));

    const messages = [
      {
        role: config.role,
        content: [
          '你把抓取到的景点页面原文（多为日文或英文）整理成简体中文要点，给中文用户看。',
          '硬性要求：',
          '1. 只翻译和归位原文里明确写出的信息，绝不补充原文没有的内容，绝不估算。',
          '2. 原文没有写的字段，值必须是 null；不要写「待核实」「不详」这类字。',
          '3. 数字、时间、价格严格照原文；日元的「円」写成「日元」。',
          '4. 只输出 JSON，不要任何解释文字、不要代码块标记。',
          '输出格式：',
          '{"spots":[{"name":"景点名，照抄输入","ticket":"门票，例：成人 1300 日元，中小学生 400 日元","hours":"开放时间，例：8:45–16:00（17:00 闭城）","closed":"休馆日 / 休息日","booking":"是否需要预约","note":"其它要提醒的，如夜间特别场、临时闭馆","sourceUrl":"这些信息主要来自的链接","sourceName":"该站点名称"}]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `以下是各个景点的原文页面：\n${JSON.stringify(payload)}\n\n请按格式输出 JSON。`,
      },
    ];

    const r = await modelCall(messages, { signal });
    const parsed = parseModelJson(r.text);
    const out = {};
    for (const item of Array.isArray(parsed?.spots) ? parsed.spots : []) {
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const pick = (v) => {
        const s = String(v ?? '').replace(/\s+/gu, ' ').trim();
        return s && s !== 'null' && s !== 'undefined' ? s.slice(0, 170) : '';
      };
      const row = {
        ticket: pick(item.ticket),
        hours: pick(item.hours),
        closed: pick(item.closed),
        booking: pick(item.booking),
        note: pick(item.note),
        sourceUrl: /^https?:\/\//u.test(String(item.sourceUrl || '')) ? String(item.sourceUrl) : '',
        sourceName: pick(item.sourceName),
      };
      if (row.ticket || row.hours || row.closed || row.booking || row.note) out[name] = row;
    }
    return out;
  }

  /**
   * 执行一次完整规划（研究 → 行程）。不负责 HTTP、不负责状态字段，
   * 只通过 onStage 汇报阶段、通过 signal 响应取消，方便同步接口与后台任务共用。
   */
  async function runPlanning({ s, input, change = '', refreshInsights = false, basePlan = null, onStage = () => {}, onPreview = null, signal }) {
    const started = Date.now();
    // 这次规划的知识库账本：命中了多少、省了多少次搜索，最后随 plan 返回
    const libUsage = newLibraryUsage(library ? libraryCityOf(input.destination) : '');
    let fetchMs = 0;
    const oldPlan = change ? (basePlan || (s.latest ? s.plans.get(s.latest) : null)) : null;
    const reuseResearch = Boolean(oldPlan) && !refreshInsights;
    let research = reuseResearch
      ? {
        overview: oldPlan.overview,
        insights: oldPlan.insights,
        hotels: oldPlan.hotels,
        route: oldPlan.route,
        confidence: oldPlan.confidence,
        warnings: oldPlan.warnings,
        sources: [],
      }
      : null;
    const stages = [];
    let model = null;
    let protocol = null;
    let researchSavedAt = null;

    let weather = null;
    let hotels = null;
    let transport = null;
    let attractions = null;
    let spotFacts = null;
    let spotFactMisses = null;
    let searchedAt = null;
    if (!research) {
      onStage('researching');
      checkBudget(s);
      // 研究前并行拉取：实时天气（Open-Meteo）+ 景点/酒店/交通三类搜索（失败各自降级，不阻断主流程）。
      // 天气与搜索互相独立：关掉搜索仍然查天气。
      const [w, groups] = await Promise.all([
        weatherEnabled
          ? getTripWeather(input.destination, input.startDate, input.endDate, logger)
          : Promise.resolve(null),
        searchEnabled
          ? runSearchByCategory(input, {
            provider: searchProvider, apiKey: searchApiKey, baseUrl: searchBaseUrl,
            engine: searchEngine, logger, library, usage: libUsage,
          }, signal)
          : Promise.resolve(null),
      ]);
      weather = w;
      attractions = groups?.attractions || null;
      hotels = groups?.hotels || null;
      transport = groups?.transport || null;
      searchedAt = (weather || attractions || hotels || transport) ? new Date().toISOString() : null;
      // 抓正文：摘要只有一两句，门票/开放时间/预约这类细节要靠原文。逐条失败不影响生成。
      if (fetchBodyEnabled && groups && fetchBodyMax > 0) {
        const tb = Date.now();
        try {
          await enrichWithBodies(groups, { max: fetchBodyMax, signal, logger });
        } catch (e) {
          logger?.warn?.(`正文抓取失败：${e.message}`);
        }
        fetchMs = Date.now() - tb;
      }
      const t0 = Date.now();
      const r1 = await modelCall(buildResearchPrompt(input, { change, weather, hotels, transport, attractions }), { signal });
      stages.push({ stage: 'research', elapsedMs: Date.now() - t0 });
      research = parseModelJson(r1.text);
      model = r1.model;
      protocol = r1.protocol;
      researchSavedAt = new Date().toISOString();

      // 研究结果一出来就先推一版概览：用户在等着排每日动线的那几分钟里，
      // 已经能看到酒店片区、候选景点和关键提醒，而不是只有一个秒表在转。
      if (onPreview) {
        try {
          onPreview({
            overview: normalizeOverview(research.overview, input),
            attractions: asArray(research.insights?.attractions, 6).map((a) => ({
              name: sanitizeText(a?.name, 60),
              area: sanitizeText(a?.area, 40),
              why: sanitizeText(a?.why, 120),
              ticket: sanitizeText(a?.ticket, 40) || TBD,
            })).filter((a) => a.name),
            hotelArea: sanitizeText(research.route?.hotelArea, 60),
            hotelCount: asArray(research.hotels, 8).length,
            confidence: ['高', '中', '低'].includes(research.confidence?.level) ? research.confidence.level : '中',
            warnings: asArray(research.warnings, 3).map((w) => sanitizeText(w, 160)).filter(Boolean),
            at: new Date().toISOString(),
          });
        } catch {
          /* 概览只是提前给个轮廓，出错不能拖垮主任务 */
        }
      }
    } else {
      // 复用旧研究结论时，一并带走上次的实时数据。
      const oldLive = oldPlan?._live || {};
      weather = oldLive.weather || null;
      hotels = oldLive.hotels || null;
      transport = oldLive.transport || null;
      attractions = oldLive.attractions || null;
      spotFacts = oldLive.spotFacts || null;
      spotFactMisses = oldLive.spotFactMisses || null;
      searchedAt = oldPlan?._searchedAt || null;
    }

    onStage('planning');
    checkBudget(s);
    // 配图与行程阶段并行跑，几乎不额外增加等待时间
    const photoPlaces = [
      ...(research?.insights?.attractions || []).map((a) => ({ name: a?.name, kind: 'attraction' })),
      ...(research?.hotels || []).map((h) => ({ name: h?.name, kind: 'hotel' })),
    ];
    const reusedPhotos = (reuseResearch && oldPlan?.photos) ? oldPlan.photos : null;
    const photosPromise = (!reusedPhotos && photosEnabled && photoPlaces.length)
      ? collectPlacePhotos(photoPlaces, {
        cfg: { provider: searchProvider, apiKey: searchApiKey, baseUrl: searchBaseUrl, engine: searchEngine },
        groups: [].concat(attractions || [], hotels || [], transport || []),
        destination: input.destination,
        logger,
        signal,
        library,
        usage: libUsage,
      }).catch((e) => { logger?.warn?.(`配图整体失败：${e.message}`); return {}; })
      : Promise.resolve(reusedPhotos || {});

    // 景点票价/开放时间按「具体景点名」补搜一次。
    // 研究阶段那两条泛查询只能搜到「京都景点总览」，落不到清水寺、金阁寺头上，
    // 模型拿不到数字就只能写「待核实」——这一步就是为了把它补上。
    const reusedFacts = (reuseResearch && oldPlan?._live?.spotFacts) ? oldPlan._live.spotFacts : null;
    const reusedMisses = (reuseResearch && oldPlan?._live?.spotFactMisses) ? oldPlan._live.spotFactMisses : null;
    const spotPlaces = (research?.insights?.attractions || []).map((a) => ({ name: a?.name }));
    const spotFactsPromise = (!reusedFacts && spotPlaces.length)
      ? collectSpotFacts(spotPlaces, {
        // 搜索关掉时也走一趟，好让每个景点都记下「这次没开检索」，而不是空白
        cfg: searchEnabled
          ? { provider: searchProvider, apiKey: searchApiKey, baseUrl: searchBaseUrl, engine: searchEngine }
          : { provider: 'off' },
        destination: input.destination,
        logger,
        signal,
        library,
        usage: libUsage,
      }).catch((e) => { logger?.warn?.(`景点票价补搜整体失败：${e.message}`); return { facts: {}, misses: {} }; })
      : Promise.resolve({ facts: reusedFacts || {}, misses: reusedMisses || {} });
    {
      const pack = await spotFactsPromise;
      spotFacts = pack.facts || {};
      spotFactMisses = pack.misses || {};
    }

    // 抓回来的原文多半是日文，顺手整理成中文要点；失败了就退回显示原文，不挡主流程。
    let factSummaryPromise;
    if (reuseResearch && oldPlan?._live?.spotFactSummary) {
      factSummaryPromise = Promise.resolve(oldPlan._live.spotFactSummary);
    } else if (Object.keys(spotFacts || {}).length) {
      factSummaryPromise = summarizeSpotFacts(spotFacts, { signal })
        .catch((e) => { logger?.warn?.(`景点情报整理失败：${e.message}`); return {}; });
    } else {
      factSummaryPromise = Promise.resolve({});
    }

    const t1 = Date.now();
    const r2 = await modelCall(buildItineraryPrompt(input, research, { change, oldPlan, weather, transport, spotFacts }), { signal });
    stages.push({ stage: 'itinerary', elapsedMs: Date.now() - t1 });
    const itinerary = parseModelJson(r2.text);
    model = model || r2.model;
    protocol = protocol || r2.protocol;

    const combined = {
      ...research,
      days: Array.isArray(itinerary.days) ? itinerary.days : (Array.isArray(itinerary) ? itinerary : research.days),
      // 费用由阶段二按最终动线给出，不能漏合，否则预算对比永远是 0
      budget: itinerary.budget ?? research.budget,
      warnings: [...(research.warnings || []), ...(itinerary.warnings || [])],
      sources: [...(research.sources || []), ...(itinerary.sources || [])],
    };

    const planId = randomBytes(6).toString('hex');
    let plan = normalizePlan(combined, input, { planId, model, protocol });
    plan.meta.elapsedMs = Date.now() - started;
    plan.meta.mode = change ? 'replan' : 'initial';
    plan.meta.change = change || '';
    plan.meta.stages = stages;
    plan.meta.researchReused = reuseResearch;

    // —— 坐标三档处理 ——
    // 1) 剔掉偏离城市中心 50km 以上的坐标（多半是串城市或同名景点套错）
    // 2) 剩下的空坐标走地理编码兜底（高德优先，Nominatim 次之）
    // 3) 仍补不到的保持 null，交给用户手动定位
    const geocodeEnabled = (process.env.HUANTU_GEOCODE || 'on').toLowerCase() !== 'off';
    if (geocodeEnabled) {
      const amapKey = process.env.HUANTU_AMAP_KEY || '';
      const center = await resolveCityCenterForGeo(input.destination, plan);
      const far = rejectFarStops(plan, center);
      if (far.rejected.length) {
        logger?.warn?.(`丢弃 ${far.rejected.length} 个偏离城市中心 ${CITY_RADIUS_KM}km 以上的坐标：`
          + far.rejected.map((r) => `${r.title}(${r.km}km)`).join('、'));
      }
      const t2 = Date.now();
      const filled = await fillMissingGeo(plan, { city: input.destination, center, amapKey, signal, logger });
      stages.push({ stage: 'geocode', elapsedMs: Date.now() - t2 });
      plan.geoAudit = {
        center,
        radiusKm: CITY_RADIUS_KM,
        modelGiven: far.checked,
        rejected: far.rejected,
        geocoded: filled.filled,
        attempted: filled.attempted,
        skipped: filled.skipped,
        provider: amapKey ? 'amap+nominatim' : 'nominatim',
      };
    }

    // 把本次（或复用的）实时数据挂到 plan 上，供「复用研究」时一并带走。
    plan._live = { weather, hotels, transport, attractions, spotFacts, spotFactMisses, spotFactSummary: await factSummaryPromise };
    plan._searchedAt = searchedAt;
    plan.photos = await photosPromise;

    const liveSources = [];
    // 汇总检索命中的域名，前端用来展示「这些信息具体来自哪里」
    const hitCount = (groups) => (groups || []).reduce((n, g) => n + (g.results?.length || 0), 0);
    const hostSummary = (groups, n = 3) => [...new Set((groups || [])
      .flatMap((g) => g.results || [])
      .map((r) => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; } })
      .filter(Boolean))].slice(0, n).join('、');
    if (weather?.days?.length) {
      liveSources.push({
        label: `${weather.kind === 'climate' ? '气候参考' : '实时天气'} · ${weather.source}`,
        type: 'weather',
        status: 'checked',
        retrievedAt: searchedAt,
        note: `按出行日期查询 ${weather.place} 逐日天气：${weather.days.map((d) => `${d.date} ${d.summary} ${d.tmin ?? '?'}~${d.tmax ?? '?'}℃`).join('；')}。来源：${weather.source}。`,
      });
    }
    if (attractions?.length) {
      liveSources.push({
        label: `景点票价 / 开放搜索（${searchLabel} · ${hitCount(attractions)} 条）`,
        type: 'attraction',
        status: 'checked',
        retrievedAt: searchedAt,
        note: `来源域名：${hostSummary(attractions) || '公开网页'}。具体票价与开放时间仍请以官方页面复核（待核实）。`,
      });
    }
    const factKeys = Object.keys(spotFacts || {});
    if (factKeys.length) {
      const factHosts = [...new Set(factKeys
        .flatMap((k) => (spotFacts[k]?.results || []).map((r) => r.site || hostLabel(r.url)))
        .filter(Boolean))].slice(0, 4).join('、');
      liveSources.push({
        label: `逐景点票价 / 开放时间（${searchLabel} · ${factKeys.length} 个景点）`,
        type: 'attraction',
        status: 'checked',
        retrievedAt: searchedAt,
        note: `按景点名逐个检索：${factKeys.join('、')}。来源域名：${factHosts || '公开网页'}。票价为检索当时的公开信息，出行前仍请以官方页面复核。`,
      });
    }
    if (hotels?.length) {
      liveSources.push({
        label: `酒店评价搜索（${searchLabel} · ${hitCount(hotels)} 条）`,
        type: 'hotel',
        status: 'checked',
        retrievedAt: searchedAt,
        note: `来源域名：${hostSummary(hotels) || '公开网页'}。房态与可订性请在预订平台确认（待核实）。`,
      });
    }
    if (transport?.length) {
      liveSources.push({
        label: `地铁 / 公交公告搜索（${searchLabel} · ${hitCount(transport)} 条）`,
        type: 'transport',
        status: 'checked',
        retrievedAt: searchedAt,
        note: `来源域名：${hostSummary(transport) || '公开网页'}。实时通行状况以官方为准。`,
      });
    }

    plan.sources = [
      {
        label: '寰途本地知识库（目的地与方法）',
        type: 'local',
        status: 'static',
        retrievedAt: knowledgeLoadedAt,
        note: '编写于 2026-10 的静态整理稿，非实时数据',
      },
      {
        label: `模型生成内容 · ${model}`,
        type: 'model',
        status: 'unverified',
        retrievedAt: plan.meta.generatedAt,
        note: `由模型分 ${stages.length} 步生成（研究 + 行程），未经实时核验`,
      },
      ...plan.sources,
      ...liveSources,
      {
        label: '地图 / 酒店实时库存 / 班次余票',
        type: 'adapter',
        status: (adapters.maps || adapters.hotels) ? 'partial' : 'not_connected',
        retrievedAt: null,
        note: liveSources.length
          ? `已接入：${liveSources.map((s) => ({ weather: '天气', attraction: '景点', hotel: '酒店', transport: '交通' }[s.type] || s.type)).join('、')}；地图、酒店实时库存、班次余票仍未接入，房价/房态请以预订平台为准。`
          : '未接入，因此房价、营业时间与班次均为“待核实”',
      },
    ];
    if (liveSources.length) {
      const kinds = liveSources
        .map((s) => ({ weather: '天气', attraction: '景点', hotel: '酒店', transport: '交通' }[s.type] || s.type))
        .join('、');
      const weatherPart = weather
        ? (weather.kind === 'climate'
          ? '天气为去年同期实测（气候参考，非预报）'
          : '天气来自 Open-Meteo 数值预报')
        : '天气未能获取';
      const msg = `已接入实时数据（${kinds}）：${weatherPart}，景点/酒店/交通来自实时搜索（${searchLabel}）；具体数值仍请以官方页面复核。`;
      if (plan.warnings[0]?.includes('未接入实时搜索')) plan.warnings[0] = msg;
    }
    if (change && oldPlan) plan = mergeConfirmed(oldPlan, plan);

    // 知识库账本：这次命中多少条、省了多少次网络检索
    const libSummary = libUsage.summary({ reused: reuseResearch });
    plan.library = libSummary;
    if (libSummary.hits) {
      const newest = libUsage.hits
        .map((h) => h.ageDays)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)[0];
      plan.sources = [
        ...plan.sources,
        {
          label: `本地知识库复用 · ${libSummary.hits} 条`,
          type: 'local',
          status: 'static',
          retrievedAt: new Date().toISOString(),
          note: `这次有 ${libSummary.hits} 条信息直接取自知识库（最新的一条 ${newest ?? '?'} 天前抓取，其中 ${libSummary.stale} 条已过期），因此省下同样次数的联网检索。过期条目会在下次生成时自动重搜并覆盖。`,
        },
      ];
    }
    // 定稿的结构化事实回写，下次同城同景点不用从零再推
    if (!reuseResearch) {
      try {
        const saved = savePlanDigest({ input, plan, city: libSummary.city });
        if (saved) logger?.info?.(`知识库已收录 ${saved} 条结构化事实（${libSummary.city}）`);
      } catch (e) {
        logger?.warn?.(`结构化事实回写失败：${e.message}`);
      }
    }

    s.plans.set(planId, plan);
    s.latest = planId;
    while (s.plans.size > 6) s.plans.delete(s.plans.keys().next().value);

    return { plan, stages, research, researchSavedAt, researchReused: reuseResearch, model, protocol, fetchMs };
  }

  /* ---------------- 后台任务 ---------------- */

  const jobControllers = new Map();

  function activeJob(s) {
    return queue.listBySession(s.id).find((job) => !TERMINAL_STATUS.has(job.status)) || null;
  }

  function publicJob(job) {
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : null;
    const elapsedMs = job.finishedAt
      ? (job.timing?.totalMs ?? Math.max(0, Date.parse(job.finishedAt) - (startedAt || Date.parse(job.createdAt))))
      : (startedAt ? Math.max(0, Date.now() - startedAt) : 0);
    return {
      id: job.id,
      status: job.status,
      stage: job.stage || job.status,
      stageLabel: STAGE_LABEL[job.status] || job.status,
      mode: job.change ? 'replan' : 'initial',
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      elapsedMs,
      cancellable: !TERMINAL_STATUS.has(job.status),
      hasResult: job.status === JOB_STATUS.COMPLETED,
      planId: job.planId || null,
      trip: {
        origin: job.trip?.origin || '',
        destination: job.trip?.destination || '',
        startDate: job.trip?.startDate || '',
        days: job.trip?.days || 0,
        travelers: job.trip?.travelers || 0,
      },
      timing: job.timing || null,
      research: job.researchMeta || null,
      // 研究一完成就先给一版概览，用户在等待编排的几分钟里能看到成果
      preview: job.preview || null,
      error: job.error || null,
      pollAfterMs: 2000,
    };
  }

  function createJob(s, payload) {
    const running = activeJob(s);
    if (running) {
      fail(`已有一个规划任务在生成中（${STAGE_LABEL[running.status] || running.status}），请等它完成或先取消。`, 409);
    }
    const job = queue.create({
      id: randomBytes(6).toString('hex'),
      sessionId: s.id,
      status: JOB_STATUS.PENDING,
      stage: 'pending',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      trip: payload.input,
      change: payload.change || '',
      refreshInsights: Boolean(payload.refreshInsights),
      basePlanId: payload.basePlan?.planId || null,
      planId: null,
      error: null,
      timing: null,
      researchMeta: null,
    });
    const controller = new AbortController();
    jobControllers.set(job.id, controller);
    // 不 await：请求要立刻返回 jobId，任务在后台跑
    runJob(s, job, payload, controller).catch((error) => {
      logger.error('后台任务异常：', error?.message);
    });
    return job;
  }

  async function runJob(s, job, payload, controller) {
    const started = Date.now();
    queue.update(job.id, {
      status: JOB_STATUS.RESEARCHING,
      stage: 'researching',
      startedAt: new Date().toISOString(),
    });
    try {
      const result = await runPlanning({
        s,
        input: payload.input,
        change: payload.change,
        refreshInsights: payload.refreshInsights,
        basePlan: payload.basePlan,
        signal: controller.signal,
        onStage: (stage) => {
          if (job.cancelRequested) return;
          queue.update(job.id, { status: stage, stage });
        },
        onPreview: (preview) => {
          if (job.cancelRequested) return;
          queue.update(job.id, { preview });
        },
      });
      const finishedAt = new Date().toISOString();
      queue.update(job.id, {
        status: JOB_STATUS.COMPLETED,
        stage: 'completed',
        finishedAt,
        planId: result.plan.planId,
        timing: {
          totalMs: Date.now() - started,
          researchMs: result.stages.find((x) => x.stage === 'research')?.elapsedMs ?? 0,
          itineraryMs: result.stages.find((x) => x.stage === 'itinerary')?.elapsedMs ?? 0,
          fetchMs: result.fetchMs || 0,
          researchReused: result.researchReused,
        },
        researchMeta: {
          savedAt: result.researchSavedAt,
          reused: result.researchReused,
          attractions: result.research?.insights?.attractions?.length || 0,
          hotels: result.research?.hotels?.length || 0,
          model: result.model,
        },
      });
      s.researchCache = { at: new Date().toISOString(), input: payload.input, research: result.research };
    } catch (error) {
      const cancelled = job.cancelRequested || error?.code === 'cancelled' || error?.status === 499;
      queue.update(job.id, {
        status: cancelled ? JOB_STATUS.CANCELLED : JOB_STATUS.FAILED,
        stage: cancelled ? 'cancelled' : 'failed',
        finishedAt: new Date().toISOString(),
        error: cancelled
          ? { message: '任务已按你的要求取消。', code: 'cancelled', status: 499, at: new Date().toISOString() }
          : {
            message: error?.status ? error.message : '生成过程中发生错误，请重试。',
            code: error?.code || 'job_failed',
            status: error?.status || 500,
            at: new Date().toISOString(),
          },
        timing: { totalMs: Date.now() - started },
      });
      if (!cancelled) logger.error('任务失败：', error?.message);
    } finally {
      jobControllers.delete(job.id);
    }
  }

  async function waitForJob(job, timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (TERMINAL_STATUS.has(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return job;
  }

  function cancelJob(job) {
    queue.update(job.id, { cancelRequested: true });
    const controller = jobControllers.get(job.id);
    if (controller) controller.abort();
    if (job.status === JOB_STATUS.PENDING) {
      queue.update(job.id, {
        status: JOB_STATUS.CANCELLED,
        stage: 'cancelled',
        finishedAt: new Date().toISOString(),
        error: { message: '任务在开始前被取消。', code: 'cancelled', status: 499, at: new Date().toISOString() },
        timing: { totalMs: 0 },
      });
      jobControllers.delete(job.id);
    }
    return queue.get(job.id) || job;
  }

  function getJob(s, jobId) {
    const job = queue.get(jobId);
    // 会话隔离：别人的任务一律当作不存在
    if (!job || job.sessionId !== s.id) fail('找不到这个任务。', 404);
    return job;
  }

  function getPlan(s, planId) {
    const id = typeof planId === 'string' && s.plans.has(planId) ? planId : s.latest;
    if (!id || !s.plans.has(id)) fail('找不到行程记录，请先生成方案。', 404);
    return s.plans.get(id);
  }

  function calendarStatus(s) {
    return {
      google: {
        state: oauth.google ? 'needs_authorization' : 'needs_authorization',
        label: '尚未授权',
        detail: oauth.google
          ? '已配置 OAuth 客户端，仍需用户点击授权后才能写入。'
          : '未配置 Google OAuth 客户端，无法直连写入。可用 .ics 导入或创建链接。',
        canSync: false,
      },
      apple: {
        state: 'unsupported_direct',
        label: '不支持直连 · 可用 .ics 导入',
        detail: 'Apple Calendar 通过 .ics 文件导入系统日历，不提供网页端 OAuth 写入。',
        canSync: false,
      },
      system: {
        state: 'ics_available',
        label: 'ICS 可导入',
        detail: '下载 .ics 后在手机上打开即可导入系统日历，时间按设备本地时区显示。',
        canSync: false,
      },
      ics: { state: 'available', label: '可导出' },
      lastSyncedAt: s.calendar.lastSyncedAt || null,
    };
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      // 允许 https 图片：搜索结果旁的站点图标来自各家搜索 API 的 CDN
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '));

    try {
      /* ---------- Host 校验：只认白名单（含显式配置的通配后缀），不无条件放开 ---------- */
      const hostHeader = String(req.headers.host || '');
      const hostName = stripHostPort(hostHeader);
      let hostOk = hostIsAllowed(hostName);
      if (!hostOk) {
        // 只有当请求来自明确配置的可信反向代理时，才看 X-Forwarded-Host
        const forwarded = req.headers['x-forwarded-host'];
        if (forwarded && isTrustedProxy(req.socket?.remoteAddress)) {
          const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
          hostOk = hostIsAllowed(first);
        }
      }
      if (!hostOk) {
        fail(
          publicMode
            ? `当前访问域名不在允许列表内。请把域名写进 HUANTU_PUBLIC_HOST 后重启（Host: ${sanitizeText(hostName, 80) || '空'}）。`
            : '寰途本机版仅允许通过 127.0.0.1 或 localhost 访问。',
          403,
        );
      }

      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          const parsed = new URL(origin);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail('不允许的请求来源。', 403);
          originHost = stripHostPort(parsed.host);
        } catch {
          fail('不允许的请求来源。', 403);
        }
        if (!hostIsAllowed(originHost)) fail('不允许跨站请求。', 403);
      }

      const url = new URL(req.url, 'http://' + (hostHeader || '127.0.0.1'));
      if (req.method !== 'GET' && req.headers['x-huantu-csrf'] !== csrf) {
        fail('页面校验已失效，请刷新页面。', 403);
      }

      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/api/health') {
          return json(res, 200, publicMode
            ? { ok: true, service: 'huantu', public: true }
            : {
              ok: true,
              service: 'huantu',
              configured: Boolean(config.apiKey && config.model),
              verified: Boolean(verified),
              model: config.model || null,
              protocol: config.protocol,
            });
        }

        // 公开模式的入口：告诉前端是要访问码，还是已经放行
        if (req.method === 'GET' && url.pathname === '/api/public') {
          const authorized = isAuthorized(req);
          return json(res, 200, {
            public: publicMode,
            authorized,
            noCode: publicMode && publicNoCode,
            mode: publicMode ? 'public' : 'local',
            csrf,
            ready: Boolean(verified) && Boolean(config.apiKey && config.model),
            limits: publicMode
              ? {
                callLimit: maxCallsPerSession,
                ipDailyLimit: ipDailyCalls || null,
                accessTtlSeconds: publicNoCode ? 0 : Math.floor(accessTokenTtlMs / 1000),
              }
              : null,
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/session') {
          if (!publicMode) fail('本机模式不需要访问码。', 400);
          if (publicNoCode) fail('当前实例没有启用访问码（HUANTU_PUBLIC_NO_CODE=1），不需要登录。', 400);
          const failState = failureState(req);
          if (failState.count >= ACCESS_FAIL_LIMIT) {
            const wait = Math.ceil((failState.resetAt - Date.now()) / 60000);
            fail(`访问码尝试次数过多，请 ${wait} 分钟后再试。`, 429);
          }
          const body = await readBody(req);
          const candidate = String(body.code || '').slice(0, 200);
          if (!candidate || !sameCode(candidate, accessCode)) {
            failState.count += 1;
            fail('访问码不正确。', 401);
          }
          accessFailures.delete(clientKey(req));
          issueAccessCookie(req, res);
          return json(res, 200, {
            authorized: true,
            mode: 'public',
            expiresIn: Math.floor(accessTokenTtlMs / 1000),
            message: '已授权。访问码不会保存在浏览器存储里，只保留一个短期的 HttpOnly Cookie。',
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/session/logout') {
          clearAccessCookie(res);
          return json(res, 200, { authorized: false });
        }

        // 未授权时，除了上面三个入口，其它 API 一律 401
        if (publicMode && !isAuthorized(req)) {
          return json(res, 401, {
            error: '需要访问码。请先在本页输入访问码。',
            code: 'access_code_required',
            public: true,
          });
        }

        // 公开模式下访客只能建任务、看进度、看结果
        if (publicMode && url.pathname.startsWith('/api/')) {
          const key = `${req.method} ${url.pathname}`;
          const jobAction = /^\/api\/jobs\/[a-f0-9]{12}(\/(result|cancel))?$/.test(url.pathname);
          const allowed = PUBLIC_ALLOWED.has(key) || (jobAction && (req.method === 'GET' || req.method === 'POST'));
          if (!allowed) {
            return json(res, 403, {
              error: '公开试用模式只开放「创建行程、查看进度、查看结果」；模型设置与日历写入仅限本机使用。',
              code: 'not_available_in_public_mode',
            });
          }
        }

        const s = session(req, res);

        /* ---------------- 搜索知识库 ---------------- */
        // 访客可读（都是公开网页信息），刷新/删除只给授权用户，避免把别人的缓存清掉。
        if (req.method === 'GET' && url.pathname === '/api/library') {
          if (!library) {
            return json(res, 200, { enabled: false, summary: null, cities: [], items: [] });
          }
          const city = sanitizeText(url.searchParams.get('city') || '', 40);
          const kind = sanitizeText(url.searchParams.get('kind') || '', 20);
          const summary = library.summary();
          const cities = library.cities();
          if (!city) return json(res, 200, { enabled: true, summary, cities, items: [] });

          const items = library.list({ city, kind }).map((e) => {
            let preview = '';
            if (e.kind === 'photo') preview = e.data?.image || '';
            else if (e.kind === 'spot' || e.kind === 'search') {
              const rows = e.kind === 'search'
                ? (e.data?.groups || []).flatMap((g) => g.results || [])
                : (e.data?.results || []);
              preview = rows.length ? `${rows.length} 条 · ${rows[0]?.title || ''}` : '无结果';
            } else if (e.kind === 'digest') {
              preview = [e.data?.ticket, e.data?.openingHours, e.data?.priceRange].filter(Boolean).join(' / ');
            }
            return {
              kind: e.kind,
              key: e.key,
              city: e.city,
              query: e.query,
              provider: e.provider,
              state: e.state,
              ageDays: e.ageDays,
              updatedAt: e.updatedAt,
              hits: e.hits,
              preview,
            };
          });
          return json(res, 200, { enabled: true, summary, cities, city, items });
        }

        // 标废：下次生成时重搜。带 key 只废一条，不带 key 废整城/整类。
        if (req.method === 'POST' && url.pathname === '/api/library/refresh') {
          if (!library) return json(res, 409, { error: '知识库未启用。' });
          const body = await readBody(req);
          const city = sanitizeText(body.city || '', 40);
          if (!city) fail('需要指明城市。');
          const kind = sanitizeText(body.kind || '', 20);
          const key = sanitizeText(body.key || '', 200);
          if (key && kind) {
            const ok = library.expire({ city, kind, key });
            await library.flush();
            return json(res, 200, { ok, expired: ok ? 1 : 0 });
          }
          let expired = 0;
          for (const e of library.list({ city, kind })) {
            if (library.expire({ city: e.city, kind: e.kind, key: e.key })) expired += 1;
          }
          await library.flush();
          logger?.info?.(`知识库手动作废 ${expired} 条（${city}${kind ? ` / ${kind}` : ''}）`);
          return json(res, 200, { ok: true, expired });
        }

        if (req.method === 'DELETE' && url.pathname === '/api/library/item') {
          if (!library) return json(res, 409, { error: '知识库未启用。' });
          const body = await readBody(req);
          const city = sanitizeText(body.city || '', 40);
          const kind = sanitizeText(body.kind || '', 20);
          const key = sanitizeText(body.key || '', 200);
          if (!city || !kind || !key) fail('需要 city、kind、key 三个参数。');
          const ok = library.forget({ city, kind, key });
          await library.flush();
          return json(res, 200, { ok });
        }

        if (req.method === 'GET' && url.pathname === '/api/state') {
          if (publicMode) return json(res, 200, publicState(s));
          return json(res, 200, {
            csrf,
            configured: Boolean(config.apiKey && config.model),
            configSaved: Boolean(configSavedAt),
            configSavedAt,
            verified: Boolean(verified),
            verification: verified,
            baseUrl: config.baseUrl,
            model: config.model,
            protocol: config.protocol,
            role: config.role,
            lastError,
            adapters: {
              search: adapters.search ? 'configured' : 'not_connected',
              maps: adapters.maps ? 'configured' : 'not_connected',
              hotels: adapters.hotels ? 'configured' : 'not_connected',
              weather: adapters.weather ? 'configured' : 'not_connected',
            },
            calendar: calendarStatus(s),
            hasPlan: Boolean(s.latest),
            planUpdatedAt: s.latest ? s.plans.get(s.latest).meta.generatedAt : null,
            calls: s.calls,
            callLimit: maxCallsPerSession,
            jobs: {
              queue: queue.kind,
              active: (() => {
                const running = activeJob(s);
                return running ? publicJob(running) : null;
              })(),
            },
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/config') {
          const b = await readBody(req);
          let u;
          try {
            u = new URL(String(b.baseUrl || ''));
          } catch {
            fail('请输入有效的 API 基础地址，例如 https://服务商域名/v1。');
          }
          const isLocal = ['127.0.0.1', 'localhost'].includes(u.hostname);
          if (u.protocol !== 'https:' && !(allowLocalUpstream && isLocal && u.protocol === 'http:')) {
            fail('模型服务地址必须使用 HTTPS（本机测试地址除外）。');
          }
          if (u.username || u.password || u.search || u.hash) {
            fail('地址中不能包含账号、密码、查询参数或片段。');
          }
          if (/\/(chat\/completions|responses)\/?$/.test(u.pathname)) {
            fail('请填写到版本路径（如 /v1），不要带 /chat/completions 或 /responses。');
          }
          const model = sanitizeText(b.model, 150);
          if (!model) fail('请填写服务商提供的模型 ID。');
          const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
          if (apiKey.length < 5 || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
            fail('请输入有效的 API 密钥（5–4096 字符，不能含换行）。');
          }
          if (b.protocol !== undefined && !PROTOCOLS.has(b.protocol)) fail('不支持此接口类型。');
          config = {
            baseUrl: u.toString().replace(/\/+$/, ''),
            model,
            apiKey,
            protocol: b.protocol || config.protocol,
            role: b.role === 'developer' ? 'developer' : 'system',
          };
          await saveNonSecretConfig();
          configRevision += 1;
          verified = null;
          lastError = null;
          return json(res, 200, {
            configured: true,
            verified: false,
            baseUrl: config.baseUrl,
            model: config.model,
            protocol: config.protocol,
            note: '配置已保存（密钥仅在内存）。请点击测试连接确认真实可用。',
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/test') {
          await readBody(req);
          const r = await modelCall([
            { role: 'user', content: '这是连通性测试，不含任何个人或旅行数据。请只回复四个字：连接成功' },
          ]);
          verified = { model: r.model, protocol: r.protocol, at: new Date().toISOString(), elapsedMs: r.elapsedMs };
          return json(res, 200, { ...verified, reply: r.text.slice(0, 200), source: 'model' });
        }

        if (req.method === 'DELETE' && url.pathname === '/api/config') {
          config.apiKey = '';
          verified = null;
          lastError = null;
          configRevision += 1;
          return json(res, 200, { ok: true, configured: false });
        }

        /* ---------- 异步任务 ---------- */

        if (req.method === 'POST' && url.pathname === '/api/jobs') {
          const b = await readBody(req);
          let payload;
          if (b.change !== undefined || b.basePlanId || b.planId) {
            // 重新规划任务：复用已有方案，只重排行程（或按需重做研究）
            const base = getPlan(s, b.basePlanId || b.planId);
            const change = sanitizeText(b.change, 500, { multiline: true });
            if (!change) fail('请说明要如何调整行程。');
            const input = validateTripInput({ ...base.input, ...(b.trip || {}) });
            if (Array.isArray(b.lockedDays)) {
              for (const d of base.days) d.locked = b.lockedDays.includes(d.day);
            }
            if (Array.isArray(b.lockedItems)) {
              for (const d of base.days) {
                for (const it of d.items) it.locked = b.lockedItems.includes(`${d.day}-${it.index}`);
              }
            }
            payload = {
              input,
              change,
              refreshInsights: b.refreshInsights === true || /住宿|酒店|民宿|预算|房价|片区|换住/.test(change),
              basePlan: base,
            };
          } else {
            payload = { input: validateTripInput(b.trip || b) };
          }
          const job = createJob(s, payload);
          return json(res, 202, {
            job: publicJob(job),
            jobId: job.id,
            status: job.status,
            links: {
              self: `/api/jobs/${job.id}`,
              result: `/api/jobs/${job.id}/result`,
              cancel: `/api/jobs/${job.id}/cancel`,
            },
            message: '任务已创建，正在后台生成。请每 2 秒轮询 /api/jobs/:id。',
          });
        }

        if (req.method === 'GET' && url.pathname === '/api/jobs') {
          const list = queue.listBySession(s.id)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, 20)
            .map(publicJob);
          return json(res, 200, { jobs: list, queue: queue.kind });
        }

        const jobRoute = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{12})(?:\/(result|cancel))?$/);
        if (jobRoute) {
          const [, jobId, action] = jobRoute;
          if (action === 'cancel') {
            if (req.method !== 'POST') fail('取消任务请使用 POST。', 405);
            await readBody(req).catch(() => ({}));
            const job = cancelJob(getJob(s, jobId));
            return json(res, 200, { job: publicJob(job), message: job.status === JOB_STATUS.CANCELLED ? '任务已取消。' : '已请求取消，正在中止模型请求。' });
          }
          if (req.method !== 'GET') fail('该接口只支持 GET。', 405);
          const job = getJob(s, jobId);
          if (action === 'result') {
            if (job.status === JOB_STATUS.COMPLETED) {
              const plan = s.plans.get(job.planId);
              if (!plan) fail('任务已完成，但方案已被清除，请重新规划。', 410);
              return json(res, 200, { job: publicJob(job), plan });
            }
            if (job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.CANCELLED) {
              return json(res, 409, { job: publicJob(job), error: job.error?.message || '任务没有可用的结果。' });
            }
            return json(res, 409, { job: publicJob(job), error: '任务尚未完成，请继续轮询状态。' });
          }
          return json(res, 200, { job: publicJob(job) });
        }

        /* ---------- 兼容接口：仍然同步返回，但最多等 planWaitMs ---------- */

        if (req.method === 'POST' && url.pathname === '/api/plan') {
          const b = await readBody(req);
          const input = validateTripInput(b.trip || b);
          const job = createJob(s, { input });
          await waitForJob(job, Number(b.waitMs) || planWaitMs);
          if (job.status === JOB_STATUS.COMPLETED) {
            return json(res, 200, { plan: s.plans.get(job.planId), job: publicJob(job) });
          }
          if (job.status === JOB_STATUS.FAILED) {
            return json(res, job.error?.status || 502, { error: job.error?.message || '生成失败。', job: publicJob(job) });
          }
          if (job.status === JOB_STATUS.CANCELLED) {
            return json(res, 499, { error: '任务已取消。', job: publicJob(job) });
          }
          return json(res, 202, {
            job: publicJob(job),
            jobId: job.id,
            message: `任务已创建但尚未完成（已等待 ${Math.round(planWaitMs / 1000)} 秒）。请轮询 /api/jobs/${job.id}。`,
            links: { self: `/api/jobs/${job.id}`, result: `/api/jobs/${job.id}/result` },
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/replan') {
          const b = await readBody(req);
          const base = getPlan(s, b.planId);
          const change = sanitizeText(b.change, 500, { multiline: true });
          if (!change) fail('请说明要如何调整行程。');
          const input = validateTripInput({ ...base.input, ...(b.trip || {}) });
          if (Array.isArray(b.lockedDays)) {
            for (const d of base.days) d.locked = b.lockedDays.includes(d.day);
          }
          if (Array.isArray(b.lockedItems)) {
            for (const d of base.days) {
              for (const it of d.items) it.locked = b.lockedItems.includes(`${d.day}-${it.index}`);
            }
          }
          const refreshInsights = b.refreshInsights === true || /住宿|酒店|民宿|预算|房价|片区|换住/.test(change);
          const job = createJob(s, { input, change, refreshInsights, basePlan: base });
          await waitForJob(job, Number(b.waitMs) || planWaitMs);
          if (job.status === JOB_STATUS.COMPLETED) {
            return json(res, 200, { plan: s.plans.get(job.planId), job: publicJob(job) });
          }
          if (job.status === JOB_STATUS.FAILED) {
            return json(res, job.error?.status || 502, { error: job.error?.message || '重新规划失败。', job: publicJob(job) });
          }
          if (job.status === JOB_STATUS.CANCELLED) {
            return json(res, 499, { error: '任务已取消。', job: publicJob(job) });
          }
          return json(res, 202, {
            job: publicJob(job),
            jobId: job.id,
            message: '重新规划已转入后台，请轮询任务状态。',
            links: { self: `/api/jobs/${job.id}`, result: `/api/jobs/${job.id}/result` },
          });
        }

        if (req.method === 'GET' && url.pathname === '/api/plan/latest') {
          if (!s.latest) return json(res, 200, { plan: null });
          return json(res, 200, { plan: s.plans.get(s.latest) });
        }

        if (req.method === 'DELETE' && url.pathname === '/api/plan') {
          const running = activeJob(s);
          if (running) cancelJob(running);
          for (const job of queue.listBySession(s.id)) queue.delete(job.id);
          s.plans.clear();
          s.latest = null;
          s.calendar = {};
          s.researchCache = null;
          return json(res, 200, { ok: true, cleared: true });
        }

        if (req.method === 'POST' && url.pathname === '/api/calendar/status') {
          await readBody(req).catch(() => ({}));
          return json(res, 200, calendarStatus(s));
        }

        if (req.method === 'POST' && url.pathname === '/api/calendar/ics') {
          const b = await readBody(req);
          const plan = getPlan(s, b.planId);
          const text = buildIcs(plan, { planId: plan.planId });
          res.writeHead(200, {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="huantu-${plan.planId}.ics"`,
            'Cache-Control': 'no-store',
          });
          return res.end(Buffer.from(text, 'utf8'));
        }

        if (req.method === 'POST' && url.pathname === '/api/calendar/google') {
          const b = await readBody(req);
          const plan = getPlan(s, b.planId);
          const links = buildGoogleLinks(plan, { planId: plan.planId });
          return json(res, 200, {
            ...links,
            authorized: false,
            note: '这是 Google Calendar 的“创建事件”链接，需要你本人登录并在 Google 页面确认；寰途未获得授权，也不会自动写入。',
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/calendar/connect') {
          const b = await readBody(req);
          const provider = String(b.provider || '');
          if (!['google', 'apple', 'system'].includes(provider)) fail('不支持的日历类型。');
          if (provider === 'apple') {
            return json(res, 200, {
              connected: false,
              state: 'unsupported_direct',
              message: 'Apple Calendar 不支持网页端 OAuth 直连写入。请下载 .ics 后在 iPhone / Mac 上打开导入。',
            });
          }
          if (provider === 'system') {
            return json(res, 200, {
              connected: false,
              state: 'ics_available',
              message: '系统日历请通过 .ics 导入，浏览器无法直接写入本机日历。',
            });
          }
          if (!oauth.google) {
            return json(res, 501, {
              connected: false,
              state: 'needs_authorization',
              message: '尚未配置 Google OAuth 客户端（HUANTU_GOOGLE_CLIENT_ID / HUANTU_GOOGLE_CLIENT_SECRET）。当前无法授权直连，可先使用 .ics 导入。',
            });
          }
          return json(res, 501, {
            connected: false,
            state: 'needs_authorization',
            message: 'OAuth 客户端已配置，但授权回调尚未在本机版启用。请使用 .ics 导入；直连写入仍需单独实现并逐次确认。',
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/calendar/delete') {
          const b = await readBody(req);
          if (b.confirm !== true) {
            fail('删除日历事件需要你明确确认：请勾选确认后重试。寰途不会在你未确认时改动任何日历。', 400);
          }
          const plan = getPlan(s, b.planId);
          return json(res, 501, {
            deleted: false,
            state: 'unsupported_direct',
            planId: plan.planId,
            message: '寰途没有获得日历写入授权，本机不持有任何已同步事件，因此没有任何事件被删除。请在你自己的日历应用中删除。',
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/visual/svg') {
          const b = await readBody(req);
          const plan = getPlan(s, b.planId);
          const svg = buildRouteSvg(plan);
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          return res.end(Buffer.from(svg, 'utf8'));
        }

        if (req.method === 'POST' && url.pathname === '/api/visual/map') {
          const b = await readBody(req);
          const plan = getPlan(s, b.planId);
          return json(res, 200, buildMapPayload(plan));
        }

        // 导入寰途自己导出的 JSON（备份恢复 / 换机迁移）。不改写内容，只做清洗与重新标注。
        if (req.method === 'POST' && url.pathname === '/api/plan/import') {
          const b = await readBody(req);
          const raw = b.plan || b;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('导入内容不是一个行程对象。');
          const input = validateTripInput(raw.input || {});
          const planId = randomBytes(6).toString('hex');
          const plan = normalizePlan(raw, input, { planId, model: '导入的本地文件', protocol: null });
          plan.meta.engine = 'import';
          plan.meta.mode = 'import';
          plan.meta.importedAt = new Date().toISOString();
          const originalAt = sanitizeText(raw.meta?.generatedAt, 40);
          if (originalAt && !Number.isNaN(Date.parse(originalAt))) {
            plan.meta.generatedAt = new Date(originalAt).toISOString();
          }
          plan.meta.sourceFileGeneratedAt = originalAt || null;
          plan.sources = [
            {
              label: '导入的行程文件',
              type: 'model',
              status: 'unverified',
              retrievedAt: plan.meta.importedAt,
              note: '由你导入的 JSON 还原，模型没有重新生成；时效信息仍需核实',
            },
            ...plan.sources,
            {
              label: '实时搜索 / 地图 / 酒店 / 天气接口（导入时未重新调用）',
              type: 'adapter',
              status: 'unverified',
              retrievedAt: null,
              note: '导入不会重新调用实时接口；原文件中的时效信息必须重新核实',
            },
          ];
          plan.warnings.unshift('这是一份导入还原的行程，本次没有调用模型；出行前请再核对官方信息。');
          s.plans.set(planId, plan);
          s.latest = planId;
          return json(res, 200, { plan, imported: true });
        }

        if (req.method === 'POST' && url.pathname === '/api/plan/export') {
          const b = await readBody(req);
          const plan = getPlan(s, b.planId);
          return json(res, 200, {
            exportedAt: new Date().toISOString(),
            disclaimer: '本文件为寰途生成的行程数据，时效信息未核验。',
            plan,
          });
        }

        return fail('接口不存在。', 404);
      }

      if (req.method !== 'GET') return fail('方法不被支持。', 405);
      const asset = ASSETS[url.pathname];
      if (!asset) return fail('页面不存在。', 404);
      const data = await readFile(path.join(PUBLIC_DIR, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch (error) {
      if (!res.headersSent) {
        const status = error?.status || 500;
        const message = error?.status ? error.message : '本机服务发生错误，请重试。';
        if (!error?.status) logger.error('寰途服务错误：', error?.message);
        json(res, status, { error: message });
      } else {
        res.end();
      }
    }
  });

  const cleanup = setInterval(() => {
    for (const [id, s] of sessions) {
      const running = activeJob(s);
      if (!running && Date.now() - s.lastSeen > 90 * 60 * 1000) {
        for (const job of queue.listBySession(id)) queue.delete(job.id);
        sessions.delete(id);
      }
    }
    queue.prune?.();
    for (const [token, expiresAt] of accessTokens) {
      if (Date.now() > expiresAt) accessTokens.delete(token);
    }
    for (const [key, entry] of accessFailures) {
      if (Date.now() > entry.resetAt) accessFailures.delete(key);
    }
    for (const [key, entry] of ipQuotas) {
      if (Date.now() > entry.resetAt) ipQuotas.delete(key);
    }
  }, 60_000);
  cleanup.unref();
  server.on('close', () => {
    clearInterval(cleanup);
    // 关闭前把内存里没来得及落盘的知识库条目写出去
    library?.flush?.().catch(() => {});
  });
  // 让启动脚本能在 SIGTERM 时主动 flush（systemctl restart 会掉一次）
  server.huantuLibrary = library;

  if (config.apiKey && config.model && process.env.HUANTU_AUTO_VERIFY === '1') {
    try {
      const r = await modelCall([{ role: 'user', content: '这是连通性测试，请只回复：连接成功' }]);
      verified = { model: r.model, protocol: r.protocol, at: new Date().toISOString(), elapsedMs: r.elapsedMs };
    } catch (error) {
      logger.error('模型自动验证失败：', error.message);
    }
  }

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.HUANTU_PORT || 8788);
  const bindHost = resolveBindHost(process.env.HUANTU_BIND_HOST);
  const publicMode = process.env.HUANTU_PUBLIC === '1';
  const publicHost = normalizePublicHost(process.env.HUANTU_PUBLIC_HOST || '');
  // HUANTU_ALLOW_LOCAL_UPSTREAM=1 仅用于本机联调（允许 http://127.0.0.1 的模型地址）
  const server = await createApp({ allowLocalUpstream: process.env.HUANTU_ALLOW_LOCAL_UPSTREAM === '1' });
  // systemctl restart / Ctrl+C 时先把知识库落盘，别丢最后几分钟的收录
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      Promise.resolve(server.huantuLibrary?.flush?.())
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }
  server.listen(port, bindHost, () => {
    const localUrl = `http://127.0.0.1:${port}`;
    console.log('');
    console.log(`寰途已启动：${localUrl}（监听 ${bindHost}:${port}）`);
    if (bindHost !== '127.0.0.1') {
      console.log(`  注意：正在监听 ${bindHost}，局域网/公网可直接访问该端口。`);
    }
    if (publicMode) {
      const noCode = process.env.HUANTU_PUBLIC_NO_CODE === '1';
      if (noCode) {
        console.log('  模式：公开试用（未启用访问码）');
        console.log('  任何能访问该地址的人都可以生成行程并消耗你的模型额度。');
        const quota = process.env.HUANTU_PUBLIC_IP_DAILY_CALLS || '6';
        console.log(`  止损：每 IP 每天最多 ${quota} 次模型调用；访客仍不能改模型配置、看不到密钥。`);
      } else {
        console.log('  模式：公开试用（需要访问码）');
      }
      const firstPublicHost = String(process.env.HUANTU_PUBLIC_HOST || '').split(',')[0].trim();
      console.log(`  访客地址：${firstPublicHost ? `http://${firstPublicHost}:${port}` : '尚未设置 HUANTU_PUBLIC_HOST，外部域名会被拒绝'}`);
      console.log('  建议放在 HTTPS 反向代理或隧道后面；直接暴露 http 端口是明文传输。');
    } else {
      console.log('  模式：本机使用（不校验访问码，仅允许本机 Host）');
    }
    console.log('');
  });
}
