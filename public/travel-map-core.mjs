/**
 * 寰途 · 智能规划核心逻辑（纯函数，无 DOM、无网络）
 *
 * 这个文件同时被三方使用：
 *   1. 浏览器 —— 由 travel-map.js / app.js 直接调用
 *   2. 服务端 —— server.mjs 用它把 plan 转成地图站点（保证前后端同一套规则）
 *   3. 测试 —— tests/map.test.mjs 直接 import，不需要浏览器
 *
 * 因此这里禁止出现 document / window / fetch。只在文件末尾做一次 window 挂载。
 */

/* ------------------------------------------------------------------ *
 * 一、图标体系（18 种，与《接入说明》一致）
 * ------------------------------------------------------------------ */

export const ICON_IDS = [
  'origin', 'airport', 'train', 'hotel', 'homestay', 'attraction',
  'viewpoint', 'restaurant', 'coffee', 'shopping', 'market', 'beach',
  'mountain', 'park', 'museum', 'pier', 'car', 'pin',
];

const ICON_SET = new Set(ICON_IDS);

/** 标题里出现这些词就判定为对应图标，先匹配更具体的，再退回类型默认值 */
const TITLE_HINTS = [
  [/机场|航站楼|候机/, 'airport'],
  [/火车站|高铁|动车|车站/, 'train'],
  [/民宿|客栈|院子/, 'homestay'],
  [/酒店|宾馆|饭店|住宿|入住/, 'hotel'],
  [/咖啡|咖啡馆|书店/, 'coffee'],
  [/餐厅|饭馆|餐馆|食堂|米线|火锅|烧烤|早茶/, 'restaurant'],
  [/夜市|市集|市场|菜场/, 'market'],
  [/商场|购物|免税|百货|步行街/, 'shopping'],
  [/博物馆|美术馆|展览|纪念馆|艺术馆/, 'museum'],
  [/码头|轮渡|游船/, 'pier'],
  [/海滩|沙滩|海边|海滨/, 'beach'],
  [/山顶|山上|登山|徒步|山$/, 'mountain'],
  [/公园|湿地|植物园|园林/, 'park'],
  [/观景|夜景|塔$|大桥|看台/, 'viewpoint'],
  [/返程|离开|回酒店|回程/, 'origin'],
];

const TYPE_TO_ICON = {
  景点: 'attraction',
  餐饮: 'restaurant',
  交通: 'car',
  休息: 'coffee',
  自由: 'pin',
  购物: 'shopping',
  活动: 'viewpoint',
};

/**
 * 决定一个节点用哪个图标。
 * @param {{type?:string, title?:string}} item
 * @returns {string} 18 种 id 之一
 */
export function iconIdFor(item) {
  const title = String(item?.title ?? '').trim();
  const type = String(item?.type ?? '').trim();
  // 「交通」类通常是移动本身，先看标题里有没有更具体的地点线索
  for (const [re, id] of TITLE_HINTS) {
    if (re.test(title)) return id;
  }
  if (TYPE_TO_ICON[type]) return TYPE_TO_ICON[type];
  return 'pin';
}

/** 显式传入的 id 优先，但只接受白名单内的值 */
export function coerceIconId(value) {
  const id = String(value ?? '').trim();
  return ICON_SET.has(id) ? id : '';
}

/* ------------------------------------------------------------------ *
 * 二、交通方式
 * ------------------------------------------------------------------ */

export const TRANSPORT_MODES = ['walk', 'drive', 'metro', 'bus', 'taxi'];

export const TRANSPORT_LABEL = {
  walk: '步行',
  drive: '驾车',
  metro: '地铁',
  bus: '公交',
  taxi: '打车',
};

const MODE_HINTS = [
  [/步行|走路|徒步|漫步/, 'walk'],
  [/地铁|轨交|轻轨|捷运/, 'metro'],
  [/公交|巴士|大巴|公交汽车/, 'bus'],
  [/打车|出租|滴滴|网约|专车/, 'taxi'],
  [/自驾|包车|驾车|开车|骑行|摩托|船|轮渡/, 'drive'],
];

/**
 * 从「从上一站到本站」的文字里推断交通方式。
 * 认不出来时按驾车处理，和《接入说明》的默认值一致。
 */
export function transportOf(text, fallback = 'drive') {
  const s = String(text ?? '').trim();
  if (!s) return fallback;
  for (const [re, mode] of MODE_HINTS) {
    if (re.test(s)) return mode;
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * 三、坐标与几何
 * ------------------------------------------------------------------ */

/** 合法的经纬度（拒绝 NaN、字符串、越界、以及 (0,0) 这种空值占位） */
export function isValidCoord(lat, lng) {
  const a = typeof lat === 'string' ? Number(lat) : lat;
  const b = typeof lng === 'string' ? Number(lng) : lng;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a < -90 || a > 90 || b < -180 || b > 180) return false;
  if (Math.abs(a) < 0.01 && Math.abs(b) < 0.01) return false;
  return true;
}

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function transformLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return r;
}

function transformLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return r;
}

/**
 * WGS-84 → GCJ-02。
 * 高德 / 腾讯瓦片用的是 GCJ-02；GPS、Google Maps、OSM 直接拿来会偏 500~700 米，
 * 必须先用这个函数转一次。BD-09（百度）不在这里处理，百度系自行先转 GCJ-02。
 */
export function wgs2gcj(lat, lng) {
  if (!isValidCoord(lat, lng)) return null;
  const dLat0 = transformLat(lng - 105, lat - 35);
  const dLng0 = transformLng(lng - 105, lat - 35);
  let radLat = lat / 180 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = (dLat0 * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  const dLng = (dLng0 * 180) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/** 两点球面距离（公里），用于「62px 半径内有几个邻居」的密度估算 */
export function haversineKm(a, b) {
  if (!isValidCoord(a?.lat, a?.lng) || !isValidCoord(b?.lat, b?.lng)) return Infinity;
  const toRad = (d) => (d * PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 一组坐标的外接矩形；没有合法点返回 null */export function boundsOf(stops) {
  let minLat = Infinity; let maxLat = -Infinity;
  let minLng = Infinity; let maxLng = -Infinity;
  for (const s of stops || []) {
    if (!isValidCoord(s?.lat, s?.lng)) continue;
    minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
    minLng = Math.min(minLng, s.lng); maxLng = Math.max(maxLng, s.lng);
  }
  if (!Number.isFinite(minLat)) return null;
  return { minLat, maxLat, minLng, maxLng };
}

/* ------------------------------------------------------------------ *
 * 四、图标自动缩放
 * ------------------------------------------------------------------ */

/**
 * 图标缩放：先按地图级别给基准，再按周边密度打折。
 * 规则取自《接入说明》：11 级及以下 0.42 倍，15 级 1.0 倍；
 * 62px 半径内邻居 ≥4 时再乘 0.46，逐步退化成只留编号的小圆点。
 */
export function iconScaleForZoom(zoom, neighborCount = 0) {
  const z = Number.isFinite(zoom) ? zoom : 14;
  let base;
  if (z <= 11) base = 0.42;
  else if (z === 12) base = 0.55;
  else if (z === 13) base = 0.72;
  else if (z === 14) base = 0.88;
  else base = 1.0;

  const n = Number.isFinite(neighborCount) ? neighborCount : 0;
  let density = 1;
  if (n >= 4) density = 0.46;
  else if (n === 3) density = 0.62;
  else if (n === 2) density = 0.8;

  const value = Math.max(0.3, Math.min(1.2, base * density));
  return Math.round(value * 100) / 100;
}

/** 62px 大约等于多少公里，随纬度与级别变化；用于把屏幕半径换成经纬度半径 */
export function kmPerPixel(lat, zoom) {
  const z = Number.isFinite(zoom) ? zoom : 14;
  return (156543.03392 * Math.cos((lat * PI) / 180)) / (2 ** z) / 1000;
}

/** 数一数第 index 个点周围 radiusPx 像素内还有几个点 */
export function neighborCount(stops, index, { zoom = 14, radiusPx = 62 } = {}) {
  const target = stops?.[index];
  if (!isValidCoord(target?.lat, target?.lng)) return 0;
  const radiusKm = kmPerPixel(target.lat, zoom) * radiusPx;
  let n = 0;
  for (let i = 0; i < (stops || []).length; i += 1) {
    if (i === index) continue;
    if (haversineKm(target, stops[i]) <= radiusKm) n += 1;
  }
  return n;
}

/**
 * 两站之间的示意弧线（不是真实导航轨迹）。
 * 直线会让同一天的多段行程叠在一起，统一往一侧拱起便于区分；
 * 想要真实路径得自己调高德 driving/transit 接口回填。
 * @returns {Array<[number,number]>} [[lat,lng], …]
 */
export function arcPoints(a, b, { steps = 24, curve = 0.16 } = {}) {
  if (!isValidCoord(a?.lat, a?.lng) || !isValidCoord(b?.lat, b?.lng)) return [];
  const lat1 = a.lat; const lng1 = a.lng;
  const lat2 = b.lat; const lng2 = b.lng;
  const dx = lng2 - lng1;
  const dy = lat2 - lat1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [[lat1, lng1], [lat2, lng2]];

  // 垂直方向偏移量，按两点距离等比缩放；固定往「左上方」拱，保证同向一致
  const nx = -dy / len;
  const ny = dx / len;
  const cx = (lng1 + lng2) / 2 + nx * len * curve;
  const cy = (lat1 + lat2) / 2 + ny * len * curve;

  const points = [];
  const n = Math.max(2, Math.round(steps));
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const mt = 1 - t;
    const lng = mt * mt * lng1 + 2 * mt * t * cx + t * t * lng2;
    const lat = mt * mt * lat1 + 2 * mt * t * cy + t * t * lat2;
    points.push([lat, lng]);
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * 五、把寰途的 plan 转成地图站点
 * ------------------------------------------------------------------ */

/**
 * 站点结构（前端与后端共用）：
 * { day, order, label, title, type, icon, time, dur, mode, modeText, addr, lat, lng, source, missing }
 * source: 'model' 模型给的坐标 / 'manual' 用户手动定位 / 'none' 没有坐标
 */
export function planToStops(plan) {
  const stops = [];
  const missing = [];
  const days = Array.isArray(plan?.days) ? plan.days : [];

  days.forEach((day, di) => {
    const dayNo = Number.isFinite(day?.day) ? day.day : di + 1;
    const items = Array.isArray(day?.items) ? day.items : [];
    items.forEach((it, ii) => {
      const title = String(it?.title ?? '').trim();
      if (!title) return;
      const mode = transportOf(it?.transportFromPrev);
      const base = {
        day: dayNo,
        order: ii,
        label: title,
        title,
        type: String(it?.type ?? ''),
        icon: coerceIconId(it?.geo?.icon) || iconIdFor(it),
        time: String(it?.time ?? ''),
        dur: Number.isFinite(it?.durationMin) ? it.durationMin : 90,
        transportMin: Number.isFinite(it?.transportMin) ? Math.max(0, it.transportMin) : 0,
        transportFromPrev: String(it?.transportFromPrev ?? ''),
        mode,
        modeText: TRANSPORT_LABEL[mode],
        addr: String(it?.area ?? ''),
      };
      const geo = it?.geo;
      if (isValidCoord(geo?.lat, geo?.lng)) {
        stops.push({
          ...base,
          lat: Number(geo.lat),
          lng: Number(geo.lng),
          source: geo.source === 'manual' ? 'manual' : 'model',
          missing: false,
        });
      } else {
        missing.push({ ...base, lat: null, lng: null, source: 'none', missing: true });
      }
    });
  });

  return { stops, missing };
}

/** 按天分组，返回 [{day, stops, transportMin, distanceKm}] */
export function groupByDay(stops) {
  const map = new Map();
  for (const s of stops || []) {
    const key = Number.isFinite(s?.day) ? s.day : 1;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, list]) => {
      let distanceKm = 0;
      for (let i = 1; i < list.length; i += 1) {
        const d = haversineKm(list[i - 1], list[i]);
        if (Number.isFinite(d)) distanceKm += d;
      }
      return {
        day,
        stops: list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        distanceKm: Math.round(distanceKm * 10) / 10,
      };
    });
}

/* ------------------------------------------------------------------ *
 * 六、时间轴重算
 * ------------------------------------------------------------------ */

const MIN_OF_DAY = 24 * 60;

/** 'HH:MM' → 分钟数；非法返回 null */
export function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 分钟数 → 'HH:MM'，跨天时回绕（并在 overflow 标记） */
export function formatTime(totalMinutes) {
  const v = Math.round(Number(totalMinutes));
  if (!Number.isFinite(v)) return '--:--';
  const t = ((v % MIN_OF_DAY) + MIN_OF_DAY) % MIN_OF_DAY;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 重算某一天的到达/离开时间。
 * 第一站以自身 time（或 dayStart）为起点；之后 = 上一站离开 + 段间交通。
 */
export function recomputeDayTimeline(items, { dayStart = '09:00' } = {}) {
  const list = Array.isArray(items) ? items : [];
  let cursor = parseTime(list[0]?.time) ?? parseTime(dayStart) ?? 9 * 60;
  let overflow = false;
  let transportMin = 0;
  let busyMin = 0;

  const out = list.map((it, i) => {
    const dur = Number.isFinite(it?.dur) ? Math.max(0, Math.round(it.dur)) : 90;
    const transfer = i === 0 ? 0 : Math.max(0, Math.round(Number(it?.transportMin) || 0));
    if (i > 0) {
      cursor += transfer;
      transportMin += transfer;
    }
    const arrive = cursor;
    const leave = arrive + dur;
    busyMin += dur;
    cursor = leave;
    if (leave >= MIN_OF_DAY) overflow = true;
    return {
      ...it,
      transfer,
      arriveMin: arrive,
      leaveMin: leave,
      arrive: formatTime(arrive),
      leave: formatTime(leave),
    };
  });

  return {
    items: out,
    transportMin,
    busyMin,
    overflow,
    endMin: cursor,
    end: formatTime(cursor),
  };
}

/* ------------------------------------------------------------------ *
 * 七、城市中心（没有坐标时的地图落点）
 * ------------------------------------------------------------------ */

export const CITY_CENTER = {
  北京: [39.9042, 116.4074], 上海: [31.2304, 121.4737], 广州: [23.1291, 113.2644],
  深圳: [22.5431, 114.0579], 杭州: [30.2741, 120.1551], 成都: [30.5728, 104.0668],
  重庆: [29.5630, 106.5516], 西安: [34.3416, 108.9398], 南京: [32.0603, 118.7969],
  苏州: [31.2989, 120.5853], 武汉: [30.5928, 114.3055], 长沙: [28.2282, 112.9388],
  厦门: [24.4798, 118.0894], 青岛: [36.0671, 120.3826], 天津: [39.0842, 117.2009],
  郑州: [34.7466, 113.6254], 济南: [36.6512, 117.1201], 昆明: [25.0389, 102.7183],
  大理: [25.6065, 100.2676], 丽江: [26.8721, 100.2299], 三亚: [18.2528, 109.5119],
  海口: [20.0444, 110.1999], 桂林: [25.2736, 110.2900], 阳朔: [24.7785, 110.4966],
  贵阳: [26.6470, 106.6302], 南宁: [22.8170, 108.3665], 福州: [26.0745, 119.2965],
  泉州: [24.8741, 118.6757], 宁波: [29.8683, 121.5440], 无锡: [31.4912, 120.3119],
  合肥: [31.8206, 117.2272], 南昌: [28.6820, 115.8579], 太原: [37.8706, 112.5489],
  石家庄: [38.0428, 114.5149], 沈阳: [41.8057, 123.4315], 大连: [38.9140, 121.6147],
  长春: [43.8171, 125.3235], 哈尔滨: [45.8038, 126.5350], 呼和浩特: [40.8424, 111.7493],
  银川: [38.4872, 106.2309], 西宁: [36.6171, 101.7782], 兰州: [36.0611, 103.8343],
  乌鲁木齐: [43.8256, 87.6168], 拉萨: [29.6520, 91.1721], 敦煌: [40.1421, 94.6618],
  张家界: [29.1170, 110.4791], 黄山: [29.7147, 118.3376], 洛阳: [34.6197, 112.4540],
  开封: [34.7971, 114.3076], 扬州: [32.3942, 119.4127], 绍兴: [30.0029, 120.5810],
  嘉兴: [30.7522, 120.7500], 珠海: [22.2707, 113.5767], 汕头: [23.3535, 116.6822],
  香港: [22.3193, 114.1694], 澳门: [22.1987, 113.5439], 台北: [25.0330, 121.5654],
  高雄: [22.6273, 120.3014], 冲绳: [26.2124, 127.6809], 东京: [35.6762, 139.6503],
  大阪: [34.6937, 135.5023], 京都: [35.0116, 135.7681], 北海道: [43.0618, 141.3545],
  首尔: [37.5665, 126.9780], 曼谷: [13.7563, 100.5018], 清迈: [18.7883, 98.9853],
  新加坡: [1.3521, 103.8198], 吉隆坡: [3.1390, 101.6869], 巴厘岛: [-8.4095, 115.1889],
  河内: [21.0278, 105.8342], 胡志明市: [10.8231, 106.6297], 金边: [11.5564, 104.9282],
  巴黎: [48.8566, 2.3522], 伦敦: [51.5074, -0.1278], 罗马: [41.9028, 12.4964],
  米兰: [45.4642, 9.1900], 巴塞罗那: [41.3874, 2.1686], 阿姆斯特丹: [52.3676, 4.9041],
  柏林: [52.5200, 13.4050], 维也纳: [48.2082, 16.3738], 苏黎世: [47.3769, 8.5417],
  纽约: [40.7128, -74.0060], 旧金山: [37.7749, -122.4194], 洛杉矶: [34.0522, -118.2437],
  悉尼: [-33.8688, 151.2093], 墨尔本: [-37.8136, 144.9631], 奥克兰: [-36.8485, 174.7633],
  伊斯坦布尔: [41.0082, 28.9784], 迪拜: [25.2048, 55.2708], 开罗: [30.0444, 31.2357],
};

/**
 * 找目的地城市中心。容忍「杭州市」「浙江杭州」「杭州 西湖区」这类写法。
 * @returns {{name:string, lat:number, lng:number, source:'city-table'|'stops'} | null}
 */
export function cityCenterOf(name, stops = []) {
  const raw = String(name ?? '').trim();
  if (raw) {
    if (CITY_CENTER[raw]) {
      const [lat, lng] = CITY_CENTER[raw];
      return { name: raw, lat, lng, source: 'city-table' };
    }
    for (const key of Object.keys(CITY_CENTER)) {
      if (raw.includes(key)) {
        const [lat, lng] = CITY_CENTER[key];
        return { name: key, lat, lng, source: 'city-table' };
      }
    }
  }
  const b = boundsOf(stops);
  if (b) {
    return {
      name: raw || '行程中心',
      lat: (b.minLat + b.maxLat) / 2,
      lng: (b.minLng + b.maxLng) / 2,
      source: 'stops',
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 八、iframe 消息协议（与《接入说明》一致）
 * ------------------------------------------------------------------ */

export const MESSAGE_TYPES = {
  SET_PLAN: 'SET_PLAN',
  SET_CITY: 'SET_CITY',
  RECOMMEND: 'RECOMMEND',
  PLAN_UPDATED: 'PLAN_UPDATED',
};

/** 校验并规整外部传进来的 SET_PLAN 载荷；不认识的一律丢弃 */
export function normalizeIncomingPlan(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p, i) => {
      const label = String(p?.label ?? p?.name ?? '').trim();
      if (!label) return null;
      if (!isValidCoord(p?.lat, p?.lng)) return null;
      const mode = TRANSPORT_MODES.includes(p?.mode) ? p.mode : 'drive';
      return {
        day: Number.isFinite(p?.day) ? Math.max(1, Math.round(p.day)) : 1,
        order: i,
        label,
        title: label,
        type: '',
        icon: coerceIconId(p?.id) || 'pin',
        time: String(p?.time ?? ''),
        dur: Number.isFinite(p?.dur) ? p.dur : 90,
        mode,
        modeText: TRANSPORT_LABEL[mode],
        addr: String(p?.addr ?? ''),
        lat: Number(p.lat),
        lng: Number(p.lng),
        source: 'model',
        missing: false,
      };
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 九、浏览器挂载（Node 里没有 window，自动跳过）
 * ------------------------------------------------------------------ */

if (typeof window !== 'undefined') {
  window.TravelMapCore = {
    ICON_IDS, TRANSPORT_MODES, TRANSPORT_LABEL, CITY_CENTER, MESSAGE_TYPES,
    iconIdFor, coerceIconId, transportOf, isValidCoord, wgs2gcj, haversineKm,
    boundsOf, iconScaleForZoom, kmPerPixel, neighborCount, arcPoints, planToStops, groupByDay,
    parseTime, formatTime, recomputeDayTimeline, cityCenterOf, normalizeIncomingPlan,
  };
}
