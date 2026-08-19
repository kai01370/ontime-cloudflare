// GET /api/suggest?q=...&city=...  —— 地址联想
import { amapSuggest } from "../_lib.mjs";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const city = url.searchParams.get("city") || "";
  const items = await amapSuggest(q, city, env);
  return Response.json({ items });
}
