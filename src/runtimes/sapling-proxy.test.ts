import { describe, expect, test } from "bun:test";
import type { SaplingRuntimeConfig } from "../types.ts";
import {
	assertLoopbackProxyUrl,
	DEFAULT_SAPLING_PROXY_URL,
	ensureSaplingProxyRunning,
	type HealthProbeResult,
	isLoopbackProxyUrl,
	proxyPort,
	resolveSaplingProxy,
} from "./sapling-proxy.ts";

describe("resolveSaplingProxy — config wins over env (HIGH 2)", () => {
	test("disabled by default (no config, no env)", () => {
		const r = resolveSaplingProxy(undefined, {});
		expect(r.enabled).toBe(false);
		expect(r.proxyUrl).toBe(DEFAULT_SAPLING_PROXY_URL);
	});

	// The four mandated precedence cases:
	test("{false} + env=1 → DISABLED (explicit config-false overrides env)", () => {
		const config: SaplingRuntimeConfig = { subscriptionProxy: false };
		const r = resolveSaplingProxy(config, { OV_SAPLING_SUBSCRIPTION_PROXY: "1" });
		expect(r.enabled).toBe(false);
	});

	test("{true} → ENABLED", () => {
		const config: SaplingRuntimeConfig = { subscriptionProxy: true };
		const r = resolveSaplingProxy(config, {});
		expect(r.enabled).toBe(true);
		expect(r.proxyUrl).toBe(DEFAULT_SAPLING_PROXY_URL);
	});

	test("undefined + env=1 → ENABLED (env consulted only when config undefined)", () => {
		const r = resolveSaplingProxy(undefined, { OV_SAPLING_SUBSCRIPTION_PROXY: "1" });
		expect(r.enabled).toBe(true);
	});

	test("undefined + no-env → DISABLED", () => {
		const r = resolveSaplingProxy(undefined, {});
		expect(r.enabled).toBe(false);
	});

	test("config.subscriptionProxy === false beats env even when config block has other keys", () => {
		const config: SaplingRuntimeConfig = {
			subscriptionProxy: false,
			proxyUrl: "http://127.0.0.1:9000",
		};
		const r = resolveSaplingProxy(config, { OV_SAPLING_SUBSCRIPTION_PROXY: "true" });
		expect(r.enabled).toBe(false);
	});

	test("config.proxyUrl overrides the default URL", () => {
		const config: SaplingRuntimeConfig = {
			subscriptionProxy: true,
			proxyUrl: "http://127.0.0.1:9999",
		};
		const r = resolveSaplingProxy(config, {});
		expect(r.proxyUrl).toBe("http://127.0.0.1:9999");
	});

	test("env fallback accepts true/yes/on (case-insensitive)", () => {
		for (const v of ["true", "TRUE", "yes", "On"]) {
			expect(resolveSaplingProxy(undefined, { OV_SAPLING_SUBSCRIPTION_PROXY: v }).enabled).toBe(
				true,
			);
		}
	});

	test("env fallback ignores falsey values (0, false, empty)", () => {
		for (const v of ["0", "false", "", "no"]) {
			expect(resolveSaplingProxy(undefined, { OV_SAPLING_SUBSCRIPTION_PROXY: v }).enabled).toBe(
				false,
			);
		}
	});

	test("env OV_SAPLING_PROXY_URL is used when config.proxyUrl is absent", () => {
		const r = resolveSaplingProxy(
			{ subscriptionProxy: true },
			{ OV_SAPLING_PROXY_URL: "http://127.0.0.1:7777" },
		);
		expect(r.proxyUrl).toBe("http://127.0.0.1:7777");
	});

	test("config.proxyUrl wins over env proxy URL", () => {
		const r = resolveSaplingProxy(
			{ subscriptionProxy: true, proxyUrl: "http://127.0.0.1:5555" },
			{ OV_SAPLING_PROXY_URL: "http://127.0.0.1:7777" },
		);
		expect(r.proxyUrl).toBe("http://127.0.0.1:5555");
	});
});

describe("loopback validation (MEDIUM)", () => {
	test("accepts 127.0.0.1 / localhost (the bound loopback interface)", () => {
		expect(isLoopbackProxyUrl("http://127.0.0.1:8788")).toBe(true);
		expect(isLoopbackProxyUrl("http://localhost:8788")).toBe(true);
		expect(() => assertLoopbackProxyUrl("http://127.0.0.1:8788")).not.toThrow();
		expect(() => assertLoopbackProxyUrl("http://localhost:8788")).not.toThrow();
	});

	test("rejects ::1 — the proxy binds 127.0.0.1, not the IPv6 loopback", () => {
		expect(isLoopbackProxyUrl("http://[::1]:8788")).toBe(false);
		expect(() => assertLoopbackProxyUrl("http://[::1]:8788")).toThrow(/loopback/);
	});

	test("rejects a non-loopback host (would leak the token)", () => {
		expect(isLoopbackProxyUrl("http://evil.example.com:8788")).toBe(false);
		expect(isLoopbackProxyUrl("http://10.0.0.5:8788")).toBe(false);
		expect(isLoopbackProxyUrl("http://0.0.0.0:8788")).toBe(false);
		expect(() => assertLoopbackProxyUrl("http://evil.example.com:8788")).toThrow(/loopback/);
		expect(() => assertLoopbackProxyUrl("http://10.0.0.5:8788")).toThrow(/loopback/);
	});

	test("rejects a non-http scheme even on a loopback host", () => {
		expect(isLoopbackProxyUrl("https://127.0.0.1:8788")).toBe(false);
		expect(isLoopbackProxyUrl("file:///127.0.0.1")).toBe(false);
		expect(() => assertLoopbackProxyUrl("https://127.0.0.1:8788")).toThrow(/loopback/);
	});

	test("rejects a malformed URL (cannot prove it is local)", () => {
		expect(isLoopbackProxyUrl("not-a-url")).toBe(false);
		expect(() => assertLoopbackProxyUrl("not-a-url")).toThrow(/loopback/);
	});
});

describe("proxyPort", () => {
	test("extracts the port from a URL", () => {
		expect(proxyPort("http://127.0.0.1:8788")).toBe(8788);
		expect(proxyPort("http://127.0.0.1:9999")).toBe(9999);
	});

	test("defaults to 8788 when no port or malformed", () => {
		expect(proxyPort("http://127.0.0.1")).toBe(8788);
		expect(proxyPort("not-a-url")).toBe(8788);
	});
});

const ready: HealthProbeResult = { kind: "ready" };
const down: HealthProbeResult = { kind: "down" };
const wrongService: HealthProbeResult = { kind: "wrong-service" };
const noToken: HealthProbeResult = { kind: "no-token" };

describe("ensureSaplingProxyRunning — health-gated readiness (HIGH 1)", () => {
	test("HEALTHY already → no-op, does not spawn", async () => {
		let spawned = false;
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => ready,
			spawn: () => {
				spawned = true;
				return 123;
			},
			sleep: async () => {},
			log: () => {},
		});
		expect(result.ready).toBe(true);
		expect(result.status).toBe("already");
		expect(result.pid).toBeNull();
		expect(spawned).toBe(false);
	});

	test("WRONG-SERVICE squatting the port → not ready, does NOT spawn, specific guidance", async () => {
		let spawned = false;
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => wrongService,
			spawn: () => {
				spawned = true;
				return 123;
			},
			sleep: async () => {},
			log: (m) => logs.push(m),
		});
		expect(result.ready).toBe(false);
		expect(result.status).toBe("failed");
		// Must NOT try to auto-start over a squatted port.
		expect(spawned).toBe(false);
		expect(logs.some((l) => l.includes("NOT the anthropic-bearer-proxy"))).toBe(true);
	});

	test("NO-TOKEN (our proxy, no subscription token) → not ready, does NOT spawn, token guidance", async () => {
		let spawned = false;
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => noToken,
			spawn: () => {
				spawned = true;
				return 123;
			},
			sleep: async () => {},
			log: (m) => logs.push(m),
		});
		expect(result.ready).toBe(false);
		expect(result.status).toBe("failed");
		expect(spawned).toBe(false);
		expect(logs.some((l) => l.includes("NO usable subscription token"))).toBe(true);
	});

	test("DOWN → auto-starts detached, then becomes healthy", async () => {
		let spawnCount = 0;
		let probeCalls = 0;
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			// First probe: down. After spawn: ready.
			probe: async () => {
				probeCalls += 1;
				return probeCalls > 1 ? ready : down;
			},
			spawn: () => {
				spawnCount += 1;
				return 4242;
			},
			sleep: async () => {},
			log: (m) => logs.push(m),
		});
		expect(result.ready).toBe(true);
		expect(result.status).toBe("started");
		expect(result.pid).toBe(4242);
		expect(spawnCount).toBe(1);
		expect(
			logs.some((l) => l.includes("started anthropic-bearer-proxy") && l.includes("4242")),
		).toBe(true);
		expect(logs.some((l) => l.includes("kill 4242"))).toBe(true);
	});

	test("DOWN and never comes up → failed (not ready) with manual-start guidance", async () => {
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => down, // never reachable
			spawn: () => 777,
			sleep: async () => {},
			log: (m) => logs.push(m),
		});
		expect(result.ready).toBe(false);
		expect(result.status).toBe("failed");
		expect(logs.some((l) => l.includes("did not become ready") && l.includes("manually"))).toBe(
			true,
		);
	});

	test("DOWN, comes up but token never appears → failed with token guidance, stops polling early", async () => {
		let probeCalls = 0;
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			// First probe: down → spawn. Then: no-token (proxy up, token missing).
			probe: async () => {
				probeCalls += 1;
				return probeCalls > 1 ? noToken : down;
			},
			spawn: () => 555,
			sleep: async () => {},
			log: (m) => logs.push(m),
		});
		expect(result.ready).toBe(false);
		expect(result.status).toBe("failed");
		expect(logs.some((l) => l.includes("NO usable subscription token"))).toBe(true);
		// Should stop polling once it sees no-token (no point re-polling 14 more times).
		expect(probeCalls).toBe(2);
	});

	test("returns failed when spawn throws (surfaces manual-start guidance)", async () => {
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => down,
			spawn: () => {
				throw new Error("boom");
			},
			sleep: async () => {},
			log: (m) => logs.push(m),
		});
		expect(result.ready).toBe(false);
		expect(result.status).toBe("failed");
		expect(logs.some((l) => l.includes("failed to auto-start") && l.includes("manually"))).toBe(
			true,
		);
	});
});
