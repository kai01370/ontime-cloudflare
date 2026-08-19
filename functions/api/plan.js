// POST /api/plan  —— 与 FastAPI 版完全一致的请求/响应契约
import { computePlan } from "../_lib.mjs";

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ error: "请求体需为 JSON" }, { status: 400 });
  }
  const result = await computePlan(body, env);
  if (result && result.error) return Response.json(result, { status: 400 });
  return Response.json(result);
}
