/**
 * Tests for the `ov ingest` command.
 *
 * Behavior-table coverage: preview vs apply across new/unchanged/changed states.
 * Uses injected client and temp dirs. Asserts exit codes and no-sd on unchanged-apply.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateOp, PlanSubmitOp } from "../ingest/render.ts";
import type { NormalizedPlan } from "../ingest/schema.ts";
import type { PlanSubmitResult, SeedsPlanClient } from "../tracker/seeds-plan.ts";
import { ingestCommand } from "./ingest.ts";

// --- fixtures ---

const VALID_STANDALONE_PLAN: NormalizedPlan = {
	schemaVersion: 1,
	source: { path: "docs/prd.md", contentHash: "sha256:aabbcc" },
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

const VALID_PLAN_WITH_UNITS: NormalizedPlan = {
	schemaVersion: 1,
	source: { path: "docs/auth.md", contentHash: "sha256:def456" },
	groups: [
		{
			kind: "plan",
			logicalId: "g2",
			title: "Auth System",
			type: "feature",
			priority: 1,
			description: "Full auth",
			acceptance: ["Login works"],
			template: "feature",
			sourceSpan: { start: 0, end: 500 },
			confidence: "high",
			units: [
				{
					logicalId: "u1",
					title: "Login endpoint",
					type: "task",
					priority: 2,
					description: "Add login",
					acceptance: ["Returns JWT"],
					dependsOn: [],
					sourceSpan: { start: 0, end: 200 },
					confidence: "high",
				},
				{
					logicalId: "u2",
					title: "Session middleware",
					type: "task",
					priority: 2,
					description: "Add middleware",
					acceptance: ["Session works"],
					dependsOn: ["u1"],
					sourceSpan: { start: 200, end: 400 },
					confidence: "high",
				},
			],
		},
	],
	ambiguities: [],
};

// --- fake client factory ---

interface FakeClientTracker {
	createCalls: Array<{ op: CreateOp }>;
	planSubmitCalls: Array<{ parentId: string; op: PlanSubmitOp }>;
}

function makeFakeClient(tracker: FakeClientTracker): SeedsPlanClient {
	let seedCounter = 1;
	let planCounter = 1;

	return {
		async executeCreate(op: CreateOp): Promise<string> {
			if (op.existingSeedId !== undefined) return op.existingSeedId;
			tracker.createCalls.push({ op });
			return `proj-${String(seedCounter++).padStart(4, "0")}`;
		},
		async executePlanSubmit(parentId: string, op: PlanSubmitOp): Promise<PlanSubmitResult> {
			tracker.planSubmitCalls.push({ parentId, op });
			const planId = `pl-${String(planCounter++).padStart(4, "0")}`;
			// Return one child per step
			const children = op.planJson.sections.steps.map(
				(_, i) => `proj-child-${String(i + 1).padStart(4, "0")}`,
			);
			return { planId, children, obsolete: [] };
		},
	};
}

// --- temp dir helpers ---

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-ingest-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function writePlanFile(plan: NormalizedPlan): Promise<string> {
	const planPath = join(tempDir, "plan.json");
	await writeFile(planPath, JSON.stringify(plan), "utf8");
	return planPath;
}

async function ensureOvDir(): Promise<string> {
	const ovDir = join(tempDir, ".overstory");
	await mkdir(ovDir, { recursive: true });
	return ovDir;
}

// --- TESTS ---

describe("ingestCommand — preview (no --apply)", () => {
	test("new source: exits 0 and does NOT call sd", async () => {
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const client = makeFakeClient(tracker);

		const result = await ingestCommand(
			{
				plan: planPath,
				apply: false,
				newPlan: false,
				cwd: tempDir,
				json: false,
			},
			client,
		);

		expect(result.exitCode).toBe(0);
		expect(result.sourceState).toBe("new");
		expect(tracker.createCalls).toHaveLength(0);
		expect(tracker.planSubmitCalls).toHaveLength(0);
	});

	test("unchanged source: exits 0 and does NOT call sd", async () => {
		// First ingest to populate the manifest
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		const tracker1: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker1),
		);

		// Now preview with same content
		const tracker2: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const result = await ingestCommand(
			{
				plan: planPath,
				apply: false,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker2),
		);

		expect(result.exitCode).toBe(0);
		expect(result.sourceState).toBe("unchanged");
		expect(tracker2.createCalls).toHaveLength(0);
	});

	test("changed source: exits non-zero and does NOT call sd", async () => {
		// Ingest original
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient({ createCalls: [], planSubmitCalls: [] }),
		);

		// Modify plan (different hash)
		const changedPlan: NormalizedPlan = {
			...VALID_STANDALONE_PLAN,
			source: { ...VALID_STANDALONE_PLAN.source, contentHash: "sha256:changed999" },
		};
		const changedPlanPath = join(tempDir, "changed-plan.json");
		await writeFile(changedPlanPath, JSON.stringify(changedPlan), "utf8");

		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const result = await ingestCommand(
			{
				plan: changedPlanPath,
				apply: false,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker),
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.sourceState).toBe("changed");
		expect(tracker.createCalls).toHaveLength(0);
	});

	test("unchanged source + --new-plan: exits 0 and renders fresh-create (NOT no-op)", async () => {
		// Ingest to establish manifest entry
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient({ createCalls: [], planSubmitCalls: [] }),
		);

		// Now preview with same content but --new-plan: must NOT be a no-op
		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const result = await ingestCommand(
			{
				plan: planPath,
				apply: false,
				newPlan: true, // override: force fresh-create even though unchanged
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker),
		);

		// preview → exit 0, no sd calls, commands are fresh-create commands (non-empty)
		expect(result.exitCode).toBe(0);
		expect(tracker.createCalls).toHaveLength(0); // preview: no actual sd calls
		expect(result.commands.length).toBeGreaterThan(0); // fresh-create preview commands rendered
	});

	test("unchanged source + --new-plan + --apply: fresh-creates (overwrites manifest); exits 0", async () => {
		// Ingest to establish manifest entry
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		const tracker1: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker1),
		);
		expect(tracker1.createCalls).toHaveLength(1);

		// Apply with --new-plan on the same (unchanged) content: must fresh-create, not no-op
		const tracker2: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const result = await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: true, // override: force fresh-create
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker2),
		);

		expect(result.exitCode).toBe(0);
		expect(tracker2.createCalls).toHaveLength(1); // fresh create ran (not no-op)
	});

	test("changed source + --new-plan: exits 0 (preview ok), does NOT call sd", async () => {
		// Ingest original
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient({ createCalls: [], planSubmitCalls: [] }),
		);

		// Changed + --new-plan preview
		const changedPlan: NormalizedPlan = {
			...VALID_STANDALONE_PLAN,
			source: { ...VALID_STANDALONE_PLAN.source, contentHash: "sha256:changed888" },
		};
		const changedPath = join(tempDir, "changed2.json");
		await writeFile(changedPath, JSON.stringify(changedPlan), "utf8");

		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const result = await ingestCommand(
			{
				plan: changedPath,
				apply: false,
				newPlan: true,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker),
		);

		expect(result.exitCode).toBe(0);
		expect(tracker.createCalls).toHaveLength(0);
	});
});

describe("ingestCommand — apply", () => {
	test("new source: calls sd and writes manifest; exits 0", async () => {
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };

		const result = await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker),
		);

		expect(result.exitCode).toBe(0);
		expect(result.sourceState).toBe("new");
		expect(tracker.createCalls).toHaveLength(1); // one standalone
	});

	test("unchanged source: no sd calls; exits 0", async () => {
		// Setup manifest
		const planPath = await writePlanFile(VALID_STANDALONE_PLAN);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient({ createCalls: [], planSubmitCalls: [] }),
		);

		// Second apply — same plan
		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const result = await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker),
		);

		expect(result.exitCode).toBe(0);
		expect(result.sourceState).toBe("unchanged");
		expect(tracker.createCalls).toHaveLength(0);
		expect(tracker.planSubmitCalls).toHaveLength(0);
	});

	test("changed source: reconciles via planSubmit --overwrite; exits 0", async () => {
		const planPath = await writePlanFile(VALID_PLAN_WITH_UNITS);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");

		// First apply
		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient({ createCalls: [], planSubmitCalls: [] }),
		);

		// Changed plan (different hash)
		const changedPlan: NormalizedPlan = {
			...VALID_PLAN_WITH_UNITS,
			source: { ...VALID_PLAN_WITH_UNITS.source, contentHash: "sha256:updated111" },
		};
		const changedPath = join(tempDir, "changed-plan.json");
		await writeFile(changedPath, JSON.stringify(changedPlan), "utf8");

		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };
		const result = await ingestCommand(
			{
				plan: changedPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker),
		);

		expect(result.exitCode).toBe(0);
		expect(result.sourceState).toBe("changed");
		// planSubmit should be called with overwrite:true
		expect(tracker.planSubmitCalls).toHaveLength(1);
		expect(tracker.planSubmitCalls[0]?.op.overwrite).toBe(true);
	});

	test("plan group with units: planSubmit called with correct parentId", async () => {
		const planPath = await writePlanFile(VALID_PLAN_WITH_UNITS);
		await ensureOvDir();
		const manifestPath = join(tempDir, ".overstory", "ingestion-manifest.json");
		const tracker: FakeClientTracker = { createCalls: [], planSubmitCalls: [] };

		await ingestCommand(
			{
				plan: planPath,
				apply: true,
				newPlan: false,
				manifest: manifestPath,
				cwd: tempDir,
				json: false,
			},
			makeFakeClient(tracker),
		);

		expect(tracker.createCalls).toHaveLength(1); // parent create
		expect(tracker.planSubmitCalls).toHaveLength(1);
		// The parent seed id from create call is forwarded to planSubmit
		const parentId = tracker.planSubmitCalls[0]?.parentId ?? "";
		expect(parentId.length).toBeGreaterThan(0);
	});
});

describe("ingestCommand — invalid plan", () => {
	test("exits non-zero on invalid JSON content", async () => {
		const badPath = join(tempDir, "bad.json");
		await writeFile(badPath, "not-valid-json", "utf8");

		const result = await ingestCommand(
			{ plan: badPath, apply: false, newPlan: false, cwd: tempDir, json: false },
			makeFakeClient({ createCalls: [], planSubmitCalls: [] }),
		);

		expect(result.exitCode).not.toBe(0);
	});

	test("exits non-zero on schema validation failure (plan with 0 units)", async () => {
		const invalidPlan: NormalizedPlan = {
			schemaVersion: 1,
			source: { path: "docs/x.md", contentHash: "sha256:xxx" },
			groups: [
				{
					kind: "plan",
					logicalId: "g1",
					title: "Bad plan",
					type: "feature",
					priority: 1,
					description: "d",
					acceptance: ["a"],
					template: "feature",
					sourceSpan: { start: 0, end: 100 },
					confidence: "high",
					units: [], // INVALID: < 2 units
				},
			],
			ambiguities: [],
		};
		const planPath = await writePlanFile(invalidPlan);

		const result = await ingestCommand(
			{ plan: planPath, apply: false, newPlan: false, cwd: tempDir, json: false },
			makeFakeClient({ createCalls: [], planSubmitCalls: [] }),
		);

		expect(result.exitCode).not.toBe(0);
	});
});
