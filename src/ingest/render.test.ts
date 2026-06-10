/**
 * Tests for the render module.
 * Golden tests: exact operation shapes, 1-based blocks inversion, reconcile.
 */

import { describe, expect, test } from "bun:test";
import { renderOperations } from "./render.ts";
import type { ManifestPlanEntry, NormalizedPlan } from "./schema.ts";

// --- fixtures ---

function makeSimplePlan(): NormalizedPlan {
	return {
		schemaVersion: 1,
		source: { path: "docs/prd.md", contentHash: "sha256:abc123" },
		groups: [
			{
				kind: "standalone",
				logicalId: "g1",
				title: "Wire up CI",
				type: "task",
				priority: 2,
				description: "Set up CI pipeline",
				acceptance: ["CI passes"],
				sourceSpan: { start: 0, end: 100 },
				confidence: "high",
			},
		],
		ambiguities: [],
	};
}

function makePlanWithDeps(): NormalizedPlan {
	return {
		schemaVersion: 1,
		source: { path: "docs/prd.md", contentHash: "sha256:abc123" },
		groups: [
			{
				kind: "plan",
				logicalId: "g2",
				title: "Phase 1 — Auth",
				type: "feature",
				priority: 1,
				description: "Auth system implementing login, session management, and JWT token issuance.",
				acceptance: ["User can log in", "Session persists"],
				template: "feature",
				sourceSpan: { start: 100, end: 1000 },
				confidence: "high",
				units: [
					{
						logicalId: "u1",
						title: "Add login endpoint",
						type: "task",
						priority: 2,
						description: "Login API",
						acceptance: ["Returns JWT"],
						dependsOn: [],
						sourceSpan: { start: 100, end: 400 },
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
						sourceSpan: { start: 400, end: 700 },
						confidence: "high",
					},
				],
			},
		],
		ambiguities: [],
	};
}

function makeThreeUnitPlan(): NormalizedPlan {
	// u2.dependsOn = [u1], u3.dependsOn = [u1]
	// Expected: step1(u1).blocks=[2,3], step2(u2).blocks=[], step3(u3).blocks=[]
	return {
		schemaVersion: 1,
		source: { path: "docs/prd.md", contentHash: "sha256:def" },
		groups: [
			{
				kind: "plan",
				logicalId: "g1",
				title: "Three unit plan",
				type: "feature",
				priority: 1,
				description:
					"Three unit plan implementing the full data pipeline with fetch, store, and schedule steps.",
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
						dependsOn: [],
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
						dependsOn: ["u1"],
						sourceSpan: { start: 300, end: 600 },
						confidence: "high",
					},
					{
						logicalId: "u3",
						title: "U3",
						type: "task",
						priority: 2,
						description: "d",
						acceptance: ["a"],
						dependsOn: ["u1"],
						sourceSpan: { start: 600, end: 900 },
						confidence: "high",
					},
				],
			},
		],
		ambiguities: [],
	};
}

// --- standalone group ---

describe("renderOperations — standalone group", () => {
	test("produces one create operation with correct args", () => {
		const plan = makeSimplePlan();
		const result = renderOperations(plan, {});

		expect(result.operations).toHaveLength(1);
		const op = result.operations[0]!;
		expect(op.op).toBe("create");
		if (op.op !== "create") throw new Error("wrong op");
		expect(op.logicalId).toBe("g1");
		expect(op.args).toContain("--title");
		expect(op.args).toContain("Wire up CI");
		expect(op.args).toContain("--type");
		expect(op.args).toContain("task");
		expect(op.args).toContain("--priority");
		expect(op.args).toContain("2");
		expect(op.args).toContain("--description");
		expect(op.args).toContain("Set up CI pipeline");
		expect(op.args).toContain("--json");
	});

	test("dry-run commands array is non-empty", () => {
		const plan = makeSimplePlan();
		const result = renderOperations(plan, {});
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toContain("sd create");
	});
});

// --- multi-unit plan + dependsOn inversion ---

describe("renderOperations — plan group dependsOn → blocks inversion", () => {
	test("u2 dependsOn u1 → step 1 (u1) blocks=[2], step 2 (u2) blocks=[]", () => {
		const plan = makePlanWithDeps();
		const result = renderOperations(plan, {});

		// Should have: create (parent) + planSubmit
		expect(result.operations).toHaveLength(2);

		const planOp = result.operations[1]!;
		expect(planOp.op).toBe("planSubmit");
		if (planOp.op !== "planSubmit") throw new Error("wrong op");

		const planJson = planOp.planJson;
		const steps = planJson.sections.steps;

		expect(steps).toHaveLength(2);
		// step 1 (u1) should block step 2 (u2 at 1-based index 2)
		expect(steps[0]?.blocks).toEqual([2]);
		// step 2 (u2) has no one blocking it further
		expect(steps[1]?.blocks ?? []).toEqual([]);
	});

	test("u2, u3 both depend on u1 → step 1.blocks=[2,3], step 2.blocks=[], step 3.blocks=[]", () => {
		const plan = makeThreeUnitPlan();
		const result = renderOperations(plan, {});

		expect(result.operations).toHaveLength(2);
		const planOp = result.operations[1]!;
		expect(planOp.op).toBe("planSubmit");
		if (planOp.op !== "planSubmit") throw new Error("wrong op");

		const steps = planOp.planJson.sections.steps;
		expect(steps).toHaveLength(3);
		// u1 (step 1) blocks both u2 (2) and u3 (3)
		expect(steps[0]?.blocks).toEqual(expect.arrayContaining([2, 3]));
		expect(steps[0]?.blocks).toHaveLength(2);
		// u2, u3 have no outgoing blocks
		expect(steps[1]?.blocks ?? []).toEqual([]);
		expect(steps[2]?.blocks ?? []).toEqual([]);
	});

	test("plan JSON includes acceptance criteria at the group level", () => {
		const plan = makePlanWithDeps();
		const result = renderOperations(plan, {});

		const planOp = result.operations[1]!;
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		expect(planOp.planJson.sections.acceptance).toEqual(["User can log in", "Session persists"]);
	});

	test("plan JSON uses correct template", () => {
		const plan = makePlanWithDeps();
		const result = renderOperations(plan, {});

		const planOp = result.operations[1]!;
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		expect(planOp.planJson.template).toBe("feature");
	});

	test("planSubmit has overwrite:false for fresh create", () => {
		const plan = makePlanWithDeps();
		const result = renderOperations(plan, {});

		const planOp = result.operations[1]!;
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		expect(planOp.overwrite).toBe(false);
	});
});

// --- A2: context and approach populated ---

describe("renderOperations — A2: context and approach in plan JSON", () => {
	test("planJson.sections.context equals group description", () => {
		const plan = makePlanWithDeps();
		const result = renderOperations(plan, {});

		const planOp = result.operations[1]!;
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		expect(planOp.planJson.sections.context).toBe(
			"Auth system implementing login, session management, and JWT token issuance.",
		);
	});

	test("planJson.sections.approach synthesized from unit titles when group.approach absent", () => {
		const plan = makePlanWithDeps();
		const result = renderOperations(plan, {});

		const planOp = result.operations[1]!;
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		expect(planOp.planJson.sections.approach).toBeTruthy();
		expect(planOp.planJson.sections.approach).toContain("Add login endpoint");
	});

	test("planJson.sections.approach uses group.approach when present", () => {
		const plan = makePlanWithDeps();
		// Add approach to the plan group
		(plan.groups[0] as unknown as Record<string, unknown>).approach =
			"Implement login first, then wire up session middleware.";
		const result = renderOperations(plan, {});

		const planOp = result.operations[1]!;
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		expect(planOp.planJson.sections.approach).toBe(
			"Implement login first, then wire up session middleware.",
		);
	});
});

// --- B6: blocks deduplication ---

describe("renderOperations — B6: blocks arrays are deduplicated", () => {
	test("duplicate dependsOn does not produce duplicate blocks entries", () => {
		// Build a plan where a unit has duplicate dependsOn (which validator rejects,
		// but renderer should handle defensively)
		const plan: NormalizedPlan = {
			schemaVersion: 1,
			source: { path: "docs/prd.md", contentHash: "sha256:bb" },
			groups: [
				{
					kind: "plan",
					logicalId: "g1",
					title: "Dedup test plan",
					type: "feature",
					priority: 1,
					description: "A plan for testing duplicate blocks deduplication in the renderer output.",
					acceptance: ["a"],
					template: "feature",
					sourceSpan: { start: 0, end: 500 },
					confidence: "high",
					units: [
						{
							logicalId: "u1",
							title: "U1",
							type: "task",
							priority: 2,
							description: "d",
							acceptance: ["a"],
							dependsOn: [],
							sourceSpan: { start: 0, end: 200 },
							confidence: "high",
						},
						{
							logicalId: "u2",
							title: "U2",
							type: "task",
							priority: 2,
							description: "d",
							acceptance: ["a"],
							// Duplicate dependsOn — renderer must dedup blocks
							dependsOn: ["u1", "u1"],
							sourceSpan: { start: 200, end: 400 },
							confidence: "high",
						},
					],
				},
			],
			ambiguities: [],
		};

		const result = renderOperations(plan, {});
		const planOp = result.operations[1]!;
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		const step1 = planOp.planJson.sections.steps[0]!;
		// Even with duplicate dep, step1.blocks should contain 2 only once
		const blocks = step1.blocks ?? [];
		const unique = [...new Set(blocks)];
		expect(blocks).toEqual(unique);
	});
});

// --- B8: standalone adopt preview ---

describe("renderOperations — B8: standalone adopt path emits adopt note", () => {
	test("when existingSeedId is set, commands shows adopt note not sd create", () => {
		const plan = makeSimplePlan();
		const manifestEntry = {
			logicalId: "g1",
			kind: "standalone" as const,
			seedId: "proj-adopt-01",
		};

		const result = renderOperations(plan, { g1: manifestEntry });

		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toContain("adopt");
		expect(result.commands[0]).toContain("proj-adopt-01");
		expect(result.commands[0]).not.toContain("sd create");
	});
});

// --- reconcile render ---

describe("renderOperations — reconcile (existing manifest entry)", () => {
	test("emits existing_seed for already-mapped units, overwrite:true on planSubmit", () => {
		const plan = makePlanWithDeps();

		const manifestEntry: ManifestPlanEntry = {
			logicalId: "g2",
			kind: "plan",
			seedId: "proj-9c4d",
			planId: "pl-7f2a",
			units: {
				u1: "proj-1101",
				// u2 is NOT in manifest — it should be a fresh step
			},
		};

		const result = renderOperations(plan, { g2: manifestEntry });

		expect(result.operations).toHaveLength(2);

		// Parent create should not re-create (manifest has seedId)
		const createOp = result.operations[0]!;
		expect(createOp.op).toBe("create");
		if (createOp.op !== "create") throw new Error("wrong op");
		// In reconcile mode, existingSeedId is provided instead of re-creating
		expect(createOp.existingSeedId).toBe("proj-9c4d");

		const planOp = result.operations[1]!;
		expect(planOp.op).toBe("planSubmit");
		if (planOp.op !== "planSubmit") throw new Error("wrong op");
		expect(planOp.overwrite).toBe(true);

		const steps = planOp.planJson.sections.steps;
		// u1 already mapped → existing_seed
		expect(steps[0]?.existing_seed).toBe("proj-1101");
		// u2 not in manifest → fresh (no existing_seed)
		expect(steps[1]?.existing_seed).toBeUndefined();
	});
});
