/* 寰途 · 交互原型脚本
 * 纯静态演示：所有数据为示例，不发起任何网络请求，不读取密钥。
 * 覆盖 6 个场景：需求表单 / 生成进度 / 行程结果（8 个页签）/ 重新规划 / 访问码 / 模型设置。
 */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ *
   * 示例数据（上海 → 杭州 3 天）
   * 坐标均为 GCJ-02，与线上 /api/visual/map 的 stops 结构一致。
   * ------------------------------------------------------------------ */

  const TRIP = {
    origin: '上海',
    destination: '杭州',
    startDate: '2026-11-15',
    days: 3,
    travelers: 2,
    budget: '两人合计 8000 元，不含往返机票',
    pace: 'balanced',
    interests: ['历史古迹', '美食', '咖啡'],
  };

  const DAY_COLORS = ['#9b4a3f', '#2f5b46', '#a8873f'];

  function makePlan() {
    return {
      title: '杭州三日 · 西湖与茶山之间',
      summary:
        '三天不赶路：第一天贴着西湖走，断桥到南山路，傍晚在河坊街吃小吃；'
        + '第二天出城进茶山，灵隐、飞来峰与龙井村连成一条线；第三天上午西溪湿地，'
        + '下午回到运河边的桥西历史街区，收尾留足去东站的时间。',
      stats: [
        { k: '天数', v: '3' },
        { k: '站点', v: '16' },
        { k: '出行人数', v: '2' },
        { k: '人均预估', v: '¥2,900' },
      ],
      highlights: [
        { t: '西湖不必环湖走完', d: '选西北段（断桥—孤山—曲院风荷），人流少一半，视线反而更好。' },
        { t: '灵隐要早', d: '8:30 前到山门，能避开旅行团；飞来峰造像在进寺前，先看造像再进寺。' },
        { t: '龙井村别在中午喝茶', d: '13:30 之后茶农才闲下来，能坐下来聊；中午在村里吃农家菜。' },
        { t: '东站预留 50 分钟', d: '从桥西打车 25–35 分钟，加上进站安检，17:30 前必须出发。' },
      ],
      days: [
        {
          label: 'Day 1',
          date: '11 月 15 日',
          weekday: '周日',
          theme: '贴着西湖走一圈',
          area: '西湖区 · 湖滨',
          items: [
            { time: '09:00', title: '断桥残雪', note: '从北山街这侧上桥，逆光少，人相对少。', dur: '50 分钟', move: '酒店步行 12 分钟', lat: 30.259, lng: 120.149 },
            { time: '10:10', title: '浙江省博物馆（孤山馆区）', note: '免费，需提前一天在公众号预约；重点看一楼越窑青瓷。', dur: '90 分钟', move: '步行 8 分钟', lat: 30.2545, lng: 120.145 },
            { time: '12:30', title: '楼外楼（孤山路店）', note: '西湖醋鱼与叫化鸡；两人点三个菜足够，人均 160 左右。', dur: '70 分钟', move: '步行 3 分钟', kind: 'meal', lat: 30.2543, lng: 120.1425 },
            { time: '14:10', title: '西泠印社', note: '在孤山南麓，院子小但清净，能俯瞰内西湖。', dur: '40 分钟', move: '步行 5 分钟', lat: 30.2535, lng: 120.144 },
            { time: '15:20', title: '雷峰塔', note: '门票 40 元；上塔看全景，下午光线顺，能看到整个西湖。', dur: '80 分钟', move: '打车 12 分钟', lat: 30.2312, lng: 120.1489 },
            { time: '18:30', title: '河坊街与南宋御街', note: '小吃集中在高银街；定胜糕、葱包桧各买一份分着吃。', dur: '120 分钟', move: '打车 15 分钟', kind: 'meal', lat: 30.242, lng: 120.169 },
          ],
        },
        {
          label: 'Day 2',
          date: '11 月 16 日',
          weekday: '周一',
          theme: '出城进茶山',
          area: '西湖区 · 灵隐 / 龙井',
          items: [
            { time: '08:30', title: '灵隐寺', note: '先买飞来峰景区门票（45 元）再买寺票（30 元）；早课期间最安静。', dur: '100 分钟', move: '打车 25 分钟', lat: 30.2408, lng: 120.099 },
            { time: '10:30', title: '飞来峰造像', note: '五代至元代石窟造像，沿溪走，重点看青林洞口与冷泉亭一带。', dur: '60 分钟', move: '步行 5 分钟', lat: 30.2415, lng: 120.0985 },
            { time: '12:00', title: '龙井村农家菜', note: '村口几家做本地菜；龙井虾仁按季节，11 月用的是保鲜茶。', dur: '70 分钟', move: '打车 12 分钟', kind: 'meal', lat: 30.2215, lng: 120.118 },
            { time: '13:30', title: '龙井村与十八棵御茶', note: '沿茶山步道上行 20 分钟到观景台，能看到整片茶田。', dur: '90 分钟', move: '步行 10 分钟', lat: 30.221, lng: 120.119 },
            { time: '16:00', title: '中国丝绸博物馆', note: '免费，周一闭馆 —— 本次是周一，已为你换成中国茶叶博物馆（双峰馆区）。', dur: '80 分钟', move: '打车 18 分钟', lat: 30.228, lng: 120.144 },
          ],
        },
        {
          label: 'Day 3',
          date: '11 月 17 日',
          weekday: '周二',
          theme: '湿地与运河，收尾回程',
          area: '西湖区 · 西溪 / 拱墅',
          items: [
            { time: '09:00', title: '西溪湿地（周家村入口）', note: '东区门票 80 元；坐摇橹船 1 小时，比步行省力且看得多。', dur: '150 分钟', move: '打车 30 分钟', lat: 30.27, lng: 120.07 },
            { time: '12:00', title: '西溪天堂午餐', note: '园区外商业街，选择多、不用排队。', dur: '60 分钟', move: '步行 8 分钟', kind: 'meal', lat: 30.2655, lng: 120.0735 },
            { time: '14:00', title: '桥西历史街区与拱宸桥', note: '运河边的老厂房改的街区，有刀剪剑博物馆，免费。', dur: '100 分钟', move: '打车 25 分钟', lat: 30.319, lng: 120.142 },
            { time: '16:10', title: '回酒店取行李', note: '预留 30 分钟收拾。', dur: '30 分钟', move: '打车 20 分钟', lat: 30.254, lng: 120.163 },
            { time: '17:30', title: '杭州东站', note: '提前 40 分钟进站；虹桥方向车次密集，不必赶最早一班。', dur: '—', move: '打车 28 分钟', lat: 30.291, lng: 120.213 },
          ],
        },
      ],
      insights: {
        attractions: [
          { name: '西湖（西北段）', tag: '必去', why: '断桥、孤山、曲院风荷连成一条线，两小时走完，人流比南线少。' },
          { name: '灵隐寺 + 飞来峰', tag: '人文', why: '杭州最有分量的石窟造像群，建议上午去。' },
          { name: '龙井村茶山', tag: '自然', why: '11 月茶田仍绿，步道 20 分钟可到观景台。' },
          { name: '西溪湿地', tag: '自然', why: '摇橹船是重点，步行看不到水道深处。' },
          { name: '桥西历史街区', tag: '小众', why: '运河边的工业遗存改造，游客密度低。' },
        ],
        food: [
          { name: '楼外楼（孤山路）', area: '西湖', why: '西湖醋鱼、叫化鸡，老字号里最稳的一家。', price: '人均 ¥160' },
          { name: '知味观（仁和路总店）', area: '湖滨', why: '小吃集合，猫耳朵与片儿川。', price: '人均 ¥45' },
          { name: '龙井村农家菜', area: '龙井', why: '土鸡煲与笋干，分量大。', price: '人均 ¥90' },
        ],
        transport: [
          { mode: '地铁', detail: '1 号线连接杭州东站与市中心，湖滨可走 1 号线龙翔桥站。', cost: '¥2–6' },
          { mode: '打车', detail: '西湖景区内高峰期限行，短途打车常被拒，优先步行 + 地铁。', cost: '¥15–40' },
          { mode: '城际', detail: '上海虹桥—杭州东 45–60 分钟，二等座 ¥73。', cost: '¥73' },
        ],
        season: '11 月中旬杭州 12–19℃，早晚偏凉；西湖边风大，带一件薄外套。桂花期已过，茶叶是秋茶。',
      },
      hotels: [
        { name: '湖滨银泰亚朵酒店', area: '湖滨 · 距西湖 400m', why: '地铁 1 号线龙翔桥站步行 5 分钟，早晚都能走到湖边。', price: '¥620 / 晚' },
        { name: '龙井山间民宿（示例）', area: '龙井村', why: '第二天上午不用赶路，出门就是茶田；缺点是进城打车慢。', price: '¥480 / 晚' },
        { name: '运河祈利酒店', area: '拱墅 · 近桥西', why: '第三天去东站方便，房间安静。', price: '¥560 / 晚' },
      ],
      sources: [
        { label: '实时搜索（搜狗 / Bing 免密钥通道）', type: 'search', status: 'ok', note: '景点开放时间、门票与地铁线路，查询于 2026-11-03 14:20' },
        { label: 'Open-Meteo 天气', type: 'weather', status: 'ok', note: '11 月 15–17 日预报，查询于 2026-11-03 14:21' },
        { label: '模型知识（qwen3.7-plus）', type: 'model', status: 'unverified', note: '餐厅推荐与人均价格来自模型知识，未实时核验' },
        { label: '酒店库存与房价', type: 'hotel', status: 'unverified', note: '未接入库存接口，价格为区间估计，需以官方渠道为准' },
      ],
      warnings: [
        '中国丝绸博物馆周一闭馆，Day 2 的 16:00 已替换为中国茶叶博物馆（双峰馆区）。',
        '西湖景区周末 8:00–17:00 实行单双号限行，打车可能需在外围下车。',
        '所有价格与营业时间请在出行前复核官方页面。',
      ],
    };
  }

  const state = { plan: makePlan(), tab: 'overview', replanned: false, timer: null };

  /* ------------------------------------------------------------------ *
   * 视图切换
   * ------------------------------------------------------------------ */

  function setView(view) {
    document.body.dataset.view = view;
    $$('.proto-steps button').forEach((b) => {
      b.classList.toggle('is-current', b.dataset.jump === view);
    });
    if (view === 'result') {
      const top = $('#result').getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  $$('.proto-steps button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.jump;
      if (target === 'settings') { openSettings(); return; }
      if (target === 'progress') { startProgress(); return; }
      setView(target);
    });
  });

  $$('[data-jump]').forEach((el) => {
    if (el.closest('.proto-steps')) return;
    el.addEventListener('click', (e) => {
      if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault();
      const target = el.dataset.jump;
      if (target === 'settings') { openSettings(); return; }
      if (target === 'progress') { startProgress(); return; }
      setView(target);
    });
  });

  $$('.proto-vw button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.proto-vw button').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.body.dataset.vw = btn.dataset.vw;
    });
  });

  /* ------------------------------------------------------------------ *
   * 表单
   * ------------------------------------------------------------------ */

  $$('#interestChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const on = $$('#interestChips .chip.is-on');
      if (!chip.classList.contains('is-on') && on.length >= 8) {
        toast('兴趣最多选 8 个');
        return;
      }
      chip.classList.toggle('is-on');
    });
  });

  $('#planForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const origin = $('#origin').value.trim();
    const destination = $('#destination').value.trim();
    if (!origin || !destination) { toast('请填写出发地与目的地'); return; }
    if (origin === destination) { toast('出发地与目的地相同'); return; }
    const next = makePlan();
    next.title = `${destination} ${$('#days').value} 日 · ${next.title.split('·').pop().trim()}`;
    state.plan = next;
    state.replanned = false;
    renderAll();
    startProgress();
  });

  /* ------------------------------------------------------------------ *
   * 生成进度
   * ------------------------------------------------------------------ */

  const STAGES = [
    ['研究目的地…', '正在检索景点、片区、季节与交通信息。'],
    ['编排每日动线…', '把候选景点排成时间轴，并计算每段移动耗时。'],
    ['校验约束…', '检查预算、体力强度、同行人与闭馆日。'],
    ['生成行程与地图…', '补全出行提示、坐标与日历信息。'],
  ];

  async function startProgress() {
    setView('progress');
    $$('#stageList .stage').forEach((li) => { li.dataset.state = ''; });
    $('#progressTitle').textContent = '正在研究目的地…';
    $('#progressDetail').textContent = STAGES[0][1];
    $('#cancelJob').hidden = false;
    const startedAt = Date.now();
    const jobId = Math.random().toString(16).slice(2, 14);
    $('#progressMeta').textContent = `已用时 0s · 任务 ID ${jobId}`;

    clearInterval(state.timer);
    state.timer = setInterval(() => {
      const sec = Math.round((Date.now() - startedAt) / 1000);
      $('#progressMeta').textContent = `已用时 ${sec}s · 任务 ID ${jobId}`;
    }, 1000);

    const cancelled = { v: false };
    $('#cancelJob').onclick = () => {
      cancelled.v = true;
      clearInterval(state.timer);
      $('#progressTitle').textContent = '任务已取消';
      $('#progressDetail').textContent = '已中止模型请求，可以回到表单修改需求后重新开始。';
      $('#cancelJob').hidden = true;
      toast('任务已取消');
      setTimeout(() => setView('form'), 1200);
    };

    const steps = $$('#stageList .stage');
    for (let i = 0; i < steps.length; i += 1) {
      if (cancelled.v) return;
      steps[i].dataset.state = 'doing';
      $('#progressTitle').textContent = STAGES[i][0];
      $('#progressDetail').textContent = STAGES[i][1];
      await wait(i === steps.length - 1 ? 1400 : 1600);
      if (cancelled.v) return;
      steps[i].dataset.state = 'done';
    }

    clearInterval(state.timer);
    await wait(320);
    if (cancelled.v) return;
    setView('result');
    setTab('overview');
    toast('行程已生成 · 16 个站点');
  }

  /* ------------------------------------------------------------------ *
   * 结果渲染
   * ------------------------------------------------------------------ */

  function renderAll() {
    renderOverview();
    renderDays();
    renderSpots();
    renderHotels();
    renderMap();
    renderCalendar();
    renderSources();
    renderReplan();
    $('#resultMeta').textContent =
      `${TRIP.origin} → ${TRIP.destination} · ${state.plan.days.length} 天 · ${TRIP.travelers} 人 · 生成于 2026-11-03 14:22`;
  }

  function renderOverview() {
    const p = state.plan;
    $('#panel-overview').innerHTML = `
      <div class="ov-top">
        <div class="ov-card">
          <h3>整体思路</h3>
          <p class="big">${p.title}</p>
          <p style="margin-top:12px">${p.summary}</p>
        </div>
        <div class="ov-card">
          <h3>关键提醒</h3>
          <ul class="hl-list">
            ${p.highlights.map((h, i) => `
              <li class="hl">
                <i>${i + 1}</i>
                <div><strong>${h.t}</strong><small>${h.d}</small></div>
              </li>`).join('')}
          </ul>
        </div>
      </div>
      <div class="stat-row">
        ${p.stats.map((s) => `<div class="stat"><b>${s.v}</b><span>${s.k}</span></div>`).join('')}
      </div>
      <div class="ov-card" style="margin-top:18px">
        <h3>季节与天气</h3>
        <p>${p.insights.season}</p>
        <p style="margin-top:10px;font-size:12px;color:var(--text-faint)">
          天气为 Open-Meteo 11 月 15–17 日预报，查询于 2026-11-03 14:21；出行前请复核官方预报。
        </p>
      </div>
      <div class="ov-card" style="margin-top:14px">
        <h3>需要你知道的三件事</h3>
        <ul class="hl-list">
          ${p.warnings.map((w, i) => `<li class="hl"><i>${i + 1}</i><div><small>${w}</small></div></li>`).join('')}
        </ul>
      </div>
    `;
  }

  function renderDays() {
    const p = state.plan;
    $('#panel-days').innerHTML = p.days.map((d, di) => `
      <div class="day-block">
        <div class="day-head">
          <b>${d.label}</b>
          <span>${d.date} · ${d.weekday}</span>
          <em>${d.theme} · ${d.area}</em>
        </div>
        <div class="timeline">
          ${d.items.map((it) => `
            <div class="tl-item" data-kind="${it.kind || 'spot'}">
              <div class="tl-time">${it.time}</div>
              <div class="tl-title">${it.title}</div>
              <div class="tl-note">${it.note}</div>
              <div class="tl-meta">
                <span>停留 ${it.dur}</span>
                <span>${it.move}</span>
                <span>${it.lat ? `坐标 ${it.lat.toFixed(4)}, ${it.lng.toFixed(4)}` : '坐标待补'}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('') + `
      <p class="map-note">移动耗时按公共交通 + 步行估算，未含等车与排队；实际以当日路况为准。</p>`;
  }

  function renderSpots() {
    const p = state.plan;
    $('#panel-spots').innerHTML = `
      <h3 style="font-size:15px;color:var(--ink);margin-bottom:10px">景点与活动</h3>
      <div class="card-grid">
        ${p.insights.attractions.map((a) => `
          <div class="mini-card">
            <span class="tag">${a.tag}</span>
            <h4>${a.name}</h4>
            <p>${a.why}</p>
          </div>`).join('')}
      </div>
      <h3 style="font-size:15px;color:var(--ink);margin:22px 0 10px">吃与喝</h3>
      <div class="card-grid">
        ${p.insights.food.map((f) => `
          <div class="mini-card">
            <h4>${f.name}</h4>
            <p>${f.why}</p>
            <div class="kv">${f.area} · ${f.price}</div>
          </div>`).join('')}
      </div>
      <h3 style="font-size:15px;color:var(--ink);margin:22px 0 10px">交通</h3>
      <div class="card-grid">
        ${p.insights.transport.map((t) => `
          <div class="mini-card">
            <h4>${t.mode}</h4>
            <p>${t.detail}</p>
            <div class="kv">${t.cost}</div>
          </div>`).join('')}
      </div>`;
  }

  function renderHotels() {
    const p = state.plan;
    $('#panel-hotels').innerHTML = `
      <h3 style="font-size:15px;color:var(--ink);margin-bottom:10px">按片区推荐</h3>
      <div class="card-grid">
        ${p.hotels.map((h) => `
          <div class="mini-card">
            <h4>${h.name}</h4>
            <div class="tag">${h.area}</div>
            <p>${h.why}</p>
            <div class="kv">${h.price} · 未接入库存，价格需核实</div>
          </div>`).join('')}
      </div>
      <p class="map-note">寰途不代订、不付款。以上为片区选择建议，预订请前往官方或正规平台。</p>`;
  }

  /* ---------- 地图：SVG 示意（与 /api/visual/map 的 stops 一致） ---------- */

  function stopsOf(plan) {
    const out = [];
    plan.days.forEach((d, di) => {
      d.items.forEach((it, ii) => {
        if (typeof it.lat !== 'number' || typeof it.lng !== 'number') return;
        out.push({ ...it, day: di + 1, order: ii + 1 });
      });
    });
    return out;
  }

  function renderMap() {
    const stops = stopsOf(state.plan);
    const W = 1000;
    const H = 600;
    const lngs = stops.map((s) => s.lng);
    const lats = stops.map((s) => s.lat);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const spanLng = Math.max(maxLng - minLng, 0.02);
    const spanLat = Math.max(maxLat - minLat, 0.015);

    const x = (lng) => (0.09 + ((lng - minLng) / spanLng) * 0.82) * W;
    const y = (lat) => (0.9 - ((lat - minLat) / spanLat) * 0.76) * H;

    const westLake = [
      [120.128, 30.259], [120.140, 30.262], [120.152, 30.256],
      [120.155, 30.245], [120.148, 30.236], [120.136, 30.235],
      [120.127, 30.243], [120.125, 30.252],
    ].map(([lng, lat]) => `${x(lng).toFixed(1)},${y(lat).toFixed(1)}`).join(' ');

    const grid = [];
    for (let i = 1; i < 8; i += 1) {
      grid.push(`<line x1="${(W / 8) * i}" y1="0" x2="${(W / 8) * i}" y2="${H}" />`);
    }
    for (let i = 1; i < 5; i += 1) {
      grid.push(`<line x1="0" y1="${(H / 5) * i}" x2="${W}" y2="${(H / 5) * i}" />`);
    }

    const paths = state.plan.days.map((d, di) => {
      const pts = d.items.filter((it) => typeof it.lat === 'number').map((it) => `${x(it.lng).toFixed(1)},${y(it.lat).toFixed(1)}`);
      if (pts.length < 2) return '';
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${DAY_COLORS[di % 3]}"
        stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"
        stroke-dasharray="${di === 0 ? '0' : di === 1 ? '7 5' : '3 4'}" opacity="0.85" />`;
    }).join('');

    const dots = stops.map((s, i) => {
      const cx = x(s.lng);
      const cy = y(s.lat);
      const color = DAY_COLORS[(s.day - 1) % 3];
      return `<g class="stop">
        <title>Day ${s.day} ${s.time} · ${s.title}</title>
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="11" fill="#fffdf8" stroke="${color}" stroke-width="2" />
        <text x="${cx.toFixed(1)}" y="${(cy + 3.6).toFixed(1)}" text-anchor="middle"
          font-size="11" font-family="Georgia, serif" fill="${color}">${i + 1}</text>
      </g>`;
    }).join('');

    const routeLines = state.plan.days.map((d, di) => `
      <div class="route-line" style="border-left-color:${DAY_COLORS[di % 3]}">
        <b>${d.label}</b>
        <span>${d.items.map((it) => it.title).join(' → ')}</span>
      </div>`).join('');

    $('#panel-map').innerHTML = `
      <div class="map-wrap">
        <svg class="map-canvas" viewBox="0 0 ${W} ${H}" role="img"
             aria-label="杭州三日行程路线示意图">
          <rect width="${W}" height="${H}" fill="#f2efe4" />
          <g stroke="#e2dcca" stroke-width="1">${grid.join('')}</g>
          <polygon points="${westLake}" fill="#cfe0dd" stroke="#a9c3be" stroke-width="1.5" />
          <text x="${x(120.1405).toFixed(0)}" y="${y(30.2485).toFixed(0)}" text-anchor="middle"
            font-size="12" fill="#6f8e83" font-family="Georgia, serif" letter-spacing="4">西湖</text>
          ${paths}
          ${dots}
          <g>
            <rect x="22" y="20" width="196" height="86" rx="2" fill="#fffdf8" stroke="#ece5d6" />
            <text x="36" y="42" font-size="10" fill="#a8873f" letter-spacing="2">ROUTE SCHEMATIC</text>
            ${DAY_COLORS.map((c, i) => `
              <line x1="36" y1="${60 + i * 16}" x2="58" y2="${60 + i * 16}" stroke="${c}" stroke-width="2.4"
                stroke-dasharray="${i === 0 ? '0' : i === 1 ? '7 5' : '3 4'}" />
              <text x="66" y="${63 + i * 16}" font-size="10.5" fill="#5c6b64">Day ${i + 1}</text>`).join('')}
          </g>
        </svg>
        <div class="map-bar">
          <div class="map-legend">
            ${DAY_COLORS.map((c, i) => `<span><i style="background:${c}"></i>Day ${i + 1}</span>`).join('')}
          </div>
          <span>${stops.length} 个站点已定位 · 0 个待补坐标</span>
        </div>
      </div>
      <div class="route-list">${routeLines}</div>
      <div class="map-actions">
        <button class="ghost-button" type="button" data-toast="已重新居中（原型示意）">居中所选日期</button>
        <button class="ghost-button" type="button" data-toast="已下载 route.svg（原型不产生真实文件）">下载路线图</button>
        <button class="ghost-button" type="button" data-toast="本原型未加载地图瓦片，线上版本使用高德栅格瓦片">切换底图</button>
      </div>
      <p class="map-note">
        坐标为模型估计或你手动定位的结果，未经地理编码核验，只用于示意路线；连线是示意弧线，不是真实导航轨迹。
        线上版本使用 Leaflet + 高德栅格瓦片（GCJ-02），拖动标点可手动修正位置并回写行程。
      </p>`;

    $$('[data-toast]', $('#panel-map')).forEach((b) => {
      b.addEventListener('click', () => toast(b.dataset.toast));
    });
  }

  function renderCalendar() {
    $('#panel-calendar').innerHTML = `
      <div class="cal-block">
        <div class="cal-card">
          <h4>下载 .ics 文件</h4>
          <p>把 12 个站点写成日历事件，导入 iOS 日历、Outlook 或 Google 日历。时间为浮动本地时间，跨时区不会错位。</p>
          <button class="primary-button" type="button" data-toast="已生成 huantu-8f2c1a.ics（原型不产生真实文件）">
            <span>下载 .ics</span><span class="arrow" aria-hidden="true">→</span>
          </button>
        </div>
        <div class="cal-card">
          <h4>在 Google 日历中创建</h4>
          <p>逐个站点打开 Google 的「创建事件」页面，由你本人登录并确认。寰途未获得授权，不会自动写入。</p>
          <button class="ghost-button" type="button" data-toast="需要你本人登录 Google 并确认">生成创建链接</button>
        </div>
        <div class="cal-card">
          <h4>直接写入手机日历</h4>
          <p>仅在本机模式可用，且每次写入前都会弹窗确认；写入后可一键删除本次创建的事件。</p>
          <button class="ghost-button" type="button" data-toast="原型不请求日历权限">连接日历</button>
        </div>
      </div>
      <p class="map-note">日历写入前必须由你本人确认。公开试用模式下该功能不开放。</p>`;

    $$('[data-toast]', $('#panel-calendar')).forEach((b) => {
      b.addEventListener('click', () => toast(b.dataset.toast));
    });
  }

  function renderSources() {
    const p = state.plan;
    $('#panel-sources').innerHTML = `
      <div class="source-list">
        ${p.sources.map((s) => `
          <div class="source">
            <div>
              <b>${s.label}</b>
              <small>${s.note}</small>
            </div>
            <span class="badge" data-s="${s.status === 'ok' ? 'ok' : 'unverified'}">
              ${s.status === 'ok' ? '已查询' : '待核实'}
            </span>
          </div>`).join('')}
      </div>
      <p class="map-note">
        每条时效信息都带查询时间或「待核实」标记。寰途不会把模型记忆当成实时事实；
        已接入实时搜索的部分，也请在出行前复核官方页面。
      </p>`;
  }

  function renderReplan() {
    $('#panel-replan').innerHTML = `
      <div class="replan-box">
        <h3>重新规划</h3>
        <p class="panel-note">已锁定的安排会尽量保留</p>
        <div class="chips chips-small" id="replanChips">
          <button type="button" class="chip" data-change="第二天遇到下雨，把户外行程改为室内备选">下雨改期</button>
          <button type="button" class="chip" data-change="整体放慢节奏，每天减少一个景点，增加休息时间">放慢节奏</button>
          <button type="button" class="chip" data-change="总预算下调 20%，酒店改到更经济的区域，行程保持">降低预算</button>
          <button type="button" class="chip" data-change="更换住宿区域到交通更便利的片区，并相应调整每日动线">换住宿区域</button>
          <button type="button" class="chip" data-change="增加一位同行老人，减少爬坡与长时间步行">加入同行人</button>
          <button type="button" class="chip" data-change="删除所有需要长时间排队的景点，改为小众替代">避开排队</button>
        </div>
        <form id="replanForm" style="margin-top:18px">
          <label class="field field-full" style="margin-top:0">
            <span>说明要改什么</span>
            <textarea id="replanText" rows="3"
              placeholder="例如：第二天下雨，把龙井茶园换成中国茶叶博物馆；整体预算降低 20%。"></textarea>
          </label>
          <div class="form-actions" style="margin-bottom:0">
            <p class="form-hint">重新规划会调用模型；锁定标记的日期或安排会被强制保留。</p>
            <button class="primary-button" type="submit">
              <span>重新规划</span><span class="arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </form>
        <div id="diffBox"></div>
      </div>`;

    $$('#replanChips .chip').forEach((c) => {
      c.addEventListener('click', () => {
        $('#replanText').value = c.dataset.change;
      });
    });

    $('#replanForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#replanText').value.trim();
      if (!text) { toast('请说明要改什么'); return; }
      await runReplan(text);
    });

    if (state.replanned) showDiff();
  }

  function showDiff() {
    const box = $('#diffBox');
    if (!box) return;
    box.innerHTML = `
      <div class="diff-box">
        <h4>本次改动</h4>
        <div class="diff-row"><span class="del">Day 2 · 16:00 中国丝绸博物馆</span></div>
        <div class="diff-row"><span class="add">Day 2 · 15:40 中国茶叶博物馆（双峰馆区）</span></div>
        <div class="diff-row"><span class="add">Day 2 · 17:20 茶山步道（可选，20 分钟）</span></div>
        <p style="font-size:12px;color:var(--text-soft);margin-top:8px">
          原因：11 月 16 日是周一，中国丝绸博物馆闭馆；茶叶博物馆周一开放，且与龙井村同一片区，顺路。
          其余 3 天保持不变。
        </p>
      </div>`;
  }

  async function runReplan(text) {
    setView('progress');
    $('#progressTitle').textContent = '正在按你的要求重排…';
    $('#progressDetail').textContent = `调整说明：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`;
    $('#cancelJob').hidden = true;
    const steps = $$('#stageList .stage');
    steps.forEach((li) => { li.dataset.state = ''; });
    steps[0].dataset.state = 'doing';
    await wait(900);
    steps[0].dataset.state = 'done';
    steps[1].dataset.state = 'doing';
    await wait(1100);
    steps[1].dataset.state = 'done';
    steps[2].dataset.state = 'done';
    steps[3].dataset.state = 'done';

    const d2 = state.plan.days[1];
    d2.items = d2.items.map((it) => (it.title === '中国丝绸博物馆'
      ? { time: '15:40', title: '中国茶叶博物馆（双峰馆区）', note: '免费，周一开放；从龙井村打车 10 分钟，与茶山同一片区。', dur: '80 分钟', move: '打车 10 分钟', lat: 30.2278, lng: 120.1120 }
      : it));
    d2.items.push({ time: '17:20', title: '茶山步道（可选）', note: '从博物馆后山走 20 分钟，能看到整片茶田，日落前后光线最好。', dur: '40 分钟', move: '步行 10 分钟', lat: 30.2232, lng: 120.1108 });
    state.replanned = true;

    renderAll();
    setView('result');
    setTab('replan');
    toast('已重新规划 · 3 处调整');
  }

  /* ------------------------------------------------------------------ *
   * 页签
   * ------------------------------------------------------------------ */

  function setTab(name) {
    state.tab = name;
    $$('#tabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }

  $$('#tabs .tab').forEach((t) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  /* ------------------------------------------------------------------ *
   * 访问码 / 模型设置 / Toast
   * ------------------------------------------------------------------ */

  $('#gateForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#accessCode').value.trim();
    const err = $('#gateError');
    if (code.length < 8) {
      err.textContent = '访问码至少 8 位（原型演示：随便输入 8 位即可进入）。';
      return;
    }
    err.textContent = '';
    toast('已授权 · 有效期 12 小时');
    setTimeout(() => setView('form'), 500);
  });

  function openSettings() {
    const dlg = $('#settings');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    $('#testResult').textContent = '';
    $('#testResult').classList.remove('is-ok');
  }

  $('#openSettings').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', () => $('#settings').close());

  $('#connect').addEventListener('click', async () => {
    const out = $('#testResult');
    out.classList.remove('is-ok');
    out.textContent = '正在连接 dashscope.aliyuncs.com…';
    await wait(1500);
    out.classList.add('is-ok');
    out.textContent = '连接成功 · qwen3.7-plus · 1,672ms · 密钥仅存于服务端内存';
    toast('连接成功');
  });

  $$('[data-toast]').forEach((el) => {
    el.addEventListener('click', () => toast(el.dataset.toast));
  });

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  renderAll();

  // 支持直接定位场景，便于评审时分享链接：index.html#result:map
  const hash = decodeURIComponent(location.hash.slice(1));
  const [view, tab] = hash.split(':');
  setView(['form', 'progress', 'result', 'gate'].includes(view) ? view : 'form');
  if (tab) setTab(tab);
})();
