import { describe, expect, test } from "bun:test";
import type { SaplingRuntimeConfig } from "../types.ts";
import {
	DEFAULT_SAPLING_PROXY_URL,
	ensureSaplingProxyRunning,
	proxyPort,
	resolveSaplingProxy,
} from "./sapling-proxy.ts";

describe("resolveSaplingProxy", () => {
	test("disabled by default (no config, no env)", () => {
		const r = resolveSaplingProxy(undefined, {});
		expect(r.enabled).toBe(false);
		expect(r.proxyUrl).toBe(DEFAULT_SAPLING_PROXY_URL);
	});

	test("disabled when config.subscriptionProxy is false", () => {
		const config: SaplingRuntimeConfig = { subscriptionProxy: false };
		const r = resolveSaplingProxy(config, {});
		expect(r.enabled).toBe(false);
	});

	test("enabled when config.subscriptionProxy is true", () => {
		const config: SaplingRuntimeConfig = { subscriptionProxy: true };
		const r = resolveSaplingProxy(config, {});
		expect(r.enabled).toBe(true);
		expect(r.proxyUrl).toBe(DEFAULT_SAPLING_PROXY_URL);
	});

	test("config.proxyUrl overrides the default URL", () => {
		const config: SaplingRuntimeConfig = {
			subscriptionProxy: true,
			proxyUrl: "http://127.0.0.1:9999",
		};
		const r = resolveSaplingProxy(config, {});
		expect(r.proxyUrl).toBe("http://127.0.0.1:9999");
	});

	test("env fallback OV_SAPLING_SUBSCRIPTION_PROXY=1 enables when config absent", () => {
		const r = resolveSaplingProxy(undefined, { OV_SAPLING_SUBSCRIPTION_PROXY: "1" });
		expect(r.enabled).toBe(true);
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

	test("config true wins even if env toggle is off", () => {
		const config: SaplingRuntimeConfig = { subscriptionProxy: true };
		const r = resolveSaplingProxy(config, { OV_SAPLING_SUBSCRIPTION_PROXY: "0" });
		expect(r.enabled).toBe(true);
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

describe("ensureSaplingProxyRunning", () => {
	test("no-op when proxy already reachable (does not spawn)", async () => {
		let spawned = false;
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => true,
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

	test("auto-starts detached when down, then becomes ready", async () => {
		let spawnCount = 0;
		let probeCalls = 0;
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			// First probe: down. After spawn: up.
			probe: async () => {
				probeCalls += 1;
				return probeCalls > 1;
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
		// Operator-facing log must mention the pid and how to stop it.
		expect(
			logs.some((l) => l.includes("started anthropic-bearer-proxy") && l.includes("4242")),
		).toBe(true);
		expect(logs.some((l) => l.includes("kill 4242"))).toBe(true);
	});

	test("returns failed (not ready) when proxy never comes up after start", async () => {
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => false, // never reachable
			spawn: () => 777,
			sleep: async () => {},
			log: (m) => logs.push(m),
		});
		expect(result.ready).toBe(false);
		expect(result.status).toBe("failed");
		// Must surface a clear manual-start instruction.
		expect(logs.some((l) => l.includes("did not become ready") && l.includes("manually"))).toBe(
			true,
		);
	});

	test("returns failed when spawn throws (surfaces manual-start guidance)", async () => {
		const logs: string[] = [];
		const result = await ensureSaplingProxyRunning(DEFAULT_SAPLING_PROXY_URL, {
			probe: async () => false,
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
