/**
 * 寰途 · 智能规划地图组件（TravelMap）
 *
 * 对外 API 与《旅游地图行程组件 · 接入说明》保持一致：
 *   new TravelMap(el, { center:[lat,lng], zoom, style, editable })
 *   map.setStops(list)      渲染 / 替换全部站点与路线
 *   map.fit()               自动缩放到能装下所有点
 *   map.flyToStop(i)        飞到第 i 站
 *   map.setScale(v|null)    手动指定图标缩放；null 恢复按级别自动
 *   map.setTileStyle(8|7)   底图风格：8 浅色（默认）/ 7 标准
 *   map.on('stopchange'|'stopmoved'|'offline', fn)
 *   map.destroy()           卸载
 *
 * 依赖：Leaflet（本地 vendor，不走 CDN）、HuantuIcons、TravelMapCore。
 * 没有网络时不会报错：瓦片连续失败会自动切到「离线示意模式」，站点与连线照常可用。
 */
(function (global) {
  'use strict';

  const L = global.L;
  const Icons = global.HuantuIcons;

  if (!L) throw new Error('TravelMap 需要 Leaflet（/vendor/leaflet.js）');
  if (!Icons) throw new Error('TravelMap 需要 icons.js');

  // travel-map-core.mjs 是 ES 模块，浏览器里要等文档解析完才执行；
  // 这里立刻发起加载并挂到 window.travelMapReady，使用方 await 一下即可，
  // 不必关心脚本标签的先后顺序。
  global.travelMapReady = global.TravelMapCore
    ? Promise.resolve(global.TravelMapCore)
    : import('/travel-map-core.mjs').then((m) => {
      global.TravelMapCore = m;
      return m;
    });

  /** 惰性取核心模块：构造函数里调用，避免加载顺序造成的空引用 */
  function core() {
    const c = global.TravelMapCore;
    if (!c) throw new Error('TravelMap 核心模块尚未加载完成，请先 await window.travelMapReady');
    return c;
  }

  /** 按天配色：第 1 天到第 7 天循环 */
  const DAY_COLORS = ['#1f6f5c', '#b07d18', '#2f6f9f', '#a3492e', '#6b4c9a', '#2f7a4a', '#9a4a6b'];

  /** 交通方式 → 虚线样式与图例名 */
  const MODE_DASH = { walk: [3, 7], metro: [12, 6], bus: [16, 7], taxi: [6, 5], drive: null };

  /** 高德栅格瓦片：8 浅色 / 7 标准 */
  const TILE_STYLE = {
    8: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    7: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
  };

  /** 瓦片连续失败到这个数就认定「网络到不了瓦片服务」，切离线 */
  const TILE_FAIL_LIMIT = 6;

  const TRUNC = (v, n) => {
    const s = String(v ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  class TravelMap {
    constructor(container, options = {}) {
      if (!container) throw new Error('TravelMap 需要一个容器元素');
      core(); // 早期失败：核心模块没加载完就在这里报清楚，别等到 setStops 才炸
      this.el = container;
      this.options = {
        zoom: options.zoom ?? 13,
        style: options.style === 7 ? 7 : 8,
        editable: Boolean(options.editable),
        autoFit: options.autoFit !== false,
        interactive: options.interactive !== false,
      };

      this.stops = [];
      this.timeline = new Map();   // day → recomputeDayTimeline 结果
      this.fixedScale = null;
      this.offline = false;
      this.placementCb = null;
      this.listeners = new Map();
      this.tileErrors = 0;
      this._fitOnce = false;

      const center = Array.isArray(options.center) && options.center.length === 2
        ? options.center : [23.1291, 113.2644];

      this.map = L.map(container, {
        center,
        zoom: this.options.zoom,
        minZoom: 3,
        maxZoom: 18,
        zoomControl: false,
        attributionControl: true,
        dragging: this.options.interactive,
        scrollWheelZoom: this.options.interactive,
        doubleClickZoom: this.options.interactive,
        touchZoom: this.options.interactive,
        keyboard: this.options.interactive,
        preferCanvas: true,
      });

      L.control.zoom({ position: 'bottomright' }).addTo(this.map);
      this.map.attributionControl.setPrefix('');
      this.map.attributionControl.addAttribution('底图 © 高德地图');

      this.lineLayer = L.layerGroup().addTo(this.map);
      this.markerLayer = L.layerGroup().addTo(this.map);

      this._bindTileStyle(this.options.style);
      this._bindEvents();
    }

    /* ---------------- 事件 ---------------- */

    on(event, fn) {
      if (typeof fn !== 'function') return this;
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(fn);
      return this;
    }

    off(event, fn) {
      this.listeners.get(event)?.delete(fn);
      return this;
    }

    _emit(event, payload) {
      const set = this.listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try { fn(payload); } catch (error) { console.error('[TravelMap]', event, error); }
      }
    }

    _bindEvents() {
      this.map.on('zoomend', () => this._applyScale());
      this.map.on('click', (e) => {
        if (!this.placementCb) return;
        const cb = this.placementCb;
        this.placementCb = null;
        this.el.classList.remove('is-placing');
        cb(e.latlng);
      });
    }

    /* ---------------- 底图 ---------------- */

    _bindTileStyle(style) {
      this.style = style;
      if (this.tileLayer) {
        this.map.removeLayer(this.tileLayer);
        this.tileLayer = null;
      }
      if (this.offline) return;

      this.tileErrors = 0;
      const layer = L.tileLayer(TILE_STYLE[style] || TILE_STYLE[8], {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        detectRetina: false,
        className: 'tm-tiles',
      });
      layer.on('tileerror', () => {
        this.tileErrors += 1;
        if (this.tileErrors >= TILE_FAIL_LIMIT && !this.offline) this._goOffline();
      });
      layer.addTo(this.map);
      this.tileLayer = layer;
    }

    /** 切底图风格：8 浅色 / 7 标准 / 'offline' 强制离线 */
    setTileStyle(style) {
      if (style === 'offline') {
        this._goOffline();
        return this;
      }
      this.offline = false;
      this.el.classList.remove('is-offline');
      if (this.offlineNotice) {
        this.offlineNotice.remove();
        this.offlineNotice = null;
      }
      if (this.offlineLayer) {
        this.map.removeLayer(this.offlineLayer);
        this.offlineLayer = null;
      }
      this._bindTileStyle(style === 7 ? 7 : 8);
      return this;
    }

    /** 瓦片拿不到时改用本地绘制的网格底图，功能不受影响 */
    _goOffline() {
      if (this.offline) return;
      this.offline = true;
      this.el.classList.add('is-offline');
      if (this.tileLayer) {
        this.map.removeLayer(this.tileLayer);
        this.tileLayer = null;
      }
      const OfflineGrid = L.GridLayer.extend({
        createTile() {
          const tile = document.createElement('canvas');
          const size = this.getTileSize();
          tile.width = size.x;
          tile.height = size.y;
          const ctx = tile.getContext('2d');
          ctx.fillStyle = '#f5f2ea';
          ctx.fillRect(0, 0, size.x, size.y);
          ctx.strokeStyle = 'rgba(31,111,92,0.14)';
          ctx.lineWidth = 1;
          ctx.strokeRect(0.5, 0.5, size.x - 1, size.y - 1);
          ctx.strokeStyle = 'rgba(31,111,92,0.07)';
          for (let i = 32; i < size.x; i += 32) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size.y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size.x, i); ctx.stroke();
          }
          return tile;
        },
      });
      this.offlineLayer = new OfflineGrid({ maxZoom: 18 });
      this.offlineLayer.addTo(this.map);

      if (!this.offlineNotice) {
        const note = document.createElement('p');
        note.className = 'tm-offline-note';
        note.textContent = '离线示意模式：底图瓦片不可达，站点与连线仍然可用';
        this.el.appendChild(note);
        this.offlineNotice = note;
      }
      this._emit('offline', { reason: 'tileerror' });
    }

    /* ---------------- 站点与路线 ---------------- */

    setStops(list) {
      const raw = Array.isArray(list) ? list : [];
      // 只画有坐标的点；缺坐标的由调用方单独提示
      this.stops = raw.filter((s) => core().isValidCoord(s?.lat, s?.lng))
        .map((s, i) => ({ ...s, _i: i }));

      this._rebuildTimeline();
      this._drawLines();
      this._drawMarkers();
      this._applyScale();

      if (this.options.autoFit && !this._fitOnce && this.stops.length) {
        this.fit();
        this._fitOnce = true;
      }
      this._emit('stopchange', { count: this.stops.length });
      return this;
    }

    _rebuildTimeline() {
      this.timeline = new Map();
      const byDay = core().groupByDay(this.stops);
      for (const group of byDay) {
        const result = core().recomputeDayTimeline(group.stops);
        // 时间轴结果里的 items 是新对象，把到达/离开时间写回原始站点，弹窗与列表共用同一份
        result.items.forEach((item, i) => {
          const target = group.stops[i];
          if (!target) return;
          target.arrive = item.arrive;
          target.leave = item.leave;
        });
        this.timeline.set(group.day, result);
      }
    }

    /** 当天算好的时间轴（app.js 的时间轴列表直接用它，避免两套算法） */
    timelineOf(day) {
      return this.timeline.get(Number(day)) || null;
    }

    dayColor(day) {
      return DAY_COLORS[(Number(day) - 1 + 7) % 7];
    }

    /** CSP 不允许内联 style，配色只能走类名：tm-c1 … tm-c7 */
    dayClass(day) {
      return `tm-c${((Number(day) - 1 + 7) % 7) + 1}`;
    }

    _drawLines() {
      this.lineLayer.clearLayers();
      const byDay = core().groupByDay(this.stops);
      for (const group of byDay) {
        const color = this.dayColor(group.day);
        for (let i = 1; i < group.stops.length; i += 1) {
          const a = group.stops[i - 1];
          const b = group.stops[i];
          const dash = MODE_DASH[b.mode] ?? null;
          const points = core().arcPoints(a, b);
          L.polyline(points, {
            color,
            weight: 3,
            opacity: 0.82,
            dashArray: dash ? dash.join(' ') : null,
            lineCap: 'round',
            className: 'tm-line',
          }).addTo(this.lineLayer);

          if (b.transportMin > 0 || b.modeText) {
            const mid = points[Math.floor(points.length / 2)];
            const label = `${b.modeText}${b.transportMin ? ' ' + b.transportMin + '分' : ''}`;
            L.marker(mid, {
              interactive: false,
              icon: L.divIcon({
                className: 'tm-seg-wrap',
                html: `<span class="tm-seg ${this.dayClass(group.day)}">${escapeHtml(label)}</span>`,
                iconSize: [0, 0],
              }),
            }).addTo(this.lineLayer);
          }
        }
      }
    }

    _drawMarkers() {
      this.markerLayer.clearLayers();
      this._markers = [];
      const byDay = core().groupByDay(this.stops);
      for (const group of byDay) {
        group.stops.forEach((stop, idx) => {
          const iconId = Icons.has(stop.icon) ? stop.icon : 'pin';
          const html = `<span class="tm-pin ${this.dayClass(group.day)}">`
            + `<span class="tm-pin__body">${Icons.svg(iconId, { size: 20 })}</span>`
            + `<span class="tm-pin__no">${idx + 1}</span>`
            + '</span>';
          const marker = L.marker([stop.lat, stop.lng], {
            icon: L.divIcon({ className: 'tm-marker-wrap', html, iconSize: [0, 0] }),
            draggable: this.options.editable,
            title: stop.label,
            riseOnHover: true,
          });
          marker.bindPopup(this._popupHtml(stop, idx + 1, group.day), {
            className: 'tm-popup',
            closeButton: true,
            maxWidth: 280,
          });
          if (this.options.editable) {
            marker.on('dragend', (e) => {
              const { lat, lng } = e.target.getLatLng();
              stop.lat = lat;
              stop.lng = lng;
              stop.source = 'manual';
              this._drawLines();
              marker.setPopupContent(this._popupHtml(stop, idx + 1, group.day));
              this._emit('stopmoved', { index: stop._i, lat, lng, stop });
            });
          }
          marker.addTo(this.markerLayer);
          this._markers.push(marker);
        });
      }
    }

    _popupHtml(stop, noInDay, day) {
      const sourceText = stop.source === 'manual' ? '坐标：手动定位' : '坐标：模型估计 · 待核实';
      const sourceClass = stop.source === 'manual' ? 'is-manual' : 'is-model';
      const time = stop.arrive && stop.leave
        ? `Day ${day} · ${stop.arrive}–${stop.leave} · 停留 ${stop.dur} 分钟`
        : `Day ${day} · 停留 ${stop.dur} 分钟`;
      return `<div class="tm-pop">`
        + `<p class="tm-pop__day">第 ${noInDay} 站</p>`
        + `<p class="tm-pop__title">${escapeHtml(stop.label)}</p>`
        + `<p class="tm-pop__meta">${escapeHtml(time)}</p>`
        + (stop.addr ? `<p class="tm-pop__addr">${escapeHtml(TRUNC(stop.addr, 40))}</p>` : '')
        + `<p class="tm-pop__badge ${sourceClass}">${escapeHtml(sourceText)}</p>`
        + '</div>';
    }

    /* ---------------- 缩放 ---------------- */

    _applyScale() {
      const zoom = this.map.getZoom();
      const pins = this.el.querySelectorAll('.tm-pin');
      if (!pins.length) return;
      let k = 0;
      const byDay = core().groupByDay(this.stops);
      for (const group of byDay) {
        for (let i = 0; i < group.stops.length; i += 1) {
          const pin = pins[k];
          k += 1;
          if (!pin) continue;
          const scale = this.fixedScale ?? core().iconScaleForZoom(
            zoom,
            core().neighborCount(group.stops, i, { zoom }),
          );
          // CSP 禁内联 style，缩放只能通过属性选择器驱动：data-scale 按 5% 一档
          const bucket = Math.min(125, Math.max(30, Math.round(scale * 20) * 5));
          pin.dataset.scale = String(bucket);
          // 只有缩到 11 级的 0.42、或密集时打到 0.46 折，才退化成只留编号的小圆点
          pin.classList.toggle('is-tiny', scale <= 0.46);
        }
      }
    }

    /** v 为数字时固定缩放（建议 0.5~1.2），为 null 时恢复自动 */
    setScale(v) {
      this.fixedScale = Number.isFinite(v) ? Math.max(0.2, Math.min(1.4, v)) : null;
      this._applyScale();
      return this;
    }

    getScale() {
      return this.fixedScale;
    }

    /* ---------------- 视图 ---------------- */

    fit() {
      const b = core().boundsOf(this.stops);
      if (!b) return this;
      const bounds = L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]);
      if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
        this.map.setView(bounds.getCenter(), 15);
      } else {
        this.map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
      }
      return this;
    }

    flyToStop(i) {
      const stop = this.stops[i];
      if (!stop) return this;
      this.map.flyTo([stop.lat, stop.lng], Math.max(this.map.getZoom(), 15), { duration: 0.6 });
      const marker = this._markers?.[i];
      if (marker) setTimeout(() => marker.openPopup(), 650);
      return this;
    }

    centerOn(lat, lng, zoom) {
      if (!core().isValidCoord(lat, lng)) return this;
      this.map.setView([lat, lng], zoom ?? this.map.getZoom());
      return this;
    }

    /* ---------------- 手动定位 ---------------- */

    /** 进入一次性的「点地图取坐标」模式 */
    beginPlacement(cb) {
      this.placementCb = typeof cb === 'function' ? cb : null;
      this.el.classList.toggle('is-placing', Boolean(this.placementCb));
      return this;
    }

    cancelPlacement() {
      this.placementCb = null;
      this.el.classList.remove('is-placing');
      return this;
    }

    /* ---------------- 生命周期 ---------------- */

    invalidate() {
      this.map.invalidateSize();
      return this;
    }

    destroy() {
      this.listeners.clear();
      this.map.remove();
      this.map = null;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  TravelMap.DAY_COLORS = DAY_COLORS;
  TravelMap.MODE_DASH = MODE_DASH;
  global.TravelMap = TravelMap;
}(typeof window !== 'undefined' ? window : globalThis));
