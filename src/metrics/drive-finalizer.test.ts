import { describe, expect, test } from "bun:test";
import type { SessionMetrics } from "../types.ts";
import { finalizeAgentMetrics } from "./drive-finalizer.ts";

function baseParams(overrides: Partial<Parameters<typeof finalizeAgentMetrics>[0]> = {}) {
	return {
		agentName: "builder-task-1",
		capability: "builder",
		taskId: "task-1",
		runId: "run-abc",
		parentAgent: "lead-task-1",
		startedAt: new Date(1000).toISOString(),
		worktreePath: "/repo/.overstory/worktrees/builder-task-1",
		claudeSessionIds: ["session-1"],
		exitCode: 0,
		mergeResult: null,
		...overrides,
	};
}

describe("finalizeAgentMetrics", () => {
	test("records a session row with the given runId populated", async () => {
		const recorded: SessionMetrics[] = [];
		const finalized = new Set<string>();

		await finalizeAgentMetrics(baseParams(), finalized, {
			recordSessionFn: (m) => recorded.push(m),
			parseTranscriptUsageFn: async () => ({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				cacheCreationTokens: 5,
				modelUsed: "sonnet",
			}),
			now: () => 5000,
		});

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.runId).toBe("run-abc");
		expect(recorded[0]?.agentName).toBe("builder-task-1");
		expect(recorded[0]?.inputTokens).toBe(100);
		expect(recorded[0]?.outputTokens).toBe(50);
		expect(recorded[0]?.durationMs).toBe(4000);
		expect(recorded[0]?.estimatedCostUsd).not.toBeNull();
	});

	test("sums usage across multiple distinct claudeSessionIds", async () => {
		const recorded: SessionMetrics[] = [];
		const finalized = new Set<string>();

		await finalizeAgentMetrics(
			baseParams({ claudeSessionIds: ["session-a", "session-b"] }),
			finalized,
			{
				recordSessionFn: (m) => recorded.push(m),
				parseTranscriptUsageFn: async (path) => {
					if (path.includes("session-a")) {
						return {
							inputTokens: 10,
							outputTokens: 20,
							cacheReadTokens: 1,
							cacheCreationTokens: 2,
							modelUsed: "sonnet",
						};
					}
					return {
						inputTokens: 5,
						outputTokens: 7,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						modelUsed: null,
					};
				},
			},
		);

		expect(recorded[0]?.inputTokens).toBe(15);
		expect(recorded[0]?.outputTokens).toBe(27);
		expect(recorded[0]?.cacheReadTokens).toBe(1);
		expect(recorded[0]?.cacheCreationTokens).toBe(2);
		// modelUsed captured from the first session that reports one.
		expect(recorded[0]?.modelUsed).toBe("sonnet");
	});

	test("records zero usage (non-fatal) when a transcript is missing", async () => {
		const recorded: SessionMetrics[] = [];
		const finalized = new Set<string>();

		await finalizeAgentMetrics(baseParams(), finalized, {
			recordSessionFn: (m) => recorded.push(m),
			parseTranscriptUsageFn: async () => {
				throw new Error("ENOENT: no such file");
			},
		});

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.inputTokens).toBe(0);
		expect(recorded[0]?.modelUsed).toBeNull();
		expect(recorded[0]?.estimatedCostUsd).toBeNull();
	});

	test("is exactly-once per agent: a second call for the same agent is a no-op", async () => {
		const recorded: SessionMetrics[] = [];
		const finalized = new Set<string>();
		const deps = {
			recordSessionFn: (m: SessionMetrics) => recorded.push(m),
			parseTranscriptUsageFn: async () => ({
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				modelUsed: "sonnet",
			}),
		};

		await finalizeAgentMetrics(baseParams(), finalized, deps);
		await finalizeAgentMetrics(baseParams(), finalized, deps);
		await finalizeAgentMetrics(baseParams({ exitCode: 1 }), finalized, deps);

		expect(recorded).toHaveLength(1);
	});

	test("HIGH-6: a failed recordSessionFn does NOT permanently suppress the agent (guard set only after success)", async () => {
		const recorded: SessionMetrics[] = [];
		const finalized = new Set<string>();
		let calls = 0;
		const deps = {
			recordSessionFn: (m: SessionMetrics) => {
				calls++;
				if (calls === 1) {
					throw new Error("db is locked");
				}
				recorded.push(m);
			},
			parseTranscriptUsageFn: async () => ({
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				modelUsed: "sonnet",
			}),
		};

		await expect(finalizeAgentMetrics(baseParams(), finalized, deps)).rejects.toThrow(
			"db is locked",
		);
		expect(finalized.has("builder-task-1")).toBe(false);

		// Retry succeeds and is NOT suppressed by a guard set before the first,
		// failed write.
		await finalizeAgentMetrics(baseParams(), finalized, deps);
		expect(recorded).toHaveLength(1);
		expect(finalized.has("builder-task-1")).toBe(true);
	});

	test("different agent names each get their own row under the shared guard", async () => {
		const recorded: SessionMetrics[] = [];
		const finalized = new Set<string>();
		const deps = {
			recordSessionFn: (m: SessionMetrics) => recorded.push(m),
			parseTranscriptUsageFn: async () => ({
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				modelUsed: "sonnet",
			}),
		};

		await finalizeAgentMetrics(baseParams({ agentName: "agent-1" }), finalized, deps);
		await finalizeAgentMetrics(baseParams({ agentName: "agent-2" }), finalized, deps);

		expect(recorded).toHaveLength(2);
		expect(recorded.map((r) => r.agentName).sort()).toEqual(["agent-1", "agent-2"]);
	});
});
