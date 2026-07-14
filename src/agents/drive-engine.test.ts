import { describe, expect, test } from "bun:test";
import { type DriveLiveAgentRef, runSweepEngine } from "./drive-engine.ts";

const AGENT_A: DriveLiveAgentRef = { name: "agent-a", capability: "builder" };
const AGENT_B: DriveLiveAgentRef = { name: "agent-b", capability: "reviewer" };

describe("runSweepEngine", () => {
	test("drives agents until isDone() becomes true", async () => {
		let dispatches = 0;
		const result = await runSweepEngine({
			getLiveAgents: () => [AGENT_A],
			dispatchOnce: async () => {
				dispatches++;
				return { drove: true };
			},
			isDone: () => dispatches >= 3,
			turnsRemaining: 80,
			maxTurnsLimit: 80,
			deadlineAtMs: Date.now() + 60_000,
			timeoutSecondsLimit: 60,
		});

		expect(result.breaker).toBeNull();
		expect(result.turnsTaken).toBe(3);
	});

	test("returns immediately with no breaker when isDone() is already true", async () => {
		let dispatchCalls = 0;
		const result = await runSweepEngine({
			getLiveAgents: () => [AGENT_A],
			dispatchOnce: async () => {
				dispatchCalls++;
				return { drove: true };
			},
			isDone: () => true,
			turnsRemaining: 80,
			maxTurnsLimit: 80,
			deadlineAtMs: Date.now() + 60_000,
			timeoutSecondsLimit: 60,
		});

		expect(result.breaker).toBeNull();
		expect(result.turnsTaken).toBe(0);
		expect(dispatchCalls).toBe(0);
	});

	test("trips the max-turns breaker once the turn budget is exhausted", async () => {
		let dispatches = 0;
		const result = await runSweepEngine({
			getLiveAgents: () => [AGENT_A],
			dispatchOnce: async () => {
				dispatches++;
				return { drove: true };
			},
			isDone: () => false,
			turnsRemaining: 5,
			maxTurnsLimit: 5,
			deadlineAtMs: Date.now() + 60_000,
			timeoutSecondsLimit: 60,
		});

		expect(result.breaker).toEqual({ kind: "max-turns", limit: 5 });
		expect(result.turnsTaken).toBe(5);
		expect(dispatches).toBe(5);
	});

	test("trips the timeout breaker once the wall-clock deadline passes", async () => {
		let ticks = 0;
		// Fake clock: advances by 1000ms on every read so the deadline is
		// crossed deterministically without a real sleep.
		const fakeNow = () => {
			ticks++;
			return ticks * 1000;
		};

		const result = await runSweepEngine({
			getLiveAgents: () => [AGENT_A],
			dispatchOnce: async () => ({ drove: true }),
			isDone: () => false,
			turnsRemaining: 1000,
			maxTurnsLimit: 1000,
			deadlineAtMs: 3500,
			timeoutSecondsLimit: 30,
			now: fakeNow,
		});

		expect(result.breaker).toEqual({ kind: "timeout", limit: 30 });
	});

	test("trips the no-progress breaker after N consecutive quiescent sweeps", async () => {
		let sweepsObserved = 0;
		const result = await runSweepEngine({
			getLiveAgents: () => {
				sweepsObserved++;
				return [AGENT_A];
			},
			dispatchOnce: async () => ({ drove: false }),
			isDone: () => false,
			turnsRemaining: 80,
			maxTurnsLimit: 80,
			deadlineAtMs: Date.now() + 60_000,
			timeoutSecondsLimit: 60,
			noProgressSweepLimit: 3,
		});

		expect(result.breaker).toEqual({ kind: "no-progress", limit: 3 });
		expect(result.turnsTaken).toBe(0);
		expect(sweepsObserved).toBe(3);
	});

	test("resets the quiescent-sweep counter when a later sweep drives a turn", async () => {
		// Sweep 1: quiescent. Sweep 2: drives (resets counter). Sweeps 3-5:
		// quiescent again. With a limit of 3, the breaker should trip on sweep
		// 5 (the 3rd CONSECUTIVE quiescent sweep after the reset), not sweep 3.
		let sweepIndex = 0;
		const droveOnSweep = new Set([2]);

		const result = await runSweepEngine({
			getLiveAgents: () => {
				sweepIndex++;
				return [AGENT_A];
			},
			dispatchOnce: async () => ({ drove: droveOnSweep.has(sweepIndex) }),
			isDone: () => false,
			turnsRemaining: 80,
			maxTurnsLimit: 80,
			deadlineAtMs: Date.now() + 60_000,
			timeoutSecondsLimit: 60,
			noProgressSweepLimit: 3,
		});

		expect(result.breaker).toEqual({ kind: "no-progress", limit: 3 });
		expect(sweepIndex).toBe(5);
		expect(result.turnsTaken).toBe(1);
	});

	test("re-fetches getLiveAgents() fresh every sweep, picking up newly added agents", async () => {
		let agents: DriveLiveAgentRef[] = [AGENT_A];
		const dispatchedNames: string[] = [];
		let sweeps = 0;

		const result = await runSweepEngine({
			getLiveAgents: () => {
				sweeps++;
				if (sweeps === 2) {
					agents = [AGENT_A, AGENT_B];
				}
				return agents;
			},
			dispatchOnce: async (agent) => {
				dispatchedNames.push(agent.name);
				// Agent A only has mail on sweep 1; agent B only has mail once
				// it appears on sweep 2 -- after that everything is quiescent.
				if (agent.name === "agent-a" && sweeps === 1) return { drove: true };
				if (agent.name === "agent-b" && sweeps === 2) return { drove: true };
				return { drove: false };
			},
			isDone: () => false,
			turnsRemaining: 80,
			maxTurnsLimit: 80,
			deadlineAtMs: Date.now() + 60_000,
			timeoutSecondsLimit: 60,
			noProgressSweepLimit: 2,
		});

		expect(dispatchedNames).toContain("agent-b");
		expect(result.turnsTaken).toBe(2);
		expect(result.breaker).toEqual({ kind: "no-progress", limit: 2 });
	});

	test("dispatches every live agent within a single sweep before re-checking isDone", async () => {
		const dispatchedNames: string[] = [];
		let calls = 0;

		await runSweepEngine({
			getLiveAgents: () => [AGENT_A, AGENT_B],
			dispatchOnce: async (agent) => {
				dispatchedNames.push(agent.name);
				calls++;
				return { drove: true };
			},
			isDone: () => calls >= 4,
			turnsRemaining: 80,
			maxTurnsLimit: 80,
			deadlineAtMs: Date.now() + 60_000,
			timeoutSecondsLimit: 60,
		});

		expect(dispatchedNames).toEqual(["agent-a", "agent-b", "agent-a", "agent-b"]);
	});
});
