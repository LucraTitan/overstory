// Subscription-proxy support for the Sapling runtime.
//
// Sapling's Anthropic SDK backend authenticates with `x-api-key`, which a Claude
// Code SUBSCRIPTION OAuth token cannot satisfy. When the operator enables the
// subscription proxy, overstory routes sapling workers (ONLY) through a local
// bearer-injecting proxy (scripts/anthropic-bearer-proxy.mjs) so they run on the
// subscription with no API key.
//
// This module owns three responsibilities, kept here so the runtime adapter and the
// sling / turn-runner dispatch paths resolve the toggle identically:
//   1. resolveSaplingProxy()       — config + env-var fallback → { enabled, proxyUrl }.
//   2. ensureSaplingProxyRunning() — health-gated idempotent probe + detached auto-start.
//   3. assertLoopbackProxyUrl()    — reject a non-loopback proxy host (token would leak).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SaplingRuntimeConfig } from "../types.ts";

/** Default URL the bearer proxy listens on (matches scripts/anthropic-bearer-proxy.mjs). */
export const DEFAULT_SAPLING_PROXY_URL = "http://127.0.0.1:8788";

/** Dummy API key injected so the SDK is satisfied; the proxy ignores x-api-key. */
export const SAPLING_PROXY_DUMMY_KEY = "sk-ant-proxy-dummy";

/**
 * Health route on the bearer proxy. A GET here returns 200 JSON
 * `{ ok, anthropicBearerProxy: true, tokenReady }` and is NOT forwarded upstream,
 * so the preflight can positively identify OUR proxy and confirm a usable token.
 */
export const SAPLING_PROXY_HEALTH_PATH = "/__ov_proxy_health";

/** Env-var fallback toggle (used when config.runtime.sapling is absent). */
const ENV_TOGGLE = "OV_SAPLING_SUBSCRIPTION_PROXY";
/** Env-var fallback for the proxy URL. */
const ENV_PROXY_URL = "OV_SAPLING_PROXY_URL";

/** Resolved subscription-proxy decision. */
export interface SaplingProxyResolution {
	/** Whether sapling workers should be routed through the bearer proxy. */
	enabled: boolean;
	/** The proxy base URL to inject as ANTHROPIC_BASE_URL. */
	proxyUrl: string;
}

/** True for env values that mean "on". */
function envTruthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve whether the sapling subscription proxy is enabled and at which URL.
 *
 * Precedence — CONFIG WINS over env (an explicit boolean in config, true OR false,
 * overrides the env toggle; env is only consulted when config leaves it undefined):
 *   enabled  = config?.subscriptionProxy ?? envTruthy(OV_SAPLING_SUBSCRIPTION_PROXY)
 *   proxyUrl = config?.proxyUrl ?? OV_SAPLING_PROXY_URL ?? default
 *
 * So `{ subscriptionProxy: false }` + `OV_SAPLING_SUBSCRIPTION_PROXY=1` → DISABLED:
 * an operator who turned the feature off in config is not silently re-enabled by a
 * stray env var. When config is undefined AND the env toggle is unset, the result is
 * `{ enabled: false }`, so callers leave sapling's env byte-identical.
 *
 * @param config - The `runtime.sapling` config block, if present.
 * @param env - Environment to read fallbacks from (defaults to process.env).
 */
export function resolveSaplingProxy(
	config?: SaplingRuntimeConfig,
	env: Record<string, string | undefined> = process.env,
): SaplingProxyResolution {
	// `??` — config wins when DEFINED (true or false); env only consulted when undefined.
	const enabled = config?.subscriptionProxy ?? envTruthy(env[ENV_TOGGLE]);
	const proxyUrl = config?.proxyUrl ?? env[ENV_PROXY_URL] ?? DEFAULT_SAPLING_PROXY_URL;
	return { enabled, proxyUrl };
}

/**
 * Loopback hostnames the bearer proxy is allowed to forward through.
 *
 * The bundled proxy binds 127.0.0.1 (hardcoded), so the accepted set is kept in
 * lockstep with that bind: only hosts that resolve to the bound interface are allowed.
 * `::1` is deliberately EXCLUDED — the proxy does not listen on the IPv6 loopback, so a
 * `::1` URL would auto-start a proxy the probe could never reach.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * True iff `proxyUrl` is an `http:` URL whose host is the bound loopback interface
 * (127.0.0.1 / localhost).
 *
 * A malformed URL, a non-`http:` scheme, or any other host is treated as NOT loopback —
 * we will not route the operator's subscription token at something we cannot prove is
 * the local bearer proxy.
 */
export function isLoopbackProxyUrl(proxyUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(proxyUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:") return false;
	return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Assert that `proxyUrl` points at a loopback host, throwing otherwise.
 *
 * The bearer proxy injects the operator's Claude subscription token into every
 * forwarded request. Pointing it at a non-loopback host would ship that token to an
 * arbitrary remote — so a non-loopback URL is a hard error, not a warning.
 */
export function assertLoopbackProxyUrl(proxyUrl: string): void {
	if (!isLoopbackProxyUrl(proxyUrl)) {
		throw new Error(
			`sapling subscription proxy URL must be http on the bound loopback interface (127.0.0.1 or localhost), got "${proxyUrl}". ` +
				"The proxy injects your subscription token; routing it off-loopback would leak that token to a remote host.",
		);
	}
}

/** Absolute path to the bundled bearer proxy script. */
export function bearerProxyScriptPath(): string {
	// src/runtimes/sapling-proxy.ts → repo-root/scripts/anthropic-bearer-proxy.mjs
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "scripts", "anthropic-bearer-proxy.mjs");
}

/** Outcome of a health probe against the proxy's `/__ov_proxy_health` route. */
export type HealthProbeResult =
	/** It is OUR proxy, answering 200, with a usable subscription token → ready. */
	| { kind: "ready" }
	/** Nothing answered / network error → the port is dead. */
	| { kind: "down" }
	/** Something answered but it is NOT our proxy (no `anthropicBearerProxy:true`). */
	| { kind: "wrong-service" }
	/** It is our proxy but no subscription token is available (`tokenReady:false`). */
	| { kind: "no-token" };

/**
 * Probe the proxy's dedicated health route and classify readiness.
 *
 * Readiness requires ALL of: HTTP 200, body `anthropicBearerProxy === true` (proves
 * it is OUR proxy, not a random service squatting the port), and `tokenReady === true`
 * (a usable subscription token exists). Anything else maps to a specific non-ready
 * kind so the caller can surface actionable guidance instead of dispatching against a
 * dead or misconfigured proxy.
 */
export async function probeProxyHealth(proxyUrl: string): Promise<HealthProbeResult> {
	const healthUrl = new URL(SAPLING_PROXY_HEALTH_PATH, proxyUrl).toString();
	let res: Response;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1000);
		try {
			res = await fetch(healthUrl, { method: "GET", signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return { kind: "down" };
	}
	if (res.status !== 200) {
		// Something is listening but not answering our health route as 200 — e.g. a
		// different service, or our proxy 401ing the route (it never should). Treat as
		// "not our proxy" so we don't trust an unknown listener.
		return { kind: "wrong-service" };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: "wrong-service" };
	}
	const b = body as { anthropicBearerProxy?: unknown; tokenReady?: unknown };
	if (b.anthropicBearerProxy !== true) {
		return { kind: "wrong-service" };
	}
	if (b.tokenReady !== true) {
		return { kind: "no-token" };
	}
	return { kind: "ready" };
}

/** Dependency seam for ensureSaplingProxyRunning (test injection). */
export interface ProxyPreflightDeps {
	/** Health-probe the proxy at `url` and classify readiness. */
	probe: (url: string) => Promise<HealthProbeResult>;
	/** Spawn the proxy detached; returns its pid (or null if pid is unavailable). */
	spawn: (scriptPath: string, port: number) => number | null;
	/** Sleep helper (ms). */
	sleep: (ms: number) => Promise<void>;
	/** Structured logger for operator-facing messages. */
	log: (msg: string) => void;
}

/** Result of a preflight attempt. */
export interface ProxyPreflightResult {
	/** Whether the proxy is OUR proxy, healthy, and token-ready after preflight. */
	ready: boolean;
	/** "already" = was healthy; "started" = we launched it; "failed" = could not bring it up. */
	status: "already" | "started" | "failed";
	/** PID of a proxy we started (null when already up or pid unavailable). */
	pid: number | null;
}

/** Default health probe (production): hits the dedicated `/__ov_proxy_health` route. */
const defaultProbe = probeProxyHealth;

/** Default detached spawn via Bun.spawn (production). */
function defaultSpawn(scriptPath: string, port: number): number | null {
	const proc = Bun.spawn(["bun", scriptPath], {
		env: { ...process.env, BEARER_PROXY_PORT: String(port) },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	// Detach so the proxy outlives this sling process.
	proc.unref();
	return proc.pid ?? null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Extract the port from a proxy URL, defaulting to 8788. */
export function proxyPort(proxyUrl: string): number {
	try {
		const p = new URL(proxyUrl).port;
		return p ? Number(p) : 8788;
	} catch {
		return 8788;
	}
}

/** Human-readable, actionable guidance for a non-ready probe result. */
function guidanceFor(
	kind: HealthProbeResult["kind"],
	proxyUrl: string,
	scriptPath: string,
): string {
	switch (kind) {
		case "wrong-service":
			return (
				`a service is listening at ${proxyUrl} but it is NOT the anthropic-bearer-proxy ` +
				`(no ${SAPLING_PROXY_HEALTH_PATH} 200 / anthropicBearerProxy marker). ` +
				`Free the port or set OV_SAPLING_PROXY_URL to an unused loopback port, then start:  bun ${scriptPath}`
			);
		case "no-token":
			return (
				`the anthropic-bearer-proxy at ${proxyUrl} is up but has NO usable subscription token ` +
				"(creds file empty/expired and no env fallback). Run `claude` to refresh your subscription token, " +
				"then retry."
			);
		default:
			return `anthropic-bearer-proxy is not reachable at ${proxyUrl}. Start it manually:  bun ${scriptPath}`;
	}
}

/**
 * Ensure the bearer proxy is OUR proxy, healthy, and token-ready before a sapling
 * dispatch. Runs before EVERY sapling worker spawn (initial sling dispatch AND each
 * later spawn-per-turn), and is cheap-idempotent: when already healthy it is a single
 * localhost GET to `/__ov_proxy_health` and returns `{ ready: true, status: "already" }`.
 *
 * Health gate (all required): HTTP 200 + `anthropicBearerProxy === true` (it's OUR
 * proxy, not a squatting service) + `tokenReady === true` (a usable token exists).
 *
 * - Healthy already → no-op.
 * - Down → auto-start scripts/anthropic-bearer-proxy.mjs DETACHED, poll until healthy,
 *   log the pid + how to stop it.
 * - Up but `wrong-service` or `no-token` → do NOT auto-start (port is occupied / token
 *   missing); return `{ ready: false, status: "failed" }` with specific guidance. The
 *   caller must hard-fail rather than dispatch against a dead/misconfigured proxy.
 *
 * @param proxyUrl - Base URL of the proxy (e.g. "http://127.0.0.1:8788"). Caller is
 *   responsible for loopback validation (see assertLoopbackProxyUrl).
 * @param deps - Injectable probe/spawn/sleep/log seams (defaults = production behavior).
 */
export async function ensureSaplingProxyRunning(
	proxyUrl: string,
	deps: Partial<ProxyPreflightDeps> = {},
): Promise<ProxyPreflightResult> {
	const probe = deps.probe ?? defaultProbe;
	const spawn = deps.spawn ?? defaultSpawn;
	const sleep = deps.sleep ?? defaultSleep;
	const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));

	const scriptPath = bearerProxyScriptPath();

	// 1. Already healthy? No-op (the cheap idempotent path taken on every later turn).
	const first = await probe(proxyUrl);
	if (first.kind === "ready") {
		return { ready: true, status: "already", pid: null };
	}

	// 2. Up but wrong-service / no-token → do NOT auto-start; surface specific guidance.
	//    Starting a second proxy cannot fix a squatted port or a missing token, and we
	//    must never silently dispatch against it.
	if (first.kind === "wrong-service" || first.kind === "no-token") {
		log(guidanceFor(first.kind, proxyUrl, scriptPath));
		return { ready: false, status: "failed", pid: null };
	}

	// 3. Down → auto-start detached.
	const port = proxyPort(proxyUrl);
	let pid: number | null = null;
	try {
		pid = spawn(scriptPath, port);
	} catch (err) {
		log(
			`failed to auto-start anthropic-bearer-proxy at ${proxyUrl}: ${
				err instanceof Error ? err.message : String(err)
			}. Start it manually:  bun ${scriptPath}`,
		);
		return { ready: false, status: "failed", pid: null };
	}

	// 4. Poll the health route until ready (≈3s budget).
	let lastKind: HealthProbeResult["kind"] = "down";
	for (let i = 0; i < 15; i++) {
		await sleep(200);
		const r = await probe(proxyUrl);
		lastKind = r.kind;
		if (r.kind === "ready") {
			const pidStr = pid === null ? "?" : String(pid);
			log(
				`started anthropic-bearer-proxy on ${proxyUrl} (pid ${pidStr}) — leave running; kill with kill ${pidStr}`,
			);
			return { ready: true, status: "started", pid };
		}
		// If it came up but has no token, stop polling — a refresh won't happen on its own.
		if (r.kind === "no-token") break;
	}

	// 5. Could not bring it up healthy — surface clear, kind-specific guidance.
	log(
		`anthropic-bearer-proxy did not become ready at ${proxyUrl} after auto-start. ${guidanceFor(
			lastKind,
			proxyUrl,
			scriptPath,
		)}`,
	);
	return { ready: false, status: "failed", pid };
}
