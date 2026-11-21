/**
 * 寰途 · 地图图标（18 种）
 *
 * 每个图标都是 24×24 视窗里的描边图形，颜色跟随 currentColor，
 * 这样同一条 SVG 既能当白色标记底图，也能当时间轴里的深色小图标。
 *
 * 用法：
 *   HuantuIcons.svg('attraction')                  → '<svg …>…</svg>'
 *   HuantuIcons.svg('attraction', { size: 18 })    → 指定尺寸
 *   HuantuIcons.has('xxx')                         → 是否在白名单内
 */
(function (global) {
  'use strict';

  const SHAPES = {
    origin: [
      '<path d="M4 11.4 12 4.8l8 6.6"/>',
      '<path d="M6.6 10.3V19h10.8v-8.7"/>',
      '<path d="M10.2 19v-3.6h3.6V19"/>',
    ],
    airport: [
      '<path d="M12 3.4c.9 0 1.5.9 1.5 2v3.5l6.6 3.5v2l-6.6-1.9v3.5l2.2 1.7v1.6L12 18.5l-3.7.8v-1.6l2.2-1.7v-3.5L3.9 14.4v-2l6.6-3.5V5.4c0-1.1.6-2 1.5-2z"/>',
    ],
    train: [
      '<rect x="4.8" y="3.6" width="14.4" height="12.6" rx="2.6"/>',
      '<path d="M4.8 9.2h14.4"/>',
      '<path d="M9.4 20.4 11 16.2"/><path d="M14.6 20.4 13 16.2"/>',
      '<path d="M8.6 12.9h.02"/><path d="M15.4 12.9h.02"/>',
    ],
    hotel: [
      '<path d="M3 19V8.6"/>',
      '<path d="M3 15.2h18V19"/>',
      '<path d="M11 15.2h6.4a3.6 3.6 0 0 0-3.6-3.6H11z"/>',
      '<circle cx="7.2" cy="11.2" r="1.7"/>',
    ],
    homestay: [
      '<path d="M4 11.2 12 4.6l8 6.6"/>',
      '<path d="M6.4 10V19h11.2v-9"/>',
      '<path d="M10 19v-3.4h4V19"/>',
      '<path d="M15.6 7.6V5.4h1.8v4"/>',
    ],
    attraction: [
      '<path d="M12 4.4l2.4 5 5.3.7-3.9 3.8 1 5.3-4.8-2.5-4.8 2.5 1-5.3L4.3 10l5.3-.7z"/>',
    ],
    viewpoint: [
      '<path d="M2.6 12S6.2 6.6 12 6.6 21.4 12 21.4 12 17.8 17.4 12 17.4 2.6 12 2.6 12z"/>',
      '<circle cx="12" cy="12" r="2.5"/>',
    ],
    restaurant: [
      '<path d="M8.2 3.8v5.6a2 2 0 0 0 2 2v9.8"/>',
      '<path d="M6.1 3.8v3.9"/><path d="M10.3 3.8v3.9"/>',
      '<path d="M16.6 3.8c1.5 1.1 2.1 2.6 2.1 4.6s-.6 3.3-2.1 4.2v8.6"/>',
    ],
    coffee: [
      '<path d="M5.8 8.2h11v4.9a4 4 0 0 1-4 4h-3a4 4 0 0 1-4-4z"/>',
      '<path d="M16.8 9.2h1.4a2.4 2.4 0 0 1 0 4.8h-1.4"/>',
      '<path d="M5 20.2h13"/>',
    ],
    shopping: [
      '<path d="M6.2 8.2h11.6l1 12H5.2z"/>',
      '<path d="M9.6 8.2V6.1a2.4 2.4 0 0 1 4.8 0v2.1"/>',
    ],
    market: [
      '<path d="M3.6 9.6 5.6 4.8h12.8l2 4.8"/>',
      '<path d="M3.6 9.6h16.8"/>',
      '<path d="M4.8 9.6V19h14.4V9.6"/>',
      '<path d="M9.2 19v-4.8h5.6V19"/>',
    ],
    beach: [
      '<path d="M2.8 11.8a9.2 9.2 0 0 1 18.4 0z"/>',
      '<path d="M12 11.8v7.4a2.1 2.1 0 0 0 4.2 0"/>',
    ],
    mountain: [
      '<path d="M2.4 19.2 9 7.2l3.6 6.1 2-3.1 6.1 9z"/>',
      '<path d="M7.4 10.6 9 12.4l1.7-1.8"/>',
    ],
    park: [
      '<path d="M12 3.8 7.4 10h2.1L6 15.2h12L14.5 10h2.1z"/>',
      '<path d="M12 15.2v3.6"/><path d="M9.2 20.2h5.6"/>',
    ],
    museum: [
      '<path d="M3.2 9.4 12 4.2l8.8 5.2z"/>',
      '<path d="M5.6 9.4V18"/><path d="M9.6 9.4V18"/><path d="M14.4 9.4V18"/><path d="M18.4 9.4V18"/>',
      '<path d="M3.2 20.4h17.6"/>',
    ],
    pier: [
      '<path d="M12 5.2v13.4"/>',
      '<path d="M8.8 8h6.4"/>',
      '<path d="M12 18.6c-3.2 0-5.4-2.1-5.4-4.8"/>',
      '<path d="M12 18.6c3.2 0 5.4-2.1 5.4-4.8"/>',
    ],
    car: [
      '<path d="M4.4 16.4v-3.2l1.9-4.2h11.4l1.9 4.2v3.2z"/>',
      '<path d="M4.4 13.2h15.2"/>',
      '<path d="M7.6 16.4a1.35 1.35 0 1 1-2.7 0 1.35 1.35 0 0 1 2.7 0z"/>',
      '<path d="M19.1 16.4a1.35 1.35 0 1 1-2.7 0 1.35 1.35 0 0 1 2.7 0z"/>',
    ],
    pin: [
      '<path d="M12 21s6.4-6.1 6.4-10.6a6.4 6.4 0 1 0-12.8 0C5.6 14.9 12 21 12 21z"/>',
      '<circle cx="12" cy="10.3" r="2.3"/>',
    ],
  };

  /** 中文名，用于图例与无障碍标签 */
  const LABELS = {
    origin: '出发地', airport: '机场', train: '火车站', hotel: '酒店',
    homestay: '民宿', attraction: '景点', viewpoint: '观景', restaurant: '餐厅',
    coffee: '咖啡', shopping: '商场', market: '市集', beach: '海滩',
    mountain: '山野', park: '公园', museum: '博物馆', pier: '码头',
    car: '交通', pin: '标记',
  };

  function svg(id, { size = 22, strokeWidth = 1.7, className = '' } = {}) {
    const shapes = SHAPES[id] || SHAPES.pin;
    const cls = className ? ` class="${className}"` : '';
    return `<svg${cls} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" `
      + 'stroke="currentColor" stroke-width="' + strokeWidth + '" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + shapes.join('') + '</svg>';
  }

  global.HuantuIcons = {
    ids: Object.keys(SHAPES),
    labels: LABELS,
    has: (id) => Object.prototype.hasOwnProperty.call(SHAPES, id),
    label: (id) => LABELS[id] || '标记',
    svg,
  };
}(typeof window !== 'undefined' ? window : globalThis));
