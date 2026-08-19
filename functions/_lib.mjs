// OnTime 核心逻辑（Cloudflare Pages Functions 版）
// 忠实移植自 FastAPI 版 app.py；用规则版内部缓冲替代 LLM 调用，以适配免费层（无超时/Key 依赖）。
// 高德 / OpenWeather 的 Key 通过 env 注入，函数服务端调用，前端零 Key、绕开 CORS。

export const MODES = ["打车", "地铁", "公交", "步行", "自驾"];

const SPEED = { "打车": 28, "自驾": 30, "地铁": 24, "公交": 17, "步行": 4.5, "骑行": 14 };
const EXTRA = { "打车": 3, "自驾": 2, "地铁": 10, "公交": 6, "步行": 0, "骑行": 0 };

// ---------- 工具 ----------
export function hashStr(s) {
  // FNV-1a 32bit，确定性伪随机（用于演示模式降级）
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pad(n) { return String(n).padStart(2, "0"); }
function hhmm(dt) { return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`; }
function fmtLeave(dt) { return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`; }
function toLocalISO(dt) {
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}
function parseDeadline(str) {
  const [datePart, timePart] = str.split(/[ T]/);
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = (timePart || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

async function getJSON(url, timeout = 10000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return await r.json();
}

// ---------- 演示降级 ----------
function fakeDistance(a, b) { return 4 + (hashStr(`${a}->${b}`) % 36); } // 4..39 km
function simRoute(a, b, mode) {
  const d = fakeDistance(a, b);
  return Math.round(d / SPEED[mode] * 60 + EXTRA[mode]);
}
function estPrice(mode, km) {
  km = Math.max(0, km);
  if (mode === "打车") return Math.round(13 + 2.6 * km) || 13;
  if (mode === "自驾") return Math.round(0.6 * km + 5);
  if (mode === "地铁") return Math.round(Math.min(3 + Math.max(0, km - 6) * 0.4, 11));
  if (mode === "公交") return Math.round(Math.min(2 + Math.max(0, km - 10) * 0.2, 4));
  return 0;
}
function estTransfers(mode, routeMins) {
  if (["打车", "自驾", "步行"].includes(mode)) return 0;
  if (mode === "地铁") return routeMins <= 35 ? 0 : (routeMins <= 62 ? 1 : 2);
  if (mode === "公交") return routeMins <= 30 ? 0 : (routeMins <= 58 ? 1 : 2);
  return 0;
}

// 出租车标准计价估算（基于真实里程，比线性估算更接近实际）
// 北京规则：3km内13元，超出2.3元/km，15km后超出部分加收50%空驶费，时长按约0.5元/分钟计
function taxiFare(city, km, mins) {
  km = Math.max(0, km); mins = Math.max(0, mins);
  let base, perKm, emptyAfter;
  const c = (city || "");
  if (c.includes("北京")) { base = 13; perKm = 2.3; emptyAfter = 15; }
  else if (c.includes("上海")) { base = 14; perKm = 2.5; emptyAfter = 15; }
  else if (c.includes("广州") || c.includes("深圳")) { base = 10; perKm = 2.6; emptyAfter = 25; }
  else { base = 13; perKm = 2.3; emptyAfter = 15; } // 通用默认值
  let fare = base;
  const extra = Math.max(0, km - 3);
  fare += extra * perKm;
  if (km > emptyAfter) fare += (km - emptyAfter) * perKm * 0.5;
  fare += mins * 0.5; // 低速等候费（简化）
  return Math.round(fare);
}

// 北京普通地铁票价（不含机场线），按里程阶梯计价
function beijingSubwayFare(km) {
  if (km <= 6) return 3;
  if (km <= 12) return 4;
  if (km <= 22) return 5;
  if (km <= 32) return 6;
  return 6 + Math.ceil((km - 32) / 20);
}

// 对北京含大兴机场线的地铁路线，按真实计价规则修正票价
function fixBeijingAirportSubwayPrice(rawPrice, totalKm, lineNames) {
  if (rawPrice == null || totalKm == null) return rawPrice;
  const hasDaxingAirportLine = lineNames.some(n => /大兴机场线/.test(n));
  if (!hasDaxingAirportLine) return rawPrice;
  // 大兴机场线（草桥-大兴机场）全长约 41 km，固定票价 35 元
  const normalKm = Math.max(0, totalKm - 41);
  const normalFare = normalKm <= 3 ? 0 : beijingSubwayFare(normalKm);
  return 35 + normalFare;
}

// ---------- 高德 ----------
const geoCache = new Map(); // 同 isolate 内缓存地理编码，省免费额度（key 含城市提示以消歧义）

export async function amapGeocode(addr, env, cityHint) {
  if (!env.MAP_KEY) return null;
  const key = addr + "|" + (cityHint || "");
  if (geoCache.has(key)) return geoCache.get(key);
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${env.MAP_KEY}&address=${encodeURIComponent(addr)}` +
    (cityHint ? `&city=${encodeURIComponent(cityHint)}` : "");
  let res = null;
  try {
    const d = await getJSON(url, 10000);
    const g = d?.geocodes?.[0];
    if (g) res = { location: g.location, city: g.city || g.adcode || "", citycode: g.citycode || "" };
  } catch (e) { /* ignore */ }
  geoCache.set(key, res); // 失败也缓存，避免同 plan 内反复打高德
  return res;
}

async function amapRoute(o, d, maptype, env) {
  const url = `https://restapi.amap.com/v3/direction/${maptype}?key=${env.MAP_KEY}&origin=${o}&destination=${d}`;
  try {
    const data = await getJSON(url, 10000);
    const p = data?.route?.paths?.[0];
    if (p?.duration) {
      const tolls = p.tolls != null ? parseInt(p.tolls) : null;
      const distance = p.distance != null ? parseInt(p.distance) : null;
      return [Math.round(parseInt(p.duration) / 60), tolls, distance];
    }
  } catch (e) { /* ignore */ }
  return [null, null, null];
}

function lineShort(name) {
  const n = (name || "").split("(")[0].trim();
  const m = n.match(/(\d+号线)/) || n.match(/(\d+路)/);
  return m ? m[1] : n;
}
function fmtHm(t) {
  t = (t || "").trim();
  if (/^\d{4}$/.test(t)) return `${t.slice(0, 2)}:${t.slice(2)}`;
  if (/^\d{3}$/.test(t)) return `0${t[0]}:${t.slice(1)}`;
  return t;
}
function parseTipsTime(tips) {
  if (!tips) return null;
  const m = tips.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${parseInt(m[1]).toString().padStart(2, "0")}:${m[2]}`;
  return null;
}
function parseTips(tips) {
  if (!tips) return [null, null, null];
  const t = parseTipsTime(tips);
  if (!t) return [null, null, tips];
  // 只有明确含“首/末”才认为是首末班时刻；“预计到站”等不是末班时间
  if (/首/.test(tips)) return [t, null, tips];
  if (/末/.test(tips)) return [null, t, tips];
  return [null, null, tips];
}

async function amapTransit(o, d, cc1, cc2, strategy, env) {
  const url = `https://restapi.amap.com/v5/direction/transit/integrated?key=${env.MAP_KEY}` +
    `&origin=${o}&destination=${d}&city1=${cc1}&city2=${cc2}&strategy=${strategy}&show_fields=cost,duration`;
  try {
    const data = await getJSON(url, 10000);
    const tr = (data?.data || data)?.route?.transits;
    if (tr?.length) {
      const t = tr[0];
      const cost = t.cost || {};
      const dur = cost.duration;
      if (dur != null) {
        const mins = Math.max(1, Math.round(parseInt(dur) / 60));
        const fee = cost.transit_fee;
        let price = fee != null ? parseInt(fee) : null;
        const totalDistanceKm = parseInt(t.distance || 0) / 1000;
        const lines = [];
        const lineDetails = [];
        let cumOffset = 0;
        for (const s of t.segments || []) {
          cumOffset += parseInt(s?.walking?.cost?.duration || 0);
          const bl = s?.bus?.buslines?.[0];
          if (!bl) continue;
          const sn = lineShort(bl.name || "");
          if (sn) lines.push(sn);
          let start = bl.station_start_time || bl.start_time || "";
          let end = bl.station_end_time || bl.end_time || "";
          const tips = bl.bus_time_tips || "";
          let timeSource = "fixed";
          if ((!start || !end) && tips) {
            const [ts, te] = parseTips(tips);
            if (!start && ts) { start = ts; timeSource = "tips"; }
            if (!end && te) { end = te; timeSource = "tips"; }
          }
          const busDur = parseInt(bl.cost?.duration || 0);
          lineDetails.push({
            short_name: sn, full_name: bl.name || "", type: bl.type || "",
            departure: bl.departure_stop?.name || "", arrival: bl.arrival_stop?.name || "",
            start: fmtHm(start), end: fmtHm(end), tips, time_source: timeSource,
            boarding_offset: cumOffset, duration: busDur,
          });
          cumOffset += busDur;
        }
        price = fixBeijingAirportSubwayPrice(price, totalDistanceKm, lines);
        return [mins, price, lines.length ? lines.join(" → ") : null, lineDetails];
      }
    }
  } catch (e) { /* ignore */ }
  return [null, null, null, []];
}

async function segMode(a, b, mode, city, env) {
  if (!env.MAP_KEY) {
    const d = simRoute(a, b, mode);
    return [d, estPrice(mode, d / 60 * SPEED[mode]), "sim", "sim", null, []];
  }
  try {
    if (["打车", "自驾", "步行"].includes(mode)) {
      const maptype = { "打车": "driving", "自驾": "driving", "步行": "walking" }[mode];
      const o = await amapGeocode(a, env, city), d = await amapGeocode(b, env, city);
      if (o?.location && d?.location) {
        const [m, tolls, distance] = await amapRoute(o.location, d.location, maptype, env);
        if (m) {
          const km = distance != null ? distance / 1000 : (m / 60 * SPEED[mode]);
          let price, psrc;
          if (mode === "打车") {
            price = taxiFare(city, km, m); psrc = "est";
          } else if (mode === "自驾") {
            const fuel = Math.round(0.6 * km);
            if (tolls) { price = tolls + fuel; psrc = "real"; }
            else { price = estPrice(mode, km); psrc = "sim"; }
          } else { price = 0; psrc = "sim"; }
          return [m, price, psrc, "map", null, []];
        }
      }
    } else if (["地铁", "公交"].includes(mode)) {
      const strats = mode === "地铁" ? [7, 0] : [5, 0];
      const o = await amapGeocode(a, env, city), d = await amapGeocode(b, env, city);
      if (o?.location && d?.location && o.citycode && d.citycode) {
        for (const strat of strats) {
          const [m, cost, lines, lineDetails] = await amapTransit(o.location, d.location, o.citycode, d.citycode, strat, env);
          if (m) {
            const price = cost != null ? cost : estPrice(mode, m / 60 * SPEED[mode]);
            const psrc = cost != null ? "real" : "sim";
            return [m, price, psrc, "map", lines, lineDetails];
          }
        }
      }
    }
  } catch (e) { /* ignore */ }
  const d = simRoute(a, b, mode);
  return [d, estPrice(mode, d / 60 * SPEED[mode]), "sim", "sim", null, []];
}

// ---------- 路线详情 ----------
const DIRS = ["东", "南", "西", "北", "东北", "东南", "西南", "西北"];
function simDetail(points, mode, transfers) {
  const steps = []; let lines = null;
  if (mode === "地铁") {
    const ln = Array.from({ length: transfers + 1 }, (_, j) => (hashStr(points.join("|") + `|地铁|${j}`) % 18) + 1);
    lines = ln.map(x => `${x}号线`).join(" → ");
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const stations = Math.max(2, Math.round(fakeDistance(a, b) / 2) + 1);
      steps.push(`步行至最近地铁站，乘坐 ${ln[0]} 号线（开往「${b}」方向）`);
      if (transfers >= 1) steps.push(`乘坐约 ${stations} 站，在换乘站换乘 ${ln[1]} 号线`);
      else steps.push(`乘坐约 ${stations} 站，到站出站`);
      steps.push(`抵达离「${b}」最近的地铁站，步行出站`);
    }
  } else if (mode === "公交") {
    const ln = Array.from({ length: transfers + 1 }, (_, j) => (hashStr(points.join("|") + `|公交|${j}`) % 900) + 100);
    lines = ln.map(x => `${x}路`).join(" → ");
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const stations = Math.max(3, Math.round(fakeDistance(a, b) / 1.5) + 2);
      steps.push(`步行至公交站，乘坐 ${ln[0]} 路公交车`);
      if (transfers >= 1) steps.push(`乘坐约 ${stations} 站，在换乘站换乘 ${ln[1]} 路`);
      else steps.push(`乘坐约 ${stations} 站，留意到站广播 / 电子屏`);
      steps.push(`在离「${b}」最近的站点下车，步行到达`);
    }
  } else {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const d = fakeDistance(a, b); const h = hashStr(`${a}->${b}|${mode}`);
      if (["打车", "自驾"].includes(mode)) {
        steps.push(`从「${a}」出发，进入主干道向${DIRS[h % 8]}方向行驶约 ${Math.round(d * 0.55)} 公里`);
        if (d > 12) steps.push(`驶入城市快速路 / 高速，继续约 ${Math.round(d * 0.45)} 公里`);
        steps.push(`从最近出口驶出，抵达「${b}」附近`);
      } else {
        const walkM = Math.max(300, Math.round(d * 1000 * 0.5));
        steps.push(`从「${a}」向${DIRS[h % 8]}方向步行约 ${walkM} 米`);
        steps.push(`沿人行道直行 / 按路牌指示，到达「${b}」`);
      }
    }
  }
  return [steps, lines];
}
async function amapSteps(o, d, maptype, env) {
  const url = `https://restapi.amap.com/v3/direction/${maptype}?key=${env.MAP_KEY}&origin=${o}&destination=${d}&strategy=0`;
  try {
    const data = await getJSON(url, 10000);
    const steps = data?.route?.paths?.[0]?.steps || [];
    const out = steps.map(st => (st.instruction || "").replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    return out.length ? out : null;
  } catch (e) { return null; }
}
async function buildDetail(points, mode, transfers, city, env) {
  if (env.MAP_KEY && ["打车", "自驾", "步行"].includes(mode)) {
    const maptype = { "打车": "driving", "自驾": "driving", "步行": "walking" }[mode];
    const real = []; let ok = true;
    for (let i = 0; i < points.length - 1; i++) {
      const ao = await amapGeocode(points[i], env, city), ad = await amapGeocode(points[i + 1], env, city);
      if (!(ao?.location && ad?.location)) { ok = false; break; }
      const s = await amapSteps(ao.location, ad.location, maptype, env);
      if (!s) { ok = false; break; }
      real.push(...s);
    }
    if (ok && real.length) return [real, null, "map"];
  }
  const [steps, lines] = simDetail(points, mode, transfers);
  return [steps, lines, "sim"];
}

// ---------- 天气 ----------
function weatherBufferFromDesc(desc) {
  const d = (desc || "").toLowerCase();
  if (/暴雨|暴雪|台风|storm|hurricane|blizzard/.test(d)) return [20, "极端天气，谨慎出行"];
  if (/大雨|大雪|大暴雨|heavy/.test(d)) return [20, "恶劣天气"];
  if (/雨|雪|rain|snow|shower/.test(d)) return [10, "小雨/雪"];
  return [0, "天气良好"];
}
function simWeather(dest, deadline) {
  const r = hashStr(`${dest}${deadline}`) % 100;
  if (r < 80) return ["晴", 0];
  if (r < 93) return ["小雨", 10];
  return ["大雨", 20];
}
async function realWeather(city, targetDt, env) {
  if (!env.WEATHER_KEY || !city) return null;
  try {
    const furl = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${env.WEATHER_KEY}&lang=zh_cn&units=metric`;
    const fd = await getJSON(furl, 12000);
    const items = fd?.list || [];
    if (items.length) {
      let best = null, bestDiff = null;
      const tgt = targetDt ? targetDt.getTime() / 1000 : null;
      for (const it of items) {
        const desc = it?.weather?.[0]?.description;
        if (!desc) continue;
        if (tgt != null) {
          const diff = Math.abs((it.dt || 0) - tgt);
          if (bestDiff == null || diff < bestDiff) { bestDiff = diff; best = desc; }
        } else { best = desc; break; }
      }
      if (best) { const [buf] = weatherBufferFromDesc(best); return [best, buf, "forecast"]; }
    }
  } catch (e) { /* fall through */ }
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${env.WEATHER_KEY}&lang=zh_cn&units=metric`;
    const d = await getJSON(url, 12000);
    const desc = d?.weather?.[0]?.description;
    if (desc) { const [buf] = weatherBufferFromDesc(desc); return [desc, buf, "current"]; }
  } catch (e) { /* ignore */ }
  return null;
}

// ---------- 内部流程缓冲（规则版，替代 LLM） ----------
function ruleInternal(dest) {
  const rules = [
    [["机场", "航班", "起飞", "航站楼"], 50, "值机 + 安检 + 找登机口"],
    [["高铁", "火车站", "动车"], 25, "安检 + 找站台"],
    [["医院", "挂号"], 30, "挂号 / 建档"],
    [["考试", "考场"], 15, "找考场 / 入场核验"],
    [["面试", "写字楼", "公司", "前台"], 15, "找楼层 / 前台登记"],
    [["演唱会", "演出", "体育馆", "音乐厅"], 20, "入场 + 找座位"],
  ];
  for (const [kws, m, desc] of rules) if (kws.some(k => dest.includes(k))) return [m, desc];
  return [15, "通用预留（找路 / 排队）"];
}

// ---------- 地址联想 ----------
export async function amapSuggest(q, city, env) {
  if (!env.MAP_KEY || !q.trim()) return [];
  const url = `https://restapi.amap.com/v3/assistant/inputtips?key=${env.MAP_KEY}&keywords=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}`;
  try {
    const d = await getJSON(url, 10000);
    return (d?.tips || []).slice(0, 8).map(t => {
      if (!t.name) return null;
      return { name: t.name, address: t.address || "", city: t.city || "", adcode: t.adcode || "" };
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ---------- 主逻辑 ----------
export async function computePlan(body, env) {
  const origin = (body.origin || "").trim();
  const dest = (body.destination || "").trim();
  let city = (body.city || "").trim();
  if (!city && env.MAP_KEY) {
    const g = await amapGeocode(origin, env);
    city = g?.city || "";
    if (!city) { const g2 = await amapGeocode(dest, env); city = g2?.city || ""; }
  }
  const via = (body.via || []).map(v => String(v).trim()).filter(Boolean);
  const deadlineStr = (body.deadline || "").trim();
  let sceneBuffer = parseInt(body.scene_buffer, 10);
  if (isNaN(sceneBuffer)) sceneBuffer = 15;
  let internalOverride = body.internal_buffer;
  internalOverride = (internalOverride === undefined || internalOverride === null || internalOverride === "") ? null : parseInt(internalOverride, 10);
  if (isNaN(internalOverride)) internalOverride = null;
  let weatherOn = body.weather_on !== undefined ? body.weather_on : true;
  if (typeof weatherOn === "string") weatherOn = !["0", "false", "off"].includes(weatherOn.toLowerCase());

  if (!origin || !dest || !deadlineStr) return { error: "请填写出发地、目的地和到达时间" };
  let dl;
  try { dl = parseDeadline(deadlineStr); } catch (e) { return { error: "到达时间格式应为 YYYY-MM-DD HH:MM" }; }

  const now = new Date();
  const points = [origin, ...via, dest];

  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const seg = { from: a, to: b, routes: {} };
    for (const mode of MODES) {
      const [mins, price, psrc, rsrc, lines, lineDetails] = await segMode(a, b, mode, city, env);
      seg.routes[mode] = { mins, price, price_src: psrc, route_src: rsrc, lines, line_details: lineDetails };
    }
    segments.push(seg);
  }

  let internal;
  if (internalOverride !== null) internal = { minutes: internalOverride, desc: "自定义预留", source: "custom" };
  else { const [im, idesc] = ruleInternal(dest); internal = { minutes: im, desc: idesc, source: "rule" }; }

  let wdesc, wbuf, wsrc;
  if (!weatherOn) { wdesc = "未考虑天气"; wbuf = 0; wsrc = "off"; }
  else {
    const wcity = city || dest;
    const w = env.WEATHER_KEY ? await realWeather(wcity, dl, env) : null;
    if (!w) { [wdesc, wbuf] = simWeather(dest, deadlineStr); wsrc = "sim"; }
    else { [wdesc, wbuf, wsrc] = w; }
  }

  const modesResult = [];
  for (const mode of MODES) {
    let routeTotal = 0, price = 0, priceSrc = "sim", routeSrc = "sim";
    for (const s of segments) {
      const r = s.routes[mode];
      routeTotal += r.mins; price += r.price;
      if (r.route_src === "map") routeSrc = "map";
      if (r.price_src === "real") priceSrc = "real";
      else if (r.price_src === "est" && priceSrc !== "real") priceSrc = "est";
    }
    price = Math.round(price);
    const transfers = estTransfers(mode, routeTotal);
    const latestDt = new Date(dl.getTime() - (internal.minutes + routeTotal + sceneBuffer + wbuf) * 60000);
    const ontime = latestDt >= now;
    const late = ontime ? 0 : Math.floor((now - latestDt) / 60000);

    let serviceWarning = false; const serviceLines = [];
    if (mode === "地铁" || mode === "公交") {
      for (const s of segments) {
        for (const ld of (s.routes[mode].line_details || [])) {
          const start = ld.start, end = ld.end;
          const boardingDt = new Date(latestDt.getTime() + (ld.boarding_offset || 0) * 1000);
          if (!start && !end) {
            // 高德没给首末班时间：按常识兜底提示
            const h = boardingDt.getHours();
            const full = ld.full_name || "";
            const short = ld.short_name || lineShort(full) || "";
            const isAirportBus = /机场巴士|机场大巴|机场线/.test(full + short);
            let risk = false, reason = "";
            if (isAirportBus && h < 5) { risk = true; reason = "机场大巴通常 05:00 后开班"; }
            else if (mode === "公交" && h < 5) { risk = true; reason = "公交通常 05:00 后开班"; }
            else if (mode === "地铁" && h < 5) { risk = true; reason = "地铁通常 05:00 后开班"; }
            else if (h >= 23) { risk = true; reason = "末班通常 23:00 前后"; }
            if (risk) {
              serviceWarning = true;
              serviceLines.push({
                name: short || full, full_name: full,
                start: "", end: "", boarding_at: hhmm(boardingDt), tips: ld.tips || "",
                time_source: "heuristic", risk: true, reason,
              });
            }
            continue;
          }
          let sh, sm, eh, em;
          if (start) [sh, sm] = start.split(":").map(Number);
          if (end) [eh, em] = end.split(":").map(Number);
          let startDt = start ? new Date(latestDt.getFullYear(), latestDt.getMonth(), latestDt.getDate(), sh, sm) : null;
          let endDt = end ? new Date(latestDt.getFullYear(), latestDt.getMonth(), latestDt.getDate(), eh, em) : null;
          if (startDt && endDt && endDt < startDt) endDt = new Date(endDt.getTime() + 86400000);
          const atRisk = (startDt && boardingDt < startDt) || (endDt && boardingDt > endDt);
          if (atRisk) {
            serviceWarning = true;
            serviceLines.push({
              name: ld.short_name || lineShort(ld.full_name || ""), full_name: ld.full_name || "",
              start, end, boarding_at: hhmm(boardingDt), tips: ld.tips || "",
              time_source: ld.time_source || "fixed", risk: true,
            });
          }
        }
      }
    }

    const realLines = segments.map(s => s.routes[mode].lines).filter(Boolean);
    const realLinesStr = realLines.length ? realLines.join(" → ") : null;
    const [detail, simLines, detailSrc] = await buildDetail(points, mode, transfers, city, env);
    const lines = realLinesStr || simLines;
    modesResult.push({
      mode, route: routeTotal, price, price_src: priceSrc, route_src: routeSrc, transfers,
      latest_leave: fmtLeave(latestDt), latest_dt: toLocalISO(latestDt),
      ontime, late, detail, lines, detail_source: detailSrc,
      service_warning: serviceWarning, service_lines: serviceLines,
    });
  }

  const ontimeModes = modesResult.filter(m => m.ontime);
  let rec, allLate;
  if (ontimeModes.length) { rec = ontimeModes.reduce((a, b) => (a.route <= b.route ? a : b)); allLate = false; }
  else { rec = modesResult.reduce((a, b) => (a.late <= b.late ? a : b)); allLate = true; }

  let warning;
  if (allLate) warning = `⚠ 本时点任何方式都无法准到，最早也要迟到 ${rec.late} 分钟，建议改期或大幅提前。`;
  else {
    const lateModes = modesResult.filter(m => !m.ontime);
    if (lateModes.length) {
      const ot = ontimeModes.map(m => m.mode).join("、");
      const lm = lateModes[0];
      warning = `⚠ 这个时点只有「${ot}」能保你准到，「${lm.mode}」必迟到 ${lm.late} 分钟。`;
    } else warning = null;
  }

  const recDt = new Date(modesResult.find(m => m.mode === rec.mode).latest_dt);
  const slack = Math.floor((recDt - now) / 60000);
  const summary = slack >= 0
    ? `建议 ${rec.latest_leave} 出门（${rec.mode}），总余量约 ${slack} 分钟`
    : `即使 ${rec.latest_leave} 出门（${rec.mode}），也将迟到约 ${Math.abs(slack)} 分钟`;

  const demo = !(env.LLM_KEY || env.MAP_KEY || env.WEATHER_KEY);

  return {
    demo,
    deadline: `${dl.getFullYear()}-${pad(dl.getMonth() + 1)}-${pad(dl.getDate())} ${pad(dl.getHours())}:${pad(dl.getMinutes())}`,
    internal,
    weather: { desc: wdesc, buffer: wbuf, source: wsrc },
    scene_buffer: sceneBuffer,
    segments: segments.map(s => ({ from: s.from, to: s.to, routes: Object.fromEntries(MODES.map(m => [m, s.routes[m].mins])) })),
    modes: modesResult.map(m => ({
      mode: m.mode, route: m.route, price: m.price, price_src: m.price_src, route_src: m.route_src,
      transfers: m.transfers, latest_leave: m.latest_leave, ontime: m.ontime, late: m.late,
      detail: m.detail, lines: m.lines, detail_source: m.detail_source,
      service_warning: m.service_warning, service_lines: m.service_lines,
    })),
    recommend: { mode: rec.mode, leave: rec.latest_leave, slack, price: rec.price },
    warning, summary,
  };
}
