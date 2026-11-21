# 寰途｜AI 智能旅行策划师

本机运行的旅行规划智能体。它先研究目的地（景点、片区、交通、季节、住宿区域），再生成逐日可执行行程，并能导出到手机日历、生成路线示意图。

这是一个**真实模型连接版**：所有行程由你在设置中配置的模型生成，接口失败会显示真实错误，**不会用固定模板冒充模型回复**。

项目基于 `知遇模型版` 的后端结构重建，但目录、代码、知识库与界面完全独立。

## 启动

需要 Node.js 22 或更高版本，无需安装任何第三方依赖。

```powershell
cd <项目目录>
node server.mjs
```

或双击/运行 `启动寰途.ps1`。浏览器打开 <http://127.0.0.1:8788>（仅监听本机）。

改端口：`$env:HUANTU_PORT=8790; node server.mjs`

## 让别人访问（公开试用模式）

公开模式是一条独立开关：`HUANTU_PUBLIC=1` + 访问码。打开后访客**只能建行程、看进度、看结果**，模型设置、模型地址、模型 ID 与密钥一律不可见，也不能改。

```powershell
$env:HUANTU_PUBLIC='1'
$env:HUANTU_ACCESS_CODE='请替换为至少12位随机访问码'
$env:HUANTU_PUBLIC_HOST='你的域名或隧道域名'
$env:HUANTU_PORT='8788'
node server.mjs
```

或直接运行 `启动-公网试用.ps1`（没给访问码会现场生成一个并只显示一次）。

### 先选一条路

| 场景 | 用法 | 对方要装什么 | 实测 |
| --- | --- | --- | --- |
| 在同一个 WiFi | `HUANTU_BIND_HOST=0.0.0.0` + 内网 IP 写进白名单 | 什么都不用装，开浏览器 | ✅ 已验证 `http://<LAN_IP>:8788` |
| 对方也在你的 Tailscale 网络 | `HUANTU_BIND_HOST=0.0.0.0` + Tailscale IP 写进白名单 | 装 Tailscale 并加入你的 tailnet | ✅ 已验证 `http://<TAILSCALE_IP>:8788` |
| 完全陌生人、要公网 HTTPS | Tailscale Funnel（一次点击启用）| 什么都不用装 | ⚠️ 需你在后台点一次启用 |
| 临时演示、能接受跳转页 | `npx localtunnel --port 8788` | 什么都不用装 | ⚠️ 可用但会掉线，且浏览器有「Tunnel website ahead」跳转页 |

最省事的是**同一个 WiFi**：谁都不用装东西。真要不认识的人也能访问，用 **Tailscale Funnel**，别用 localtunnel 做正式分享。

### 方式二：localtunnel 隧道（临时演示用，会掉线）

服务继续只监听 `127.0.0.1`，用隧道把它暴露出去：

```powershell
npx localtunnel --port 8788
```

隧道会打印一个域名（如 `abc.loca.lt`），把它（或直接写 `*.loca.lt`）填进 `HUANTU_PUBLIC_HOST` 再重启服务。**顺序很重要**：先知道域名，才能配白名单。

两点实测提醒：浏览器打开时会先看到「Tunnel website ahead」跳转页，需要填隧道密码（就是你的公网 IP）才能进；免费隧道隔一段时间会掉，不适合正式发给别人。

`HUANTU_PUBLIC_HOST` 支持两种写法，省掉反复重启：

```powershell
# 通配后缀：隧道每次换子域名都不用改配置
$env:HUANTU_PUBLIC_HOST='*.trycloudflare.com'

# 逗号分隔多个：局域网 IP 和隧道域名可以同时放行
$env:HUANTU_PUBLIC_HOST='<LAN_IP>, *.loca.lt'
```

### 方式一：同一局域网（最快，推荐）

不装任何隧道工具，两个人连同一个 WiFi 就行：

```powershell
$env:HUANTU_BIND_HOST='0.0.0.0'
$env:HUANTU_PUBLIC='1'
$env:HUANTU_ACCESS_CODE='至少12位'
$env:HUANTU_PUBLIC_HOST='<LAN_IP>'   # 换成你自己的内网 IP
node server.mjs
```

对方在浏览器打开 `http://<LAN_IP>:8788` 并输入访问码。用 `ipconfig` 查自己的 IPv4。注意：**只有同网段才行**，公司/校园网经常开了客户端隔离，这时改用方式三。

### 方式三：Tailscale Funnel（给不在同一网络的陌生人）

你机器上已经装了 Tailscale，Funnel 能给一个固定的 HTTPS 域名，对方什么都不用装。第一次需要在管理后台点一次启用：

```powershell
# 1. 拿到你的 ts.net 域名
tailscale status --json   # Self.DNSName，例如 desktop-xxxx.tail16f9f3.ts.net

# 2. 把它加进白名单并启动服务
$env:HUANTU_PUBLIC_HOST='<LAN_IP>, desktop-xxxx.tail16f9f3.ts.net'
$env:HUANTU_PUBLIC='1'; $env:HUANTU_ACCESS_CODE='至少12位'; $env:HUANTU_BIND_HOST='0.0.0.0'
node server.mjs

# 3. 开启 Funnel（第一次会提示去后台启用，点一下即可）
tailscale funnel 8788
```

也可以直接运行 `启动-公网隧道.ps1`，它会自动读域名、尝试开启、把启用链接打出来。

对方访问 `https://desktop-xxxx.tail16f9f3.ts.net`，输入访问码即可。关掉：`tailscale funnel reset`。

### 方式四：云服务器

```powershell
$env:HUANTU_BIND_HOST='0.0.0.0'   # 才真正监听公网网卡
$env:HUANTU_PUBLIC='1'
$env:HUANTU_ACCESS_CODE='...'
$env:HUANTU_PUBLIC_HOST='huantu.example.com'
```

必须放在 HTTPS 反向代理（Nginx / Caddy）后面，并把代理地址写进 `HUANTU_TRUSTED_PROXIES`，否则代理发来的 `X-Forwarded-Host` 会被忽略：

```nginx
location / {
  proxy_pass http://127.0.0.1:8788;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 300s;   # 生成一份方案可能要几分钟
}
```

不要把 `8788` 直接暴露到公网：http 明文会泄露访问码，且没有 TLS。

### 公开模式的边界

| 项目 | 行为 |
| --- | --- |
| 访问码（默认开启） | 未输入时，除 `/api/health`、`/api/public`、`/api/session` 外所有 API 返回 **401** |
| 访问码比对 | 只在服务端用 SHA-256 摘要做常量时间比较；不下发前端、不写日志、不进 `localStorage` |
| 访问会话 | 正确后下发 `huantu_access` Cookie：`HttpOnly` + `SameSite=Strict` + `Secure`（HTTPS 时）+ 2 小时过期 |
| 暴力尝试 | 同一来源连续失败 5 次 → 429，冷却 10 分钟 |
| 配置 | `/api/config`、`/api/test`、`/api/plan/import`、`/api/calendar/connect`、`/api/calendar/delete` 一律 403（**设不设访问码都一样**） |
| 状态 | `/api/state` 不返回 `baseUrl` / `model` / `protocol` / `role` / 错误详情，只有 `ready` 布尔值 |
| 额度 | 每会话 `HUANTU_MAX_CALLS` 次（有码默认 8、无码默认 4）。超出 429。每 IP 每天的额度默认关闭，需要时再开 |
| Host | 只接受 `localhost`、`127.0.0.1`、`::1`、`HUANTU_PUBLIC_HOST`，以及**可信代理**带来的 `X-Forwarded-Host`；其它一律 403 |
| 日历 | 保留"用户确认后才写入"的约束；公开模式干脆不开放写入接口 |
| 数据 | 任务与行程仍按会话隔离，换浏览器看不到别人的任务 |

#### 不设访问码（`HUANTU_PUBLIC_NO_CODE=1`）

```powershell
$env:HUANTU_PUBLIC='1'
$env:HUANTU_PUBLIC_NO_CODE='1'
$env:HUANTU_PUBLIC_HOST='你的公网IP或域名'
$env:HUANTU_BIND_HOST='0.0.0.0'
node server.mjs
```

打开后**任何人拿到网址就能生成行程，直接烧你的模型额度**。因此这个开关必须显式写出来——不写访问码又不写它，服务会拒绝启动，避免手一抖就裸奔。无码模式下的止损只有两条：

- 每会话 4 次调用（两次完整规划），默认值，可用 `HUANTU_MAX_CALLS` 改；
- 每 IP 每天的额度默认关闭；要开就设 `HUANTU_PUBLIC_IP_DAILY_CALLS=30` 之类。

按 IP 记账是针对"删 Cookie 换会话"的——换浏览器也绕不过去。但 NAT 后面多个真实用户会共用一个出口 IP，公共场所（学校/公司/咖啡店）容易互相挤占额度，这是无码模式的固有代价。

要恢复访问码：删掉 `HUANTU_PUBLIC_NO_CODE`，加上 `HUANTU_ACCESS_CODE`（≥12 位），重启即可，代码不用改。

## 部署到云服务器（已在跑的那台）

当前线上实例：

| 项目 | 值 |
| --- | --- |
| 地址 | <http://<云服务器公网IP>:8788> |
| 域名 | `<你的域名>`（已解析到该 IP，80 端口目前归同机的 ERPNext 用） |
| 模式 | 公开试用 · 无需访问码（每会话 2 次调用 / 每 IP 每天 6 次） |
| 进程 | systemd 服务 `huantu`，用户 `huantu`，开机自启 |
| 代码 | `<服务器部署目录>`（自带 Node 22，不依赖系统 Node） |
| 配置 | `/etc/huantu.env`（600，仅 root 可读） |
| 日志 | `journalctl -u huantu -f` |

### 一条命令更新代码

在本机 Git Bash 里：

```bash
bash deploy/deploy.sh <云服务器公网IP> 22 ubuntu
```

脚本会打包（排除截图/测试/本地数据）→ 上传 → 远程 `install.sh` → 外网自检。第三个参数是 SSH 用户，非 root 会自动套 `sudo`（要求 sudo 免密）。

只想替换代码不改配置：

```bash
scp -i <私钥> server.mjs ubuntu@<云服务器公网IP>:/tmp/
ssh -i <私钥> ubuntu@<云服务器公网IP> "sudo cp /tmp/server.mjs <服务器部署目录>/ && sudo chown huantu:huantu <服务器部署目录>/server.mjs && sudo systemctl restart huantu"
```

### 服务器上的注意点

- 这台机器同时跑着 **ERPNext（Docker）+ Caddy**，Caddy 占着 80/443。寰途刻意只用 **8788**，不和它抢端口，也没有改动 Caddy 的任何配置。
- 内存 3.6G，ERPNext 占了约 2G；寰途只吃 60–80MB，够用但别在机上再跑重东西。
- `curl` 里带中文路径的 `scp` 会失败（OpenSSH 在 Windows 下处理不了中文），先把文件复制到纯英文临时目录再传。

## 首次使用

1. 点右上角「模型设置」，填写：
   - **接口类型**：Chat Completions 或 Responses
   - **API 基础地址**：填到版本路径，例如 `https://api.openai.com/v1`，不要带 `/chat/completions` 或 `/responses`
   - **模型 ID**：服务商账号实际可用的模型名
   - **指令角色**：多数兼容服务用 `system`，部分 OpenAI 新模型用 `developer`
   - **API 密钥**：只提交给本机后端
2. 点「保存并测试连接」。测试会发送一条不含个人数据的请求，可能产生少量费用。
3. 状态变为「已验证」后，填写旅程需求并「开始规划」。

密钥只存在于 Node 进程内存：不返回网页、不进浏览器存储、不写磁盘、不写日志。**服务重启后需重新填写**；`.data/config.json` 只保存地址、模型名、接口类型与角色。

## 已实现

| 模块 | 内容 |
| --- | --- |
| 需求表单 | 出发地、目的地、日期、天数、人数（含儿童）、预算、16 个兴趣标签（最多 8 个）、节奏、交通偏好、酒店偏好、特殊需求 |
| 两阶段生成 | ①研究目的地（概览、景点、小众、活动、美食、咖啡、交通、季节、人群适配、酒店、片区逻辑）→ ②排每日动线。长方案不再一次性输出，避免撞上中转网关的时限 |
| 异步任务队列 | `POST /api/jobs` 建任务后立即返回 jobId（实测 28 毫秒），后台依次跑「研究 → 编排」，前端每 2 秒轮询状态：`pending → researching → planning → completed / failed / cancelled`。可取消，取消会真正中止上游模型请求 |
| 流式接收 | 模型响应走 SSE 累积文本，用「空闲超时」判断卡死；服务端不支持流式时自动回退普通 JSON |
| 目的地洞察 | 景点、小众去处、特色活动、美食、餐厅与咖啡馆、交通方式、季节与天气常识、适合亲子/情侣/长辈/独自的内容 |
| 酒店建议 | 名称、片区、价格区间、评分、距景点、距交通枢纽、适合人群、推荐理由、需自行核实项；**不代订、不付款** |
| 每日行程 | Day N + 日期 + 星期 + 主题 + 时间轴（开始/结束/停留时长）+ 景点顺序 + 段间交通方式与耗时 + 三餐 + 休息 + 自由时间 + 雨天备选 |
| 动态调整 | 增删景点、换酒店区域、改预算、改日期、改节奏、下雨、加同行人。「锁定这一天」与「锁定单项」都会在重新规划时被服务端强制保留；普通调整复用已有研究只重排行程，涉及住宿/预算才重做研究 |
| 导出 | 打印 / 存为 PDF（打印时自动展开全部分区）、导出 JSON、下载 SVG 路线图、下载 `.ics` |
| 导入 | 导入寰途自己导出的 JSON（备份恢复 / 换机迁移），导入时不调用模型，并强制把时效信息重新标为「待核实」 |
| 手机日历 | 标准 `.ics`（含 30 分钟提醒，浮动本地时间）+ Google Calendar 逐条/整段创建链接；OAuth 未配置时明确显示「尚未授权」 |
| 可视化 | 后端生成 SVG 旅程图（目的地、日期、每日主题、节点顺序、交通耗时、住宿参考）+ 每日时间轴卡片 + 路线说明，可下载 |
| 路线地图 | 结果页「路线地图」页签：Leaflet 本地化（无 CDN）+ 高德底图，站点按天着色、示意连线、可编辑时间轴联动、缺坐标站点手动定位、断网自动降级为本地网格；坐标只标来源不猜测（GCJ-02） |
| 交互原型 | `/prototype`（或 `public/prototype/index.html` 双击离线打开）：可点击的完整交互演示，覆盖表单→进度→结果 8 页签→重新规划→访问码→模型设置；零依赖零网络请求，支持 `#result:map` 直达；接口契约见《交互接入说明.md》 |
| 真实性 | 模型自报的查询时间会被丢弃；实时天气和搜索结果会记录真实读取时间，但票价、房价、营业时间、班次仍保留“待核实”边界 |
| 搜索知识库 | 搜过的景点票价、酒店评价、交通公告、配图全部落盘（`<dataDir>/library/`，一城一文件）。下次同城同问**零联网直接命中**；条目分 `fresh / stale / expired` 三档，过期的自动重搜覆盖；行程定稿后模型确认过的事实也会回写。前端「知识库」页签可查看、整城重搜、单条标废/删除 |
| 隐私 | 只收集规划字段；行程只存在进程内存；一键「清除旅行记录」；模型输出 HTML 被剥离且以纯文本渲染；仅监听 127.0.0.1 |

## 尚未实现（需要外部配置）

| 能力 | 现状 | 需要什么 |
| --- | --- | --- |
| 实时搜索 | **已实现适配器**：`auto` 会按顺序尝试免密钥来源，也支持 DeepSeek、博查、智谱、Tavily、Serper、SearXNG；是否可用取决于网络、服务和密钥 | 云端建议配置正规搜索 API，并以结果页来源复核 |
| 实时天气 | **已实现** Open-Meteo（免 key）；超出预报范围会降级为去年同期气候参考 | 无；无外网时可设 `HUANTU_WEATHER=off` |
| 地图与真实路线 | SVG 为示意图；地图页签用高德底图 + 手动定位兜底 | `HUANTU_MAPS_API_KEY` + 路径规划接口 |
| 酒店库存/价格 | 未接入，价格恒为「待核实」 | `HUANTU_HOTELS_API_KEY` 或联盟 API |
| Google Calendar 直连写入 | **尚未授权**，当前只有 ICS + 创建链接 | `HUANTU_GOOGLE_CLIENT_ID` / `HUANTU_GOOGLE_CLIENT_SECRET` + OAuth 回调 + 逐次写入确认 |
| Apple Calendar 直连 | 不支持（Apple 无网页端写入 API） | 走 `.ics` 导入 |
| 账号体系 | 未做 | 公开模式只有「一个共享访问码」，没有独立账号、用量账单与封禁名单 |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `HUANTU_PORT` | 端口，默认 8788 |
| `HUANTU_API_BASE_URL` | 默认模型地址（可被页面设置覆盖） |
| `HUANTU_MODEL` | 默认模型 ID |
| `HUANTU_API_KEY` | 默认密钥（仅内存） |
| `HUANTU_PROTOCOL` | `chat-completions` 或 `responses` |
| `HUANTU_ROLE` | `system` 或 `developer` |
| `HUANTU_MAX_CALLS` | 单会话模型调用上限，默认 20（一次完整规划消耗 2 次，普通重规划 1 次） |
| `HUANTU_PLAN_WAIT_MS` | 兼容接口 `/api/plan` 的最长等待，默认 20000；超过即返回 202 + jobId |
| `HUANTU_QUEUE` | `memory`（默认）或 `redis`（当前会明确报 501，未实现） |
| `HUANTU_MODEL_TIMEOUT_MS` | 单次模型请求总时长上限，默认 240000 |
| `HUANTU_MODEL_IDLE_MS` | 多久没收到任何数据算卡死，默认 75000 |
| `HUANTU_AUTO_VERIFY=1` | 启动时自动做一次连通性验证 |
| `HUANTU_ALLOW_LOCAL_UPSTREAM=1` | 仅联调用：允许 `http://127.0.0.1` 的模型地址 |
| `HUANTU_PUBLIC=1` | 打开公开试用模式：访客只读 |
| `HUANTU_ACCESS_CODE` | 访问码，公开模式下**至少 12 位**；不设它时必须显式写 `HUANTU_PUBLIC_NO_CODE=1`，否则拒绝启动 |
| `HUANTU_PUBLIC_NO_CODE=1` | 明确「不要访问码」。任何人拿到网址就能用，只保留每会话 / 每 IP 额度止损 |
| `HUANTU_PUBLIC_IP_DAILY_CALLS` | 每个来源 IP 每天最多几次模型调用，**默认 0（关闭）**。需要止损时再开，例如 30 |
| `HUANTU_PUBLIC_HOST` | 访客使用的域名或隧道域名（Host 白名单里唯一允许的外部主机） |
| `HUANTU_BIND_HOST` | 监听地址，默认 `127.0.0.1`；设为 `0.0.0.0` 才会绑公网网卡 |
| `HUANTU_TRUSTED_PROXIES` | 可信反向代理地址，默认 `127.0.0.1,::1`；只有它们发来的 `X-Forwarded-Host` / `X-Forwarded-Proto` 才被采信 |
| `HUANTU_ACCESS_TTL_MS` | 访问码换来的 Cookie 有效期，默认 7200000（2 小时） |
| `HUANTU_SEARCH_API_KEY` / `HUANTU_MAPS_API_KEY` / `HUANTU_HOTELS_API_KEY` / `HUANTU_WEATHER_API_KEY` | 预留，配置后 `/api/state` 的 `adapters` 会显示 `configured` |
| `HUANTU_AMAP_KEY` | 高德 Web 服务 key（个人免费 5000 次/日）。配置后站点坐标自动补全走高德 POI 搜索（GCJ-02 原生）；不配则用 Nominatim 兜底（限 4 个点位、串行） |
| `HUANTU_GEOCODE` | 坐标补全开关，默认 `on`；设 `off` 跳过 50km 校验与地理编码（无外网机器用） |
| `HUANTU_FETCH_BODY` | 研究阶段是否抓取搜索结果页面的正文，默认 `on`；设 `off` 只用摘要（更快、更省流量） |
| `HUANTU_FETCH_MAX` | 每次生成最多抓几篇正文，默认 6，上限 12。每篇限 2MB / 8 秒 |
| `HUANTU_LIBRARY` | 搜索知识库开关，默认 `on`；设 `off` 每次都现搜（不复用） |
| `HUANTU_LIBRARY_TTL_SEARCH` / `_SPOT` / `_PHOTO` / `_DIGEST` | 各类条目的保质期（天），默认 7 / 14 / 30 / 30。过期后先进 `stale` 宽限期（3 倍 TTL，先用旧值），再久就必须重搜 |
| `HUANTU_GOOGLE_CLIENT_ID` / `HUANTU_GOOGLE_CLIENT_SECRET` | 预留 OAuth |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（不含密钥；公开模式下只返回 `{ok, service, public}`） |
| GET | `/api/public` | 公开模式入口：是否需要访问码、是否已授权、CSRF |
| POST | `/api/session` | 用访问码换短期 HttpOnly Cookie |
| POST | `/api/session/logout` | 清除访问 Cookie |
| GET | `/api/state` | 配置状态、日历状态、适配器状态、CSRF（公开模式下不含模型地址/ID/密钥） |
| POST | `/api/config` | 保存模型配置（非秘密字段落盘） |
| POST | `/api/test` | 真实连通性测试 |
| DELETE | `/api/config` | 清除内存中的密钥 |
| POST | `/api/plan` | 兼容接口：建任务并最多等 `HUANTU_PLAN_WAIT_MS`（默认 20 秒）；完成返回 200 + plan，超时返回 202 + jobId |
| POST | `/api/replan` | 同上，按修改要求重新规划（默认复用研究，只重排行程；保留锁定项） |
| POST | `/api/jobs` | 建异步规划任务，立即返回 202 + jobId |
| GET | `/api/jobs` | 本会话最近的任务列表 |
| GET | `/api/jobs/:id` | 查询状态、阶段、耗时、错误 |
| GET | `/api/jobs/:id/result` | 取完成后的方案（未完成 409） |
| POST | `/api/jobs/:id/cancel` | 取消任务并中止上游请求 |
| GET | `/api/plan/latest` | 取当前会话最近方案 |
| DELETE | `/api/plan` | 清除本会话全部行程 |
| POST | `/api/calendar/ics` | 下载 `.ics` |
| POST | `/api/calendar/google` | 生成 Google 创建链接 |
| POST | `/api/calendar/status` | 日历状态 |
| POST | `/api/calendar/connect` | 尝试授权直连（未配置时 501，不伪造已连接） |
| POST | `/api/calendar/delete` | 删除事件，必须 `confirm:true` |
| POST | `/api/visual/svg` | 生成 SVG 路线图 |
| POST | `/api/visual/map` | 交互地图站点数据（含坐标来源与缺失清单） |
| POST | `/api/plan/export` | 导出 JSON |
| POST | `/api/plan/import` | 导入 JSON（清洗 + 重新标注，不调用模型） |
| GET | `/api/library` | 搜索知识库：不带参数返回全库统计与城市列表；`?city=杭州` 返回该城条目；`&kind=spot` 可过滤 |
| POST | `/api/library/refresh` | 把条目标记为过期（下次生成重搜）。带 `{city,kind,key}` 废一条，只带 `{city}` 废整城 |
| DELETE | `/api/library/item` | 删除一条 `{city,kind,key}` |

## 测试

```powershell
npm test
# 或
node --test
```

154 个子用例（`server` 19 + `jobs` 14 + `public` 11 + `geo` 19 + `fetch` 14 + `realtime` + `map` + `library` 13 + `library-flow` 6 等覆盖：首页可打开、表单可提交、未配置模型报清晰错误、两种协议请求格式、**流式 SSE 拼接与截断识别**、密钥不外泄（响应/磁盘/页面/日志）、输入校验、CSRF 与跨站拦截、时效字段不被伪造、模型 HTML 被剥离、ICS 格式（CRLF/75 字节折行/转义/UID/提醒/UTC 换算）、Google 链接参数与**出境时区折算**、SVG 节点数与「非实时地图」标注、日历状态不可伪造、删除需确认、重新规划保留锁定项与两阶段调用次数、导入还原、清除记录。

公开模式部分覆盖：**未授权一律 401**、入口接口不泄露模型信息、访问码错误 401 与连续失败限流、Cookie 的 `HttpOnly/SameSite=Strict/Secure/Max-Age` 属性、**访客改配置一律 403**、公开 state 不含 `baseUrl/model/protocol/role/lastError`、Host 白名单（含配置域名、带端口、可信代理 `X-Forwarded-Host`、伪造代理被拒）、CSRF 仍生效、**会话隔离**（换会话看不到别人的任务）、**调用上限 429**、访问码与密钥不进页面/脚本/日志/`localStorage`、不足 12 位访问码拒绝启动。

任务队列部分覆盖：创建任务立即返回、阶段轮询（`researching → planning → completed`）、完成后取结果、**研究阶段失败**、**行程阶段失败**、**取消任务**（含上游请求被中止）、同一会话并发限制、`/api/plan` 超时返回 202、任务按会话隔离、密钥不泄露、内存队列与 Redis 占位的边界行为。

知识库部分覆盖：键归一化（「日本京都」「京都府」同一桶）、写入/读取/重启后仍在、原子写不留临时文件、fresh/stale/expired 三档判定、手动作废必须重搜、重复写入只更新不新增、单城超量按「最久没用」淘汰、**第一次联网入库 → 第二次零联网命中**、换城市不误命中、关掉搜索时库里旧账仍可用、配图二次不再抓页面、`/api/library` 列表与标废/删除接口。

测试使用本机模拟兼容服务，**不证明你的真实 API 可用**；只有设置页真实请求成功才算已连接。真实模型的验收记录见 `验收记录.md`。

## 目录

```
寰途更新分支-20261117/
├─ server.mjs            后端（校验、模型调用、任务调度、规范化、ICS、Google 链接、SVG）
├─ queue.mjs             任务队列（内存实现 + Redis 占位）
├─ public/
│  ├─ index.html         首页 + 结果页 + 设置弹窗
│  ├─ style.css          深墨绿 / 米白 / 金色，移动端优先
│  ├─ app.js             渲染与交互（模型文本一律 textContent）
│  └─ favicon.svg
├─ knowledge/
│  ├─ travel-rules.md    策划规则与输出 JSON 结构（写入模型指令）
│  ├─ destinations.md    目的地知识库（按 ## 段落检索）
│  └─ sources.md         来源与核验政策
├─ tests/
│  ├─ server.test.mjs    接口与真实性
│  ├─ jobs.test.mjs      异步任务队列
│  └─ public.test.mjs    公开模式与访问码
├─ README.md
├─ 启动寰途.ps1          本机模式
├─ 启动-公网试用.ps1     公开试用模式（隧道 / 云服务器）
├─ 启动-公网隧道.ps1     Tailscale Funnel 一键开启
├─ 验收记录.md
├─ 验收截图/             真实渲染截图（桌面 + 移动端）
└─ .data/                仅存非秘密配置（自动生成，勿提交）
```

## 已知限制

- 没有实时数据源时，模型给的价格、营业时间、班次只能作为"知识性估计"，界面统一标「待核实」。这是刻意设计，不是缺陷。
- `.ics` 使用浮动本地时间，导入到别的时区设备时请核对。时区按目的地推断（含出境常见城市），可在请求里用 `input.timezone` 覆盖。
- SVG 是行程数据的示意图，不是地图，不带地理坐标。
- 单进程内存会话：重启后行程丢失，静态配置保留；可用「导出 JSON → 导入」恢复。
- **任务队列同样是进程内存**：重启后未完成的任务会丢失，需要重新提交。Redis 适配器只留了接口（`HUANTU_QUEUE=redis` 会明确报 501），没有半成品实现。
- 生成较慢的模型（单次 1–2 分钟）依赖流式才不会被网关掐断；若服务商完全不支持流式，仍按普通 JSON 解析，但容易撞上中转的 120 秒限制。任务队列解决的是「浏览器不用一直等」，不改变模型本身的生成速度。
- **公开模式是一个共享访问码，不是账号体系**：所有拿到码的人共用一个身份池，没有独立用量账单、没有封禁名单。要真正对外运营，还需要账号、每用户配额与服务条款。
- 公开模式区分「访问码」和「会话」两层：访问码决定能不能用，`huantu_sid` 决定看得到谁的数据。**别把同一个浏览器会话分享出去**，否则对方会看到该会话的行程。
