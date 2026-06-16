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
// Listens on 127.0.0.1:8788 by default; override the PORT with BEARER_PROXY_PORT.
//
// READINESS: GET /__ov_proxy_health returns 200 JSON
//   {"ok":true,"anthropicBearerProxy":true,"tokenReady":<bool>}
// where tokenReady reflects whether a NON-EXPIRED subscription token was found. This
// route is answered LOCALLY — it never forwards to api.anthropic.com — so overstory's
// preflight can positively identify THIS proxy (not a random service squatting the
// port) and confirm a usable token exists before dispatching a sapling worker. An
// expired creds-file token reports tokenReady:false (forwarding it would 401 upstream).
//
// SECURITY: loopback-only (binds 127.0.0.1), single-user-dev-trust. Any local process
// that can reach 127.0.0.1:<port> can spend the operator's subscription token. There is
// deliberately NO inbound shared-secret: sapling drives outbound calls through the
// Anthropic SDK, which controls its own request headers, so ov cannot reliably attach a
// per-request secret without forking the SDK — a half-secret (enforced on forwarding but
// not sent by the worker) would 401 every real call while the health route still passed.
// The single-user loopback trust model is the deliberate, documented boundary here.
//
// NOTE: using a Claude Code subscription token outside of Claude Code itself is an
// Anthropic Terms-of-Service GREY AREA. This is provided for the operator's own
// subscription on their own machine — understand the ToS before relying on it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.BEARER_PROXY_PORT || 8788);
// Loopback-only bind. The overstory preflight rejects non-loopback proxy URLs, and the
// validator only accepts hosts that resolve here (127.0.0.1 / localhost) — so this stays
// hardcoded rather than configurable, keeping the bind and the accepted URL set in lockstep.
const HOSTNAME = "127.0.0.1";
const CREDS = join(homedir(), ".claude", ".credentials.json");
const HEALTH_PATH = "/__ov_proxy_health";

/**
 * Read the subscription bearer token, treating an EXPIRED creds-file token as absent
 * (forwarding it would 401 upstream). Falls back to env tokens (whose expiry we cannot
 * inspect — assumed live). Returns "" when no usable token is found.
 */
function token() {
	try {
		const creds = JSON.parse(readFileSync(CREDS, "utf8"));
		const oauth = creds.claudeAiOauth || creds;
		if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
			console.error(
				`[warn] subscription token expired at ${new Date(
					oauth.expiresAt,
				).toISOString()} — run \`claude\` to refresh`,
			);
			// Expired → not usable. Fall through to env fallbacks below.
		} else if (oauth.accessToken) {
			return oauth.accessToken;
		}
	} catch {
		// fall through to env fallbacks
	}
	return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY_CLAUDE_1 || "";
}

Bun.serve({
	port: PORT,
	hostname: HOSTNAME,
	async fetch(req) {
		const url = new URL(req.url);

		// Health route: answered locally, NEVER forwarded. Lets overstory's preflight
		// positively identify this proxy and confirm a usable (non-expired) token exists.
		if (url.pathname === HEALTH_PATH) {
			const tokenReady = token() !== "";
			return new Response(JSON.stringify({ ok: true, anthropicBearerProxy: true, tokenReady }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}

		const tok = token();
		if (!tok) {
			return new Response(JSON.stringify({ error: "no subscription token found" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}

		const headers = new Headers(req.headers);
		headers.delete("x-api-key");
		headers.delete("authorization");
		headers.delete("host");
		headers.set("authorization", `Bearer ${tok}`);

		const body =
			req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
		const upstream = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
			method: req.method,
			headers,
			body,
		});

		const respHeaders = new Headers(upstream.headers);
		respHeaders.delete("content-encoding");
		respHeaders.delete("content-length");
		return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
	},
});

console.error(`anthropic-bearer-proxy → http://${HOSTNAME}:${PORT} (token from ${CREDS})`);
