// Subscription-proxy support for the Sapling runtime.
//
// Sapling's Anthropic SDK backend authenticates with `x-api-key`, which a Claude
// Code SUBSCRIPTION OAuth token cannot satisfy. When the operator enables the
// subscription proxy, overstory routes sapling workers (ONLY) through a local
// bearer-injecting proxy (scripts/anthropic-bearer-proxy.mjs) so they run on the
// subscription with no API key.
//
// This module owns two responsibilities, kept here so the runtime adapter and the
// sling dispatch path resolve the toggle identically:
//   1. resolveSaplingProxy()    — config + env-var fallback → { enabled, proxyUrl }.
//   2. ensureSaplingProxyRunning() — idempotent probe + detached auto-start.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SaplingRuntimeConfig } from "../types.ts";

/** Default URL the bearer proxy listens on (matches scripts/anthropic-bearer-proxy.mjs). */
export const DEFAULT_SAPLING_PROXY_URL = "http://127.0.0.1:8788";

/** Dummy API key injected so the SDK is satisfied; the proxy ignores x-api-key. */
export const SAPLING_PROXY_DUMMY_KEY = "sk-ant-proxy-dummy";

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
 * Precedence (config wins over env):
 *   1. `config.subscriptionProxy === true`           → enabled.
 *   2. else `OV_SAPLING_SUBSCRIPTION_PROXY` truthy    → enabled.
 * URL precedence: `config.proxyUrl` → `OV_SAPLING_PROXY_URL` → default.
 *
 * When config is undefined AND the env toggle is unset, the result is
 * `{ enabled: false }`, so callers leave sapling's env byte-identical.
 *
 * @param config - The `runtime.sapling` config block, if present.
 * @param env - Environment to read fallbacks from (defaults to process.env).
 */
export function resolveSaplingProxy(
	config?: SaplingRuntimeConfig,
	env: Record<string, string | undefined> = process.env,
): SaplingProxyResolution {
	const enabled = config?.subscriptionProxy === true || envTruthy(env[ENV_TOGGLE]);
	const proxyUrl = config?.proxyUrl ?? env[ENV_PROXY_URL] ?? DEFAULT_SAPLING_PROXY_URL;
	return { enabled, proxyUrl };
}

/** Absolute path to the bundled bearer proxy script. */
export function bearerProxyScriptPath(): string {
	// src/runtimes/sapling-proxy.ts → repo-root/scripts/anthropic-bearer-proxy.mjs
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "scripts", "anthropic-bearer-proxy.mjs");
}

/** Dependency seam for ensureSaplingProxyRunning (test injection). */
export interface ProxyPreflightDeps {
	/** Probe whether something is listening at `url`. Resolves true if reachable. */
	probe: (url: string) => Promise<boolean>;
	/** Spawn the proxy detached; returns its pid (or null if pid is unavailable). */
	spawn: (scriptPath: string, port: number) => number | null;
	/** Sleep helper (ms). */
	sleep: (ms: number) => Promise<void>;
	/** Structured logger for operator-facing messages. */
	log: (msg: string) => void;
}

/** Result of a preflight attempt. */
export interface ProxyPreflightResult {
	/** Whether the proxy is reachable after preflight. */
	ready: boolean;
	/** "already" = was up; "started" = we launched it; "failed" = could not bring it up. */
	status: "already" | "started" | "failed";
	/** PID of a proxy we started (null when already up or pid unavailable). */
	pid: number | null;
}

/** Default HTTP probe: a quick GET that resolves true on ANY HTTP response. */
async function defaultProbe(url: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1000);
		try {
			// Any HTTP response (even 401/404) proves something is listening.
			await fetch(url, { method: "GET", signal: controller.signal });
			return true;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

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

/**
 * Ensure the bearer proxy is listening at `proxyUrl` before a sapling dispatch.
 *
 * Idempotent:
 * - If the proxy is already reachable → no-op, returns `{ ready: true, status: "already" }`.
 * - Otherwise auto-starts scripts/anthropic-bearer-proxy.mjs DETACHED (so it outlives
 *   this sling call), polls until it answers, and logs a clear line telling the operator
 *   the pid and how to stop it.
 * - If it still cannot be reached after starting, returns `{ ready: false, status: "failed" }`
 *   with a clear operator-facing log — the caller decides whether to hard-fail. The
 *   dispatch must NOT silently proceed past a failed preflight.
 *
 * @param proxyUrl - Base URL of the proxy (e.g. "http://127.0.0.1:8788").
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

	// 1. Already up? No-op.
	if (await probe(proxyUrl)) {
		return { ready: true, status: "already", pid: null };
	}

	// 2. Auto-start detached.
	const scriptPath = bearerProxyScriptPath();
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

	// 3. Poll until ready (≈3s budget).
	for (let i = 0; i < 15; i++) {
		await sleep(200);
		if (await probe(proxyUrl)) {
			const pidStr = pid === null ? "?" : String(pid);
			log(
				`started anthropic-bearer-proxy on ${proxyUrl} (pid ${pidStr}) — leave running; kill with kill ${pidStr}`,
			);
			return { ready: true, status: "started", pid };
		}
	}

	// 4. Could not bring it up — surface a clear, actionable error.
	log(
		`anthropic-bearer-proxy did not become ready at ${proxyUrl} after auto-start. ` +
			`Start it manually:  bun ${scriptPath}`,
	);
	return { ready: false, status: "failed", pid };
}
