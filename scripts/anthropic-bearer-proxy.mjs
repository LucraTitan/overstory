#!/usr/bin/env bun
// anthropic-bearer-proxy — run subscription-auth Anthropic-SDK tools (e.g. sapling)
// on a Claude Code SUBSCRIPTION (no `sk-ant-api…` API key required).
//
// WHY THIS EXISTS: the Anthropic SDK that sapling uses sends the credential as the
// `x-api-key` header. A Claude Code *subscription* OAuth token (`sk-ant-oat01-…`)
// only authenticates as `Authorization: Bearer <token>` — as `x-api-key` it 401s.
// This proxy bridges the gap: it strips the inbound `x-api-key` (a dummy value the
// SDK still requires to be set), injects `Authorization: Bearer <subscription token>`
// read from the Claude Code credentials file, and forwards to api.anthropic.com.
//
// Point an SDK tool at it with:
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8788  +  ANTHROPIC_API_KEY=<any-dummy>
// In overstory this is wired automatically for SAPLING workers ONLY when
// `runtime.sapling.subscriptionProxy: true` (or OV_SAPLING_SUBSCRIPTION_PROXY=1);
// Claude Code workers are never routed through it.
//
// Token source: ~/.claude/.credentials.json (.claudeAiOauth.accessToken), re-read
// per request so Claude Code's token refreshes are picked up; env fallbacks below.
// Listens on 127.0.0.1:8788 by default; override with BEARER_PROXY_PORT.
//
// NOTE: using a Claude Code subscription token outside of Claude Code itself is an
// Anthropic Terms-of-Service GREY AREA. This is provided for the operator's own
// subscription on their own machine — understand the ToS before relying on it.
import { homedir } from "os"; import { join } from "path";
const PORT = Number(process.env.BEARER_PROXY_PORT || 8788);
const CREDS = join(homedir(), ".claude", ".credentials.json");
function token() {
  try {
    const c = JSON.parse(require("fs").readFileSync(CREDS, "utf8"));
    const o = c.claudeAiOauth || c;
    if (o.expiresAt && Date.now() > o.expiresAt)
      console.error("[warn] subscription token expired at " + new Date(o.expiresAt).toISOString() + " — run `claude` to refresh");
    if (o.accessToken) return o.accessToken;
  } catch {}
  return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY_CLAUDE_1 || "";
}
Bun.serve({
  port: PORT, hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const tok = token();
    if (!tok) return new Response(JSON.stringify({ error: "no subscription token found" }), { status: 401 });
    const h = new Headers(req.headers);
    h.delete("x-api-key"); h.delete("authorization"); h.delete("host");
    h.set("authorization", "Bearer " + tok);
    const body = (req.method === "GET" || req.method === "HEAD") ? undefined : await req.arrayBuffer();
    const r = await fetch("https://api.anthropic.com" + u.pathname + u.search, { method: req.method, headers: h, body });
    const rh = new Headers(r.headers); rh.delete("content-encoding"); rh.delete("content-length");
    return new Response(r.body, { status: r.status, headers: rh });
  },
});
console.error(`anthropic-bearer-proxy → http://127.0.0.1:${PORT} (token from ${CREDS})`);
