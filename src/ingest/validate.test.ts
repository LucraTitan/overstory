/**
 * Tests for the normalized-plan validator.
 * TDD: every reject path and a happy case.
 */

import { describe, expect, test } from "bun:test";
import type { NormalizedPlan, PlanGroup, StandaloneGroup } from "./schema.ts";
import { validateNormalizedPlan } from "./validate.ts";

// --- helpers ---

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
		description: "Big feature",
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
		source: { path: "docs/prd.md", contentHash: "sha256:abc123" },
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
			description: "d",
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
			source: { path: "docs/prd.md", contentHash: "sha256:abc" },
			groups: [
				{
					kind: "plan",
					logicalId: "g1",
					title: "Plan",
					type: "feature",
					priority: 1,
					description: "d",
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
