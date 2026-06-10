/**
 * Tests for the normalized-plan validator.
 * TDD: every reject path and a happy case.
 */

import { describe, expect, test } from "bun:test";
import type { NormalizedPlan, PlanGroup, StandaloneGroup } from "./schema.ts";
import { validateNormalizedPlan } from "./validate.ts";

// --- helpers ---

/** Valid 64-char hex hash for test fixtures. */
const VALID_HASH = `sha256:${"a".repeat(64)}`;

function makeStandalone(overrides: Partial<StandaloneGroup> = {}): StandaloneGroup {
	return {
		kind: "standalone",
		logicalId: "g1",
		title: "Wire up CI",
		type: "task",
		priority: 2,
		description: "Some work",
		acceptance: ["CI passes"],
		sourceSpan: { start: 0, end: 100 },
		confidence: "high",
		...overrides,
	};
}

function makePlan(overrides: Partial<PlanGroup> = {}): PlanGroup {
	return {
		kind: "plan",
		logicalId: "g2",
		title: "Phase 1",
		type: "feature",
		priority: 1,
		description: "A big feature that implements the core functionality of the system end-to-end.",
		acceptance: ["Feature ships"],
		template: "feature",
		sourceSpan: { start: 0, end: 500 },
		confidence: "high",
		units: [
			{
				logicalId: "u1",
				title: "Add login",
				type: "task",
				priority: 2,
				description: "Endpoint",
				acceptance: ["Login works"],
				dependsOn: [],
				sourceSpan: { start: 10, end: 200 },
				confidence: "high",
			},
			{
				logicalId: "u2",
				title: "Add session middleware",
				type: "task",
				priority: 2,
				description: "Middleware",
				acceptance: ["Session created"],
				dependsOn: ["u1"],
				sourceSpan: { start: 200, end: 400 },
				confidence: "high",
			},
		],
		...overrides,
	};
}

function makePlan2(): NormalizedPlan {
	return {
		schemaVersion: 1,
		source: { path: "docs/prd.md", contentHash: VALID_HASH },
		groups: [makeStandalone(), makePlan()],
		ambiguities: [],
	};
}

// --- tests ---

describe("validateNormalizedPlan — happy path", () => {
	test("valid plan with standalone + plan group passes", () => {
		const result = validateNormalizedPlan(makePlan2());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.errors).toHaveLength(0);
		}
	});
});

describe("validateNormalizedPlan — reject: bad kind", () => {
	test("unknown kind is rejected", () => {
		const plan = makePlan2();
		// Coerce to bypass TS type system
		(plan.groups[0] as unknown as Record<string, unknown>).kind = "unknown-kind";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("kind"))).toBe(true);
		}
	});
});

describe("validateNormalizedPlan — reject: plan with < 2 units", () => {
	test("plan group with 0 units is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as PlanGroup).units = [];
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("units"))).toBe(true);
		}
	});

	test("plan group with 1 unit is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as PlanGroup).units = [
			{
				logicalId: "u1",
				title: "Only unit",
				type: "task",
				priority: 2,
				description: "d",
				acceptance: ["a"],
				dependsOn: [],
				sourceSpan: { start: 0, end: 100 },
				confidence: "high",
			},
		];
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("units"))).toBe(true);
		}
	});
});

describe("validateNormalizedPlan — reject: plan with 0 acceptance", () => {
	test("plan group with empty acceptance is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as PlanGroup).acceptance = [];
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("acceptance"))).toBe(true);
		}
	});
});

describe("validateNormalizedPlan — reject: dependsOn to non-sibling", () => {
	test("dependsOn referencing a group logicalId (not sibling unit) is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as PlanGroup).units[1]!.dependsOn = ["g1"]; // g1 is a group, not a sibling unit
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("g1"))).toBe(true);
		}
	});

	test("dependsOn referencing a unit from another plan is rejected", () => {
		const plan = makePlan2();
		// Add a second plan group with its own units
		plan.groups.push({
			kind: "plan",
			logicalId: "g3",
			title: "Phase 2",
			type: "feature",
			priority: 1,
			description:
				"Phase 2 of the feature implementing secondary functionality with cross-plan reference test.",
			acceptance: ["a"],
			template: "feature",
			sourceSpan: { start: 500, end: 1000 },
			confidence: "high",
			units: [
				{
					logicalId: "x1",
					title: "X1",
					type: "task",
					priority: 2,
					description: "d",
					acceptance: ["a"],
					dependsOn: ["u1"], // u1 is in g2, not g3 — cross-plan reference
					sourceSpan: { start: 500, end: 700 },
					confidence: "high",
				},
				{
					logicalId: "x2",
					title: "X2",
					type: "task",
					priority: 2,
					description: "d",
					acceptance: ["a"],
					dependsOn: [],
					sourceSpan: { start: 700, end: 900 },
					confidence: "high",
				},
			],
		});
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("u1"))).toBe(true);
		}
	});
});

describe("validateNormalizedPlan — reject: self-edge", () => {
	test("unit with dependsOn pointing to itself is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as PlanGroup).units[0]!.dependsOn = ["u1"]; // u1 depends on u1
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("self"))).toBe(true);
		}
	});
});

describe("validateNormalizedPlan — reject: dependency cycle", () => {
	test("u1 → u2 → u1 cycle is rejected", () => {
		const plan: NormalizedPlan = {
			schemaVersion: 1,
			source: { path: "docs/prd.md", contentHash: VALID_HASH },
			groups: [
				{
					kind: "plan",
					logicalId: "g1",
					title: "Plan",
					type: "feature",
					priority: 1,
					description:
						"A feature plan with cyclic dependencies to test the cycle detection algorithm.",
					acceptance: ["a"],
					template: "feature",
					sourceSpan: { start: 0, end: 1000 },
					confidence: "high",
					units: [
						{
							logicalId: "u1",
							title: "U1",
							type: "task",
							priority: 2,
							description: "d",
							acceptance: ["a"],
							dependsOn: ["u2"], // u1 depends on u2
							sourceSpan: { start: 0, end: 300 },
							confidence: "high",
						},
						{
							logicalId: "u2",
							title: "U2",
							type: "task",
							priority: 2,
							description: "d",
							acceptance: ["a"],
							dependsOn: ["u1"], // u2 depends on u1 → cycle
							sourceSpan: { start: 300, end: 600 },
							confidence: "high",
						},
					],
				},
			],
			ambiguities: [],
		};
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
		}
	});
});

describe("validateNormalizedPlan — reject: missing required fields", () => {
	test("standalone group missing title is rejected", () => {
		const plan = makePlan2();
		(plan.groups[0] as unknown as Record<string, unknown>).title = "";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("title"))).toBe(true);
		}
	});

	test("standalone group missing description is rejected", () => {
		const plan = makePlan2();
		(plan.groups[0] as unknown as Record<string, unknown>).description = "";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("description"))).toBe(true);
		}
	});

	test("invalid priority (5) is rejected", () => {
		const plan = makePlan2();
		(plan.groups[0] as unknown as Record<string, unknown>).priority = 5;
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("priority"))).toBe(true);
		}
	});

	test("invalid type is rejected", () => {
		const plan = makePlan2();
		(plan.groups[0] as unknown as Record<string, unknown>).type = "invalid-type";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("type"))).toBe(true);
		}
	});

	test("plan group missing template is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as unknown as Record<string, unknown>).template = undefined;
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("template"))).toBe(true);
		}
	});
});

// --- B4: null/undefined plan.groups never throws ---

describe("validateNormalizedPlan — B4: null/undefined groups never throws", () => {
	test("empty object {} returns structured error, does not throw", () => {
		const result = validateNormalizedPlan({} as unknown as NormalizedPlan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("groups"))).toBe(true);
		}
	});

	test("{groups: null} returns structured error, does not throw", () => {
		const result = validateNormalizedPlan({ groups: null } as unknown as NormalizedPlan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("groups"))).toBe(true);
		}
	});
});

// --- B5: cross-group duplicate logicalId ---

describe("validateNormalizedPlan — B5: duplicate logicalIds rejected", () => {
	test("two groups with the same logicalId are rejected", () => {
		const plan = makePlan2();
		// Give the standalone group the same logicalId as the plan group
		(plan.groups[0] as unknown as Record<string, unknown>).logicalId = "g2";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("Duplicate") && e.includes("g2"))).toBe(true);
		}
	});
});

// --- A2: v1 template enforcement and description >= 50 chars ---

describe("validateNormalizedPlan — A2: plan group feature-only + description >= 50 chars", () => {
	test("plan group with template 'bug' is rejected in v1", () => {
		const plan = makePlan2();
		(plan.groups[1] as unknown as Record<string, unknown>).template = "bug";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("template") && e.includes("feature"))).toBe(true);
		}
	});

	test("plan group with template 'refactor' is rejected in v1", () => {
		const plan = makePlan2();
		(plan.groups[1] as unknown as Record<string, unknown>).template = "refactor";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("template"))).toBe(true);
		}
	});

	test("plan group description < 50 chars is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as unknown as Record<string, unknown>).description = "too short";
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("description") && e.includes("50"))).toBe(true);
		}
	});

	test("plan group with exactly 50 char description passes", () => {
		const plan = makePlan2();
		(plan.groups[1] as unknown as Record<string, unknown>).description = "A".repeat(50);
		const result = validateNormalizedPlan(plan);
		// May fail for other reasons, but NOT for description length
		const descErr = result.ok
			? false
			: (result as { ok: false; errors: string[] }).errors.some(
					(e) => e.includes("description") && e.includes("50"),
				);
		expect(descErr).toBe(false);
	});
});

// --- FIX 2: envelope-level checks ---

describe("validateNormalizedPlan — FIX 2: envelope hardening (structured errors, never throw)", () => {
	test("schemaVersion !== 1 is rejected with structured error", () => {
		const plan = { ...makePlan2(), schemaVersion: 2 } as unknown as NormalizedPlan;
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
		}
	});

	test("missing source object is rejected", () => {
		const plan = { ...makePlan2() } as unknown as NormalizedPlan;
		(plan as unknown as Record<string, unknown>).source = undefined;
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("source"))).toBe(true);
		}
	});

	test("source.path empty string is rejected", () => {
		const plan: NormalizedPlan = {
			...makePlan2(),
			source: { path: "", contentHash: "sha256:" + "a".repeat(64) },
		};
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("source.path"))).toBe(true);
		}
	});

	test("source.contentHash with wrong format is rejected", () => {
		const plan: NormalizedPlan = {
			...makePlan2(),
			source: { path: "docs/prd.md", contentHash: "not-a-hash" },
		};
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("contentHash"))).toBe(true);
		}
	});

	test("source.contentHash sha256 with wrong hex length is rejected", () => {
		const plan: NormalizedPlan = {
			...makePlan2(),
			source: { path: "docs/prd.md", contentHash: "sha256:abc123" }, // too short
		};
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("contentHash"))).toBe(true);
		}
	});

	test("ambiguities as non-array object is rejected", () => {
		const plan = { ...makePlan2() } as unknown as NormalizedPlan;
		(plan as unknown as Record<string, unknown>).ambiguities = { foo: "bar" };
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("ambiguities"))).toBe(true);
		}
	});

	test("groups as empty array is rejected", () => {
		const plan: NormalizedPlan = { ...makePlan2(), groups: [] };
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("groups"))).toBe(true);
		}
	});

	test("group logicalId colliding with unit logicalId is rejected (global namespace)", () => {
		// g2 is used as both a group logicalId and a unit logicalId
		const plan = makePlan2();
		// Set the plan group's first unit to have the same logicalId as the standalone group
		(plan.groups[1] as PlanGroup).units[0]!.logicalId = "g1"; // g1 is the standalone group's id
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("Duplicate") && e.includes("g1"))).toBe(true);
		}
	});

	test("fully valid plan with correct schemaVersion and source passes envelope checks", () => {
		const result = validateNormalizedPlan(makePlan2());
		expect(result.ok).toBe(true);
	});
});

// --- B6: duplicate dependsOn entries rejected ---

describe("validateNormalizedPlan — B6: duplicate dependsOn rejected", () => {
	test("unit with duplicate dependsOn entry is rejected", () => {
		const plan = makePlan2();
		(plan.groups[1] as PlanGroup).units[1]!.dependsOn = ["u1", "u1"];
		const result = validateNormalizedPlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
		}
	});
});
