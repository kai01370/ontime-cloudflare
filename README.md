# 准点到达 OnTime · Cloudflare Pages 版（免费永久部署）

把原 FastAPI 后端**完整移植成 Cloudflare Pages Functions**：
- 前端零改动（仍只调 `/api/plan`、`/api/suggest`，函数服务端拦截）。
- 高德 / OpenWeather 的 Key 放在 Cloudflare 环境变量里，**不进前端、不进仓库**，绕开浏览器 CORS。
- 免费、永久在线、无需备案、国内可访问（比 HF Spaces 稳）。

> 与原 Python 版的差异：内部流程缓冲用**规则版**替代 LLM 调用（避免 LLM 长超时/Key 依赖，更适配免费层）。其余逻辑（高德地理编码/路径/公交真实票价与首末班、天气缓冲、倒推最晚出发）完全一致。

## 目录结构
```
ontime-cloudflare/
├── public/index.html        # 前端（从原 static/index.html 拷贝，自包含单文件）
├── functions/
│   ├── _lib.mjs             # 核心逻辑（地理编码/路径/公交首末班/天气/倒推）
│   ├── api/plan.js          # POST /api/plan
│   └── api/suggest.js       # GET  /api/suggest
├── wrangler.toml           # Pages 构建配置（密钥不放这里）
└── .gitignore
```

## 部署步骤（推荐：控制台，无需装 CLI、无审核）

1. **建 GitHub 仓库**，把本目录内容推上去。
2. 打开 Cloudflare 控制台 → **Workers 和 Pages** → **创建** → **Pages** → 连接 GitHub，选择该仓库。
3. 构建设置：
   - Framework preset：**None**
   - Build command：**留空**
   - Build output directory：**`public`**
4. **设置环境变量（关键）**：项目 → **Settings → Environment variables**，添加（建议勾选 Encrypt）：
   - `MAP_KEY` = 你的高德 Web 服务 Key（必填，否则进入演示模式）
   - `WEATHER_KEY` = OpenWeather Key（选填，留空则天气用模拟）
   - 变量作用域选 **Production**（和 Preview 都加也行）。
5. 保存并 **Deploy**。几秒后得到 `https://<项目名>.pages.dev`，**免费、永久、别人随时能打开**。

## 部署步骤（可选：wrangler CLI）
```bash
npm i -g wrangler
wrangler login
echo "你的高德Key" | wrangler pages secret put MAP_KEY --project-name ontime
# 选填：echo "OpenWeatherKey" | wrangler pages secret put WEATHER_KEY --project-name ontime
wrangler pages deploy public --project-name ontime
```

## 自定义域名（可选，无备案）
- 域名若在 **Cloudflare 注册**（或把 DNS 转到 Cloudflare）：项目 → **Custom domains** 添加即可，**无需 ICP 备案**。
- 国内注册商买的 `.cn` 等域名：解析到 Cloudflare 后仍需 **ICP 备案**（约 1–3 周）才合规。
- 不想备案又想用国内域名：可在国外注册商（Namecheap 等）买 `.com/.xyz`，DNS 用 Cloudflare，同样免备案。

## 前端同步说明
`public/index.html` 是原 `static/index.html` 的拷贝。若以后改了原前端，记得重新拷贝覆盖本目录的 `public/index.html` 再重新部署。

## 免费额度与注意
- Pages 免费：约 500 次构建/月、10 万次请求/天，个人作品集足够。
- 高德 Web 服务免费额度约 2000 次/天；函数内已做地理编码缓存以减少重复调用。
- 国内访问经 Cloudflare 香港/周边节点，比 HF Spaces 稳，但极致国内速度仍建议用国内轻量服务器。
