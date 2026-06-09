/**
 * Tests for SeedsPlanClient.
 *
 * Uses spyOn(Bun, "spawn") mocked envelopes.
 * Tests: create returns id; planSubmit returns plan_id+children; overwrite path.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { RenderOperation } from "../ingest/render.ts";
import { createSeedsPlanClient } from "./seeds-plan.ts";

const TEST_CWD = "/test/repo";

/**
 * Helper to create a mock Bun.spawn return value.
 * Supports optional stdin writer (for planSubmit tests).
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	stdin: { write: (data: string | Uint8Array) => number; end: () => void };
	exited: Promise<number>;
	pid: number;
} {
	// Provide a FileSink-compatible stdin mock (write + end) rather than a
	// WritableStream — Bun.spawn returns a FileSink when stdin:"pipe".
	const stdinMock = {
		write(_data: string | Uint8Array): number {
			return 0;
		},
		end(): void {
			// no-op
		},
	};

	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		stdin: stdinMock,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

describe("SeedsPlanClient — create", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns seed id from create envelope", async () => {
		const createEnvelope = { success: true, command: "create", id: "proj-aabb" };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(createEnvelope), "", 0));

		const client = createSeedsPlanClient(TEST_CWD);
		const op: RenderOperation = {
			op: "create",
			logicalId: "g1",
			args: [
				"create",
				"--title",
				"Wire CI",
				"--type",
				"task",
				"--priority",
				"2",
				"--description",
				"d",
				"--json",
			],
		};

		const id = await client.executeCreate(op);
		expect(id).toBe("proj-aabb");
	});

	test("passes sd create args to spawn", async () => {
		const createEnvelope = { success: true, command: "create", id: "proj-1234" };
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(createEnvelope), "", 0));

		const client = createSeedsPlanClient(TEST_CWD);
		const op: RenderOperation = {
			op: "create",
			logicalId: "g1",
			args: [
				"create",
				"--title",
				"T",
				"--type",
				"task",
				"--priority",
				"1",
				"--description",
				"d",
				"--json",
			],
		};

		await client.executeCreate(op);

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd[0]).toBe("sd");
		expect(cmd).toContain("create");
		expect(cmd).toContain("--title");
		expect(cmd).toContain("T");
	});

	test("throws on non-zero exit code", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "error", 1));

		const client = createSeedsPlanClient(TEST_CWD);
		const op: RenderOperation = {
			op: "create",
			logicalId: "g1",
			args: [
				"create",
				"--title",
				"T",
				"--type",
				"task",
				"--priority",
				"1",
				"--description",
				"d",
				"--json",
			],
		};

		await expect(client.executeCreate(op)).rejects.toThrow();
	});

	test("skips sd call when existingSeedId is present (reconcile adopt)", async () => {
		const client = createSeedsPlanClient(TEST_CWD);
		const op: RenderOperation = {
			op: "create",
			logicalId: "g1",
			args: [
				"create",
				"--title",
				"T",
				"--type",
				"task",
				"--priority",
				"1",
				"--description",
				"d",
				"--json",
			],
			existingSeedId: "proj-9c4d",
		};

		const id = await client.executeCreate(op);
		expect(id).toBe("proj-9c4d");
		expect(spawnSpy.mock.calls).toHaveLength(0); // no sd call
	});
});

describe("SeedsPlanClient — planSubmit", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns plan_id and children from planSubmit envelope", async () => {
		const submitEnvelope = {
			success: true,
			command: "plan submit",
			plan_id: "pl-9f3a",
			children: ["proj-0001", "proj-0002"],
			parent_seed: "proj-parent",
			revision: 1,
			obsolete: [],
			overwritten: false,
		};
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(submitEnvelope), "", 0));

		const client = createSeedsPlanClient(TEST_CWD);
		const op: RenderOperation = {
			op: "planSubmit",
			parentLogicalId: "g2",
			planJson: {
				template: "feature",
				sections: {
					steps: [
						{ title: "S1", type: "task", priority: 2 },
						{ title: "S2", type: "task", priority: 2 },
					],
					acceptance: ["a"],
				},
			},
			overwrite: false,
		};

		const result = await client.executePlanSubmit("proj-parent", op);
		expect(result.planId).toBe("pl-9f3a");
		expect(result.children).toEqual(["proj-0001", "proj-0002"]);
	});

	test("passes --overwrite flag when overwrite:true", async () => {
		const submitEnvelope = {
			success: true,
			command: "plan submit",
			plan_id: "pl-aaaa",
			children: ["proj-x1"],
			parent_seed: "proj-p",
			revision: 2,
			obsolete: [],
			overwritten: true,
		};
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(submitEnvelope), "", 0));

		const client = createSeedsPlanClient(TEST_CWD);
		const op: RenderOperation = {
			op: "planSubmit",
			parentLogicalId: "g2",
			planJson: {
				template: "feature",
				sections: {
					steps: [
						{ title: "S1", type: "task", priority: 2 },
						{ title: "S2", type: "task", priority: 2 },
					],
					acceptance: ["a"],
				},
			},
			overwrite: true,
		};

		await client.executePlanSubmit("proj-p", op);

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toContain("--overwrite");
	});

	test("does NOT pass --overwrite flag when overwrite:false", async () => {
		const submitEnvelope = {
			success: true,
			command: "plan submit",
			plan_id: "pl-bbbb",
			children: ["proj-y1", "proj-y2"],
			parent_seed: "proj-q",
			revision: 1,
			obsolete: [],
			overwritten: false,
		};
		spawnSpy.mockImplementation(() => mockSpawnResult(JSON.stringify(submitEnvelope), "", 0));

		const client = createSeedsPlanClient(TEST_CWD);
		const op: RenderOperation = {
			op: "planSubmit",
			parentLogicalId: "g2",
			planJson: {
				template: "feature",
				sections: {
					steps: [
						{ title: "S1", type: "task", priority: 2 },
						{ title: "S2", type: "task", priority: 2 },
					],
					acceptance: ["a"],
				},
			},
			overwrite: false,
		};

		await client.executePlanSubmit("proj-q", op);

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).not.toContain("--overwrite");
	});
});
