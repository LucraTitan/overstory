/**
 * Pure drive-loop sweep engine for `ov drive` (headless run-to-completion).
 *
 * Extracted as a standalone, storage-agnostic engine so its quiescence and
 * circuit-breaker logic can be unit tested without a real SessionStore,
 * MailStore, or spawned agent. `src/commands/drive.ts` wires this to the
 * real SessionStore + `dispatchUnreadOnce` + `buildRunTurnOptsFactory`.
 *
 * Design note (documented interpretation of the driving spec): a single
 * sweep with zero drives is "quiescent", but this engine does NOT stop on
 * the first quiescent sweep alone — it requires `noProgressSweepLimit`
 * CONSECUTIVE quiescent sweeps before tripping the no-progress breaker. This
 * absorbs a legitimate race (mail written by one agent mid-sweep may not be
 * visible to a `getUnread` poll issued moments earlier for an agent earlier
 * in iteration order) and gives the no-progress breaker an actual role,
 * rather than a single-sweep "quiescent" stop making the breaker
 * unreachable. `isDone()` (e.g. "top agent terminal") always short-circuits
 * the loop with `breaker: null` — that is a normal, successful exit, not a
 * breaker trip.
 */

/** Minimal reference to a live (non-terminal) agent the engine can dispatch to. */
export interface DriveLiveAgentRef {
	name: string;
	capability: string;
}

/** A circuit breaker that stopped the drive loop before it finished normally. */
export interface DriveBreakerInfo {
	kind: "max-turns" | "timeout" | "no-progress";
	limit: number;
}

/** Options for {@link runSweepEngine}. */
export interface SweepEngineOpts {
	/**
	 * Returns the current set of live agents to sweep. Called fresh at the
	 * start of every sweep so agents spawned mid-loop (e.g. a reviewer
	 * spawned during reconcile) are picked up without a separate re-entry.
	 */
	getLiveAgents: () => DriveLiveAgentRef[] | Promise<DriveLiveAgentRef[]>;
	/** Drive one turn for an agent iff unread mail exists for it. */
	dispatchOnce: (agent: DriveLiveAgentRef) => Promise<{ drove: boolean }>;
	/** True when the loop should stop successfully (e.g. target agent reached terminal). */
	isDone: () => boolean | Promise<boolean>;
	/**
	 * Remaining turn budget for THIS call. Shared across the whole `ov drive`
	 * invocation by the caller passing down `maxTurns - turnsTakenSoFar` when
	 * re-entering the engine for a reconcile-phase reviewer sub-loop.
	 */
	turnsRemaining: number;
	/** The configured `--max-turns` value, reported verbatim in a breaker. */
	maxTurnsLimit: number;
	/**
	 * Absolute wall-clock deadline (ms since epoch). Shared across the whole
	 * `ov drive` invocation the same way `turnsRemaining` is.
	 */
	deadlineAtMs: number;
	/** The configured `--timeout` value in seconds, reported verbatim in a breaker. */
	timeoutSecondsLimit: number;
	/** Consecutive quiescent (zero-drive) sweeps allowed before stopping. Default 3. */
	noProgressSweepLimit?: number;
	/** Test injection: time source. Defaults to `Date.now`. */
	now?: () => number;
}

/** Result of {@link runSweepEngine}. */
export interface SweepEngineResult {
	/** Total dispatchOnce calls that actually drove a turn during this call. */
	turnsTaken: number;
	/** Non-null iff a circuit breaker stopped the loop before `isDone()` became true. */
	breaker: DriveBreakerInfo | null;
}

const DEFAULT_NO_PROGRESS_SWEEP_LIMIT = 3;

/**
 * Drive claimed mail across all live agents until quiescent, a target
 * condition is reached, or a circuit breaker trips.
 *
 * A "sweep" is one pass calling `dispatchOnce` for every agent returned by
 * `getLiveAgents()`. The loop re-checks `isDone()` and the two budget-based
 * breakers (max-turns, timeout) before every dispatch (not just once per
 * sweep) so a breaker trips promptly instead of finishing an in-progress
 * sweep first.
 */
export async function runSweepEngine(opts: SweepEngineOpts): Promise<SweepEngineResult> {
	const now = opts.now ?? Date.now;
	const noProgressSweepLimit = opts.noProgressSweepLimit ?? DEFAULT_NO_PROGRESS_SWEEP_LIMIT;

	let turnsTaken = 0;
	let consecutiveQuiescentSweeps = 0;

	const checkBudgetBreaker = (): DriveBreakerInfo | null => {
		if (turnsTaken >= opts.turnsRemaining) {
			return { kind: "max-turns", limit: opts.maxTurnsLimit };
		}
		if (now() >= opts.deadlineAtMs) {
			return { kind: "timeout", limit: opts.timeoutSecondsLimit };
		}
		return null;
	};

	while (true) {
		if (await opts.isDone()) {
			return { turnsTaken, breaker: null };
		}
		const preSweepBreaker = checkBudgetBreaker();
		if (preSweepBreaker) {
			return { turnsTaken, breaker: preSweepBreaker };
		}

		const agents = await opts.getLiveAgents();
		let droveAnyThisSweep = false;

		for (const agent of agents) {
			if (await opts.isDone()) {
				return { turnsTaken, breaker: null };
			}
			const breaker = checkBudgetBreaker();
			if (breaker) {
				return { turnsTaken, breaker };
			}

			const result = await opts.dispatchOnce(agent);
			if (result.drove) {
				turnsTaken++;
				droveAnyThisSweep = true;
			}
		}

		if (droveAnyThisSweep) {
			consecutiveQuiescentSweeps = 0;
			continue;
		}

		consecutiveQuiescentSweeps++;
		if (consecutiveQuiescentSweeps >= noProgressSweepLimit) {
			return {
				turnsTaken,
				breaker: { kind: "no-progress", limit: noProgressSweepLimit },
			};
		}
	}
}
