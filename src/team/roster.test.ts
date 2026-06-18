import { describe, expect, test } from "bun:test";
import { resolveCommitIdentity } from "./roster.ts";

// Canonical roster fixture mirroring templates/.team/roster.json
const ROSTER = {
	version: 1,
	project: "test-project",
	email_pattern: "{id}+{login}@users.noreply.github.com",
	roles: {
		captain: { login: "LucraTitan", id: 268125578, name: "LucraTitan", label: "Captain" },
		"coder-a": { login: "K-Bot-T1", id: 290088768, name: "K-Bot-T1", label: "Coder-A" },
		"coder-b": { login: "K-bot-T2", id: 292117888, name: "K-bot-T2", label: "Coder-B" },
		auditor: { login: "K-bot-T3", id: 292116934, name: "K-bot-T3", label: "Auditor" },
		orchestrator: {
			login: "KevinGastelum",
			id: 97716634,
			name: "Kevin Gastelum",
			label: "Orchestrator",
		},
	},
	capabilities: {
		lead: "captain",
		scout: "captain",
		builder: ["coder-a", "coder-b"],
		reviewer: "auditor",
		merger: "orchestrator",
	},
};

describe("resolveCommitIdentity", () => {
	describe("string capability → single role", () => {
		test("lead resolves to captain (LucraTitan)", () => {
			const result = resolveCommitIdentity(ROSTER, "lead", "agent-lead-0");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("LucraTitan");
			expect(result?.email).toBe("268125578+LucraTitan@users.noreply.github.com");
		});

		test("scout resolves to captain", () => {
			const result = resolveCommitIdentity(ROSTER, "scout", "scout-0");
			expect(result?.name).toBe("LucraTitan");
		});

		test("reviewer resolves to auditor (K-bot-T3)", () => {
			const result = resolveCommitIdentity(ROSTER, "reviewer", "reviewer-0");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("K-bot-T3");
			expect(result?.email).toBe("292116934+K-bot-T3@users.noreply.github.com");
		});

		test("merger resolves to orchestrator (Kevin Gastelum)", () => {
			const result = resolveCommitIdentity(ROSTER, "merger", "merger-0");
			expect(result).not.toBeNull();
			expect(result?.name).toBe("Kevin Gastelum");
			expect(result?.email).toBe("97716634+KevinGastelum@users.noreply.github.com");
		});
	});

	describe("array capability (builder) → deterministic pick by agentName", () => {
		test("same agentName always returns the same role", () => {
			const r1 = resolveCommitIdentity(ROSTER, "builder", "builder-alpha");
			const r2 = resolveCommitIdentity(ROSTER, "builder", "builder-alpha");
			expect(r1).not.toBeNull();
			expect(r1?.name).toBe(r2?.name);
			expect(r1?.email).toBe(r2?.email);
		});

		test("two different agentNames can resolve to different roles", () => {
			// We need two names that hash to different indices mod 2.
			// "builder-alpha" and "builder-beta" — at least one pair should differ
			// across all possible hash functions that rotate over [0,1].
			// We test many names and assert not all resolve to the same role.
			const names = [
				"agent-0",
				"agent-1",
				"builder-alpha",
				"builder-beta",
				"worker-x",
				"worker-y",
			];
			const resolved = names.map((n) => resolveCommitIdentity(ROSTER, "builder", n)?.name);
			const unique = new Set(resolved);
			// At least two distinct names exist in the [coder-a, coder-b] set
			expect(unique.size).toBeGreaterThan(1);
		});

		test("resolves to coder-a or coder-b (valid roles only)", () => {
			const validNames = new Set(["K-Bot-T1", "K-bot-T2"]);
			const testAgentNames = ["builder-0", "builder-1", "builder-abc", "builder-xyz"];
			for (const agentName of testAgentNames) {
				const result = resolveCommitIdentity(ROSTER, "builder", agentName);
				expect(result).not.toBeNull();
				expect(validNames.has(result!.name)).toBe(true);
			}
		});

		test("email derivation matches {id}+{login}@users.noreply.github.com for coder-a", () => {
			// Force coder-a: find an agentName that hashes to index 0
			// Brute-force: try names until one lands on coder-a
			let coderAResult: { name: string; email: string } | null = null;
			for (let i = 0; i < 100; i++) {
				const result = resolveCommitIdentity(ROSTER, "builder", `probe-${i}`);
				if (result?.name === "K-Bot-T1") {
					coderAResult = result;
					break;
				}
			}
			expect(coderAResult).not.toBeNull();
			expect(coderAResult?.email).toBe("290088768+K-Bot-T1@users.noreply.github.com");
		});

		test("email derivation matches {id}+{login}@users.noreply.github.com for coder-b", () => {
			let coderBResult: { name: string; email: string } | null = null;
			for (let i = 0; i < 100; i++) {
				const result = resolveCommitIdentity(ROSTER, "builder", `probe-${i}`);
				if (result?.name === "K-bot-T2") {
					coderBResult = result;
					break;
				}
			}
			expect(coderBResult).not.toBeNull();
			expect(coderBResult?.email).toBe("292117888+K-bot-T2@users.noreply.github.com");
		});
	});

	describe("null / no-op cases", () => {
		test("unknown capability returns null", () => {
			const result = resolveCommitIdentity(ROSTER, "unknown-cap", "agent-0");
			expect(result).toBeNull();
		});

		test("null input returns null", () => {
			const result = resolveCommitIdentity(null, "builder", "agent-0");
			expect(result).toBeNull();
		});

		test("undefined input returns null", () => {
			const result = resolveCommitIdentity(undefined, "builder", "agent-0");
			expect(result).toBeNull();
		});

		test("malformed json (non-object) returns null", () => {
			expect(resolveCommitIdentity("not an object", "builder", "a")).toBeNull();
			expect(resolveCommitIdentity(42, "builder", "a")).toBeNull();
			expect(resolveCommitIdentity([], "builder", "a")).toBeNull();
		});

		test("missing capabilities key returns null", () => {
			const badRoster = { ...ROSTER, capabilities: undefined };
			expect(resolveCommitIdentity(badRoster, "builder", "a")).toBeNull();
		});

		test("missing roles key returns null", () => {
			const badRoster = { ...ROSTER, roles: undefined };
			expect(resolveCommitIdentity(badRoster, "builder", "a")).toBeNull();
		});

		test("capability mapped to unknown role key returns null", () => {
			const badRoster = {
				...ROSTER,
				capabilities: { builder: "nonexistent-role" },
			};
			expect(resolveCommitIdentity(badRoster, "builder", "a")).toBeNull();
		});

		test("empty array capability returns null", () => {
			const badRoster = {
				...ROSTER,
				capabilities: { builder: [] },
			};
			expect(resolveCommitIdentity(badRoster, "builder", "a")).toBeNull();
		});

		test("never throws even with totally garbage input", () => {
			expect(() => resolveCommitIdentity({ roles: null, capabilities: null }, "x", "y")).not.toThrow();
			expect(() =>
				resolveCommitIdentity(
					{ roles: {}, capabilities: { x: { not: "a string or array" } } },
					"x",
					"y",
				),
			).not.toThrow();
		});
	});

	describe("custom email_pattern", () => {
		test("defaults to {id}+{login}@users.noreply.github.com when pattern absent", () => {
			const rosterNoPattern = { ...ROSTER } as Record<string, unknown>;
			delete rosterNoPattern["email_pattern"];
			const result = resolveCommitIdentity(rosterNoPattern, "reviewer", "r-0");
			expect(result?.email).toBe("292116934+K-bot-T3@users.noreply.github.com");
		});

		test("substitutes {id} and {login} in a custom email_pattern", () => {
			const customRoster = {
				...ROSTER,
				email_pattern: "{login}@bots.example.com",
			};
			const result = resolveCommitIdentity(customRoster, "reviewer", "r-0");
			expect(result?.email).toBe("K-bot-T3@bots.example.com");
		});
	});
});
