# OnTime · 准点到达

> **截止时间驱动的出行规划工具** —— 输入航班/高铁/面试时间，自动倒推「最晚几点必须出门」。

[![在线体验](https://img.shields.io/badge/在线体验-ontime--cloudflare.pages.dev-blue)](https://ontime-cloudflare.pages.dev)
[![部署](https://img.shields.io/badge/部署-Cloudflare%20Pages-orange)](https://ontime-cloudflare.pages.dev)

## 一句话介绍

传统地图回答「现在走，几点到」；OnTime 回答「必须几点到，最晚几点走」——专为赶飞机、高铁、面试等**硬 deadline 场景**设计。

## 核心功能

- **截止时间逆推**：输入终点与截止时间，自动计算各出行方式的「最晚出发时刻」。
- **6 种出行方式**：公交 / 地铁 / 打车 / 自驾 / 步行 / **骑行**。
- **真实耗时与票价估算**：接入高德路径规划 API，里程/耗时来自真实数据；票价按城市规则估算（如北京地铁机场线已修正为真实票价）。
- **首末班检测 + 兜底提示**：基于各线路首末班时刻，凌晨无车时自动提示风险。
- **场景缓冲与误车预警**：按飞机/高铁/面试等场景自动预留缓冲，临近 deadline 时给出误车风险提醒。

## 在线体验

**https://ontime-cloudflare.pages.dev**

> 在国内可直接访问，无需备案，免费永久在线。

## 技术栈

- **前端**：原生 HTML/CSS/JS 单文件（`public/index.html`）
- **后端**：Cloudflare Pages Functions（边缘函数 `functions/api/*.js`）
- **数据**：高德地图 Web 服务 API（地理编码 / 路径规划 / 首末班）
- **部署**：Cloudflare Pages（免费、永久、国内可达、无需备案）

## 目录结构

```
ontime-cloudflare/
├── public/index.html        # 前端单文件
├── functions/
│   ├── _lib.mjs             # 核心逻辑（地理编码 / 路径 / 首末班 / 倒推 / 票价修正）
│   ├── api/plan.js          # POST /api/plan
│   └── api/suggest.js       # GET  /api/suggest（地址联想）
├── wrangler.toml
└── .gitignore
```

## 本地开发与部署

### 控制台部署（推荐，无需 CLI）

1. Fork / 推送本仓库到 GitHub。
2. Cloudflare 控制台 → **Workers 和 Pages** → **创建 Pages** → 连接该仓库。
3. 构建设置：
   - Framework preset：**None**
   - Build command：**留空**
   - Build output directory：**`public`**
4. **设置环境变量**：`Settings → Environment variables`
   - `MAP_KEY` = 高德 Web 服务 Key（必填）
   - `WEATHER_KEY` = OpenWeather Key（选填）
5. 保存并 Deploy，几秒后获得 `https://<项目名>.pages.dev`。

### wrangler CLI 部署

```bash
npm i -g wrangler
wrangler login
wrangler pages project create ontime
wrangler pages secret put MAP_KEY --project-name ontime
# 可选：wrangler pages secret put WEATHER_KEY --project-name ontime
wrangler pages deploy public --project-name ontime
```

## 项目演进

- 最初为 Python FastAPI 本地原型；
- 为免备案、永久在线，将后端完整移植为 Cloudflare Pages Functions；
- 迭代修复北京地铁机场线票价、凌晨首末班兜底、打车真实里程计价、城市歧义等问题；
- 新增骑行方式，扩展为 6 种出行方式对比。

## License

MIT
