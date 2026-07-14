/**
 * `ov drive <seed-id>` — headless run-to-completion driver.
 *
 * Composes the ov-drive-completion Phase 1 services
 * (`spawnHeadlessSession` via `spawnDriveAgent`, `dispatchUnreadOnce`,
 * `mergeBranch`) and the Phase 2 pure engines (`runSweepEngine`,
 * `finalizeAgentMetrics`, `parseReviewVerdict`) into the state machine:
 *
 *   CREATE ISOLATED RUN -> SEED TOP AGENT -> DRIVE CLAIMED MAIL UNTIL
 *   QUIESCENT -> RECONCILE REVIEW -> MERGE ONCE -> VERIFY -> CLOSE + FINALIZE
 *
 * SOLE-SUPERVISOR ASSUMPTION (documented, leaner-scope): this driver assumes
 * it is the ONLY process supervising its runId. There is no cross-process
 * lease in this version — do not run `ov serve` or a second `ov drive`
 * against the same run concurrently; both would poll/dispatch the same
 * agents' mail with no coordination. A formal lease is a documented
 * follow-up, not implemented here.
 *
 * MULTI-BUILDER SCOPE: if the driven run produces more than one builder
 * branch, this version reviews and merges only the FIRST one (discovery
 * order via `SessionStore.getByRun`) and logs a warning — multi-builder
 * integration ordering/gates are a documented follow-up (`DriveResult`'s
 * `mergedBranch` field is singular, matching the spec's outcome contract).
 *
 * CIRCUIT-BREAKER + QUIESCENCE + REVIEW-INTEGRITY NOTES (Codex Phase 2 gate
 * fixes, see the fix-by-finding notes inline at each site below):
 *  - The wall-clock deadline and turn budget are established BEFORE the seed
 *    is ever spawned, and the seed's + reviewer's own first turns both count
 *    toward `--max-turns`. An `AbortController` armed at the deadline is
 *    threaded through every turn this driver spawns (directly or via the
 *    sweep loop), so an in-flight turn is killed promptly at the deadline
 *    instead of relying solely on the turn runner's own (much longer) stall
 *    watchdog.
 *  - Both sweep loops (main + review) stop only at true run quiescence (zero
 *    live agents in this run), not merely "the top/reviewer agent is
 *    terminal" — a still-working child no longer gets skipped.
 *  - The builder branch's HEAD sha is captured once reconcile selects it and
 *    re-verified immediately before the real merge; if it advanced in the
 *    meantime the merge is refused rather than landing an unreviewed tip.
 *  - The reviewer is spawned tracker-neutral (`skipTaskCheck: true`) because
 *    a real builder/lead closes its own seed task as part of its completion
 *    protocol before sending terminal mail — this driver must not require an
 *    "open" seed to spawn a reviewer against it. Seed status is always read
 *    fresh from the tracker (never assumed) at the single `finish()` exit
 *    point.
 *  - The reviewer's terminal verdict is accepted only from a mail sent by
 *    this run's reviewer strictly AFTER a monotonic mail-sequence snapshot
 *    captured immediately before the reviewer is spawned (rowid-based, not
 *    wall-clock — timestamps can collide at millisecond resolution or be
 *    forged/replayed; see finding B), of either terminal type a reviewer may
 *    legitimately send (`worker_done` OR `result` — this repo's own deployed
 *    reviewer template sends `result`; see finding A), matched via an exact
 *    end-anchored PASS/FAIL token in the subject or body — never a stale
 *    prior-run mail or a substring match.
 *  - `ov drive` requires every agent it drives to be spawn-per-turn
 *    (headless); a non-headless/legacy descendant appearing in the run fails
 *    it fast with a clear error instead of being silently skipped forever
 *    (finding F — this driver has no mechanism to supervise a tmux-mode
 *    session's lifecycle).
 *  - The entire post-run-creation state machine runs under an outer
 *    try/catch so an unexpected throw from any dispatch/merge call still
 *    reaches the single `finish()` exit point (terminalizes live sessions,
 *    finalizes metrics, closes the store) instead of leaking state.
 */

import { join } from "node:path";
import { Command } from "commander";
import {
	type DriveBreakerInfo,
	type DriveLiveAgentRef,
	runSweepEngine,
} from "../agents/drive-engine.ts";
import type { TurnRunnerFn } from "../agents/headless-mail-injector.ts";
import { dispatchUnreadOnce } from "../agents/headless-mail-injector.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { parseReviewVerdict } from "../agents/review-verdict.ts";
import type { TurnSpawnFn } from "../agents/turn-runner.ts";
import { runTurn } from "../agents/turn-runner.ts";
import { buildRunTurnOptsFactory, isSpawnPerTurnAgent } from "../agents/turn-runner-dispatch.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { finalizeAgentMetrics } from "../metrics/drive-finalizer.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import { createTrackerClient, resolveBackend, trackerCliName } from "../tracker/factory.ts";
import type { TrackerClient } from "../tracker/types.ts";
import type { AgentSession, ResolutionTier, SessionMetrics } from "../types.ts";
import { spawnDriveAgent } from "./drive-spawn.ts";
import { type MergeBranchResult, mergeBranch } from "./merge.ts";
import { getCurrentBranch } from "./sling.ts";

const DEFAULT_MAX_TURNS = 80;
const DEFAULT_TIMEOUT_SECONDS = 1800;
/** Consecutive quiescent sweeps before the no-progress breaker trips. Not CLI-configurable (matches the spec's exact flag surface). */
const DEFAULT_NO_PROGRESS_SWEEP_LIMIT = 3;
/**
 * A `mergeBranch({ dryRun: true })` prediction whose `reason` starts with
 * this prefix came from `safePredictForEntry`'s catch-fallback (a genuine
 * prediction INFRASTRUCTURE error, e.g. a mulch outage) rather than a real
 * predicted conflict — see `merge.ts`. There is no dedicated boolean/enum
 * field for this on `ConflictPrediction`; the reason-string prefix is the
 * only available signal (MEDIUM-7).
 */
const PREDICTION_FAILED_PREFIX = "prediction-failed:";

/** Terminal outcome of one `ov drive` invocation. */
export type DriveOutcome =
	| "merged"
	| "review_failed"
	| "merge_blocked"
	| "breaker"
	| "failed"
	| "no_op";

/** Per-agent summary line in a {@link DriveResult}. */
export interface DriveAgentSummary {
	name: string;
	capability: string;
	/** Total turns `ov drive` drove for this agent via `dispatchUnreadOnce`. */
	turns: number;
	finalState: string;
}

/** Structured result of a drive run — also the `--json` output shape. */
export interface DriveResult {
	outcome: DriveOutcome;
	runId: string;
	agents: DriveAgentSummary[];
	mergedBranch?: string;
	seedStatus: string;
	breaker?: DriveBreakerInfo;
}

/** Parsed + validated `ov drive` CLI options (commander's raw string opts). */
export interface DriveCliOptions {
	capability?: string;
	maxTurns?: string;
	timeout?: string;
	/** Commander's `--no-merge` maps to `merge: false`; default (flag absent) is `true`. */
	merge?: boolean;
	json?: boolean;
}

/** Test-injectable seams. Production defaults to the real implementations. */
export interface DriveDeps {
	_spawnFn?: TurnSpawnFn;
	runTurnFn?: TurnRunnerFn;
	mergeBranchFn?: (
		branch: string,
		opts?: { dryRun?: boolean; into?: string },
	) => Promise<MergeBranchResult>;
	recordSessionFn?: (metrics: SessionMetrics) => void;
	/**
	 * Test injection: replaces the real `createTrackerClient(...)` call so
	 * tests can exercise the workability/claim/close paths with a fake
	 * in-memory tracker instead of needing a real `sd`/`bd` CLI on PATH.
	 */
	tracker?: TrackerClient;
	now?: () => number;
	/**
	 * Test injection: replaces the real `git rev-parse` HEAD-sha lookup used
	 * for the pre-merge re-verification check (HIGH-3).
	 */
	getBranchHeadShaFn?: (repoRoot: string, branchName: string) => Promise<string | null>;
}

function assertPositiveInt(raw: string | undefined, fallback: number, field: string): number {
	const value = Number.parseInt(raw ?? String(fallback), 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new ValidationError(`--${field} must be a positive integer (got "${raw ?? ""}")`, {
			field,
			value: raw,
		});
	}
	return value;
}

function isLiveState(state: string): boolean {
	return state !== "completed" && state !== "zombie";
}

/**
 * Resolve a branch's current HEAD commit sha by reading the ref directly from
 * the canonical repo root (works regardless of what's checked out in any
 * worktree, since branch refs are shared across all worktrees of one repo).
 * Returns `null` (never throws) on any git failure, matching
 * `getCurrentBranch`'s fail-soft style — callers must treat `null` as
 * "cannot verify" and fail closed.
 */
async function getBranchHeadSha(repoRoot: string, branchName: string): Promise<string | null> {
	const proc = Bun.spawn(["git", "rev-parse", branchName], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return null;
	const sha = stdout.trim();
	return sha === "" ? null : sha;
}

/**
 * Run the full `ov drive` state machine for one seed task. Never throws for
 * expected-failure paths (spawn failure, breaker trip, review failure,
 * merge-blocked) — those return a structured {@link DriveResult} instead, so
 * `--json` callers always get a well-formed outcome. Pre-flight validation
 * errors (bad flags, missing seed id) DO throw, before any run is created.
 */
export async function driveCommand(
	seedId: string,
	cliOpts: DriveCliOptions,
	deps: DriveDeps = {},
): Promise<DriveResult> {
	if (!seedId || seedId.trim().length === 0) {
		throw new ValidationError("Seed ID is required: ov drive <seed-id>", { field: "seedId" });
	}
	const capability = cliOpts.capability ?? "lead";
	if (capability !== "lead" && capability !== "builder") {
		throw new ValidationError(`--capability must be "lead" or "builder" (got "${capability}")`, {
			field: "capability",
			value: capability,
		});
	}
	// Circuit breakers are ALL required and non-zero — refuse to start otherwise.
	const maxTurns = assertPositiveInt(cliOpts.maxTurns, DEFAULT_MAX_TURNS, "max-turns");
	const timeoutSeconds = assertPositiveInt(cliOpts.timeout, DEFAULT_TIMEOUT_SECONDS, "timeout");
	const noMerge = cliOpts.merge === false;

	const now = deps.now ?? Date.now;
	const getBranchHeadShaFn = deps.getBranchHeadShaFn ?? getBranchHeadSha;
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");
	const backend = await resolveBackend(config.taskTracker.backend, config.project.root);
	const tracker = deps.tracker ?? createTrackerClient(backend, config.project.root);

	const manifestLoader = createManifestLoader(
		join(config.project.root, config.agents.manifestPath),
		join(config.project.root, config.agents.baseDir),
	);
	const manifest = await manifestLoader.load();

	// Step 1: create an ISOLATED run — a fresh runId, deliberately never read
	// from or written to current-run.txt (the mutable ambient run pointer
	// other commands share). Everything below is scoped to this runId only.
	// Captured ONCE (HIGH-2): both the run-id/createRun timestamp and the
	// wall-clock deadline derive from this single `now()` read, so a fake
	// clock that jumps after its first call can deterministically simulate
	// "the deadline has already elapsed" for breaker tests.
	const nowAtStart = now();
	const runId = `run-${new Date(nowAtStart).toISOString().replace(/[:.]/g, "-")}`;
	const runStore = createRunStore(join(overstoryDir, "sessions.db"));
	try {
		runStore.createRun({
			id: runId,
			startedAt: new Date(nowAtStart).toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});
	} finally {
		runStore.close();
	}

	const { store } = openSessionStore(overstoryDir);
	const mailDbPath = join(overstoryDir, "mail.db");
	const metricsDbPath = join(overstoryDir, "metrics.db");

	// HIGH-2: establish the deadline + turn budget + abort controller BEFORE
	// spawning anything (including the seed's own first turn), and thread the
	// same controller's signal through every turn this driver spawns.
	const deadlineAtMs = nowAtStart + timeoutSeconds * 1000;
	const abortController = new AbortController();
	const deadlineTimer = setTimeout(
		() => abortController.abort(),
		Math.max(0, deadlineAtMs - now()),
	);
	if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
	let turnsUsed = 0;

	/**
	 * Circuit-breaker check for a "may we START the next spawn/turn" decision
	 * (HIGH-2's original use — before the seed spawn, before the reviewer
	 * spawn). Both the turn budget AND the deadline are legitimate reasons to
	 * refuse starting something new here, so this checks both.
	 *
	 * Do NOT use this to classify an ALREADY-in-flight turn's outcome (a
	 * throw, or a resulting zombie session) — see `checkDeadlineAbort` below
	 * (finding 4) for that.
	 */
	const checkBudgetOrDeadlineBreaker = (): DriveBreakerInfo | null => {
		if (turnsUsed >= maxTurns) return { kind: "max-turns", limit: maxTurns };
		return checkDeadlineAbort();
	};

	/**
	 * Circuit-breaker check for classifying a turn that already RAN and came
	 * back abnormally: a throw from `spawnDriveAgent`, or its resulting
	 * session turning up `"zombie"` (finding D). A wall-clock deadline abort
	 * kills an in-flight turn and zombies its session (`turn-runner.ts`'s
	 * `aborted -> finalState = "zombie"`), which makes
	 * `getLiveAgentsForRun()` report zero live agents and
	 * `runSweepEngine`'s `isDone()` short-circuit with `breaker: null` BEFORE
	 * its own budget check ever runs — correct for a genuinely clean
	 * quiescent exit (see `drive-engine.ts`'s own doc comment), but
	 * indistinguishable from a killed-by-timeout exit without checking here.
	 *
	 * Finding 4 (fixed a real misclassification): this deliberately checks
	 * ONLY the deadline/abort signal, NEVER `turnsUsed >= maxTurns`. Exhausting
	 * the turn budget can only ever PREVENT starting a new turn (handled by
	 * `checkBudgetOrDeadlineBreaker` above and by `runSweepEngine`'s own
	 * pre-dispatch budget check) — it never aborts a turn that is already
	 * in flight. A zombie session found at one of these post-spawn call sites
	 * can also come from `turn-runner.ts`'s own INTERNAL stall watchdog, which
	 * has nothing to do with this run's turn budget or wall-clock deadline. If
	 * that stall happens to land on the exact turn where `turnsUsed` also
	 * reaches `maxTurns` (pure coincidence — e.g. the last permitted turn),
	 * the old combined check wrongly reported `breaker: max-turns` for what
	 * was actually an unrelated internal failure; the correct outcome for a
	 * non-deadline zombie is `"failed"`, not `"breaker"`.
	 */
	const checkDeadlineAbort = (): DriveBreakerInfo | null => {
		if (abortController.signal.aborted || now() >= deadlineAtMs) {
			return { kind: "timeout", limit: timeoutSeconds };
		}
		return null;
	};

	// Per-agent bookkeeping accumulated across the whole invocation.
	const claudeSessionIds = new Map<string, Set<string>>();
	const turnsPerAgent = new Map<string, number>();
	const lastExitCodeByAgent = new Map<string, number | null>();
	const finalizedAgentNames = new Set<string>();
	let mergedAgentName: string | null = null;
	let mergedTier: ResolutionTier | null = null;

	const trackSessionId = (agentName: string, sessionId: string | null | undefined) => {
		if (!sessionId) return;
		const set = claudeSessionIds.get(agentName) ?? new Set<string>();
		set.add(sessionId);
		claudeSessionIds.set(agentName, set);
	};

	const recordSessionFn =
		deps.recordSessionFn ??
		((metrics: SessionMetrics) => {
			const metricsStore = createMetricsStore(metricsDbPath);
			try {
				metricsStore.recordSession(metrics);
			} finally {
				metricsStore.close();
			}
		});

	const finalizeAllSeen = async (): Promise<void> => {
		for (const session of store.getByRun(runId)) {
			const ids = new Set(claudeSessionIds.get(session.agentName) ?? []);
			if (session.claudeSessionId) ids.add(session.claudeSessionId);
			await finalizeAgentMetrics(
				{
					agentName: session.agentName,
					capability: session.capability,
					taskId: session.taskId,
					runId: session.runId,
					parentAgent: session.parentAgent,
					// finding E: use the session row's own `startedAt` directly.
					// `spawnHeadlessSession` upserts it BEFORE driving the agent's
					// first turn (the correct pre-turn instant) — a timestamp
					// captured here in `drive.ts` after `spawnDriveAgent` has already
					// returned would be strictly later (post-first-turn) and would
					// systematically undercount agents that spend most of their time
					// in that first turn.
					startedAt: session.startedAt,
					worktreePath: session.worktreePath,
					claudeSessionIds: [...ids],
					exitCode: lastExitCodeByAgent.get(session.agentName) ?? null,
					mergeResult: session.agentName === mergedAgentName ? mergedTier : null,
				},
				finalizedAgentNames,
				{ recordSessionFn, now: deps.now },
			);
		}
	};

	const buildAgentSummaries = (): DriveAgentSummary[] =>
		store.getByRun(runId).map((s) => ({
			name: s.agentName,
			capability: s.capability,
			turns: turnsPerAgent.get(s.agentName) ?? 0,
			finalState: s.state,
		}));

	/**
	 * CRITICAL-1: never assume seed status — always read it fresh from the
	 * tracker at the single exit point. `"tracker-disabled"` when the task
	 * tracker integration itself is off; `"unknown"` when the read fails
	 * (e.g. task not found).
	 */
	const resolveSeedStatus = async (): Promise<string> => {
		if (!config.taskTracker.enabled) return "tracker-disabled";
		try {
			const issue = await tracker.show(seedId);
			return issue.status;
		} catch {
			return "unknown";
		}
	};

	/**
	 * HIGH-5: mark every still-live session row for this run as `"zombie"`
	 * before finishing, so a driver exit (of any kind) never leaves a live
	 * session row pointing at a worktree/process nothing supervises anymore.
	 */
	const terminalizeLiveSessions = (): void => {
		for (const session of store.getByRun(runId)) {
			if (isLiveState(session.state)) {
				store.updateState(session.agentName, "zombie");
			}
		}
	};

	// The SOLE exit point. Deliberately defensive at every step (HIGH-5): no
	// individual failure here (metrics write, run-completion bookkeeping,
	// tracker read, store close) is allowed to throw out of `finish`, since
	// it is also the outer catch-all's cleanup path — it must always return a
	// well-formed DriveResult.
	const finish = async (
		outcome: DriveOutcome,
		extra: Partial<Pick<DriveResult, "mergedBranch" | "breaker">> = {},
	): Promise<DriveResult> => {
		try {
			terminalizeLiveSessions();
		} catch {
			// Non-fatal: best-effort session cleanup must not mask the real outcome.
		}
		try {
			await finalizeAllSeen();
		} catch {
			// Non-fatal: best-effort metrics must not mask the real outcome.
		}
		try {
			const finishRunStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				finishRunStore.completeRun(runId, outcome === "merged" ? "completed" : "failed");
			} finally {
				finishRunStore.close();
			}
		} catch {
			// Non-fatal: run-completion bookkeeping must not mask the real outcome.
		}
		let seedStatus = "unknown";
		try {
			seedStatus = await resolveSeedStatus();
		} catch {
			// resolveSeedStatus() already catches internally; this is defense in depth.
		}
		const result: DriveResult = {
			outcome,
			runId,
			agents: buildAgentSummaries(),
			seedStatus,
		};
		if (extra.mergedBranch) result.mergedBranch = extra.mergedBranch;
		if (extra.breaker) result.breaker = extra.breaker;
		clearTimeout(deadlineTimer);
		try {
			store.close();
		} catch {
			// Non-fatal: already-closed or unavailable store must not mask the real outcome.
		}
		return result;
	};

	const runTurnFn = deps.runTurnFn ?? runTurn;
	const mergeBranchFn = deps.mergeBranchFn ?? mergeBranch;

	const getLiveAgentsForRun = (): DriveLiveAgentRef[] =>
		store
			.getByRun(runId)
			.filter((s) => isLiveState(s.state))
			.map((s) => ({ name: s.agentName, capability: s.capability }));

	const dispatchOnce = async (agent: DriveLiveAgentRef): Promise<{ drove: boolean }> => {
		const session = store.getByName(agent.name);
		if (!session) return { drove: false };

		let factory: ReturnType<typeof buildRunTurnOptsFactory>;
		try {
			factory = buildRunTurnOptsFactory({ session, config, manifest, overstoryDir });
		} catch {
			return { drove: false };
		}
		if (!isSpawnPerTurnAgent(session, config, factory.runtime)) {
			// finding F: this driver has no mechanism to supervise a non-headless
			// (tmux-mode/legacy) session's lifecycle — quiescence detection and
			// cleanup both assume every descendant is spawn-per-turn. Fail the
			// whole run fast and loud instead of silently skipping this agent
			// forever, which would either hang the run past its breaker or,
			// worse, report a false "quiescent" exit while a real session is
			// still working unsupervised.
			throw new AgentError(
				"ov drive requires headless spawn-per-turn agents; encountered a " +
					`non-headless/legacy session "${session.agentName}" (capability ` +
					`"${session.capability}") mid-run.`,
				{ agentName: session.agentName, capability: session.capability },
			);
		}

		const optsFactory = (userTurnNdjson: string) => ({
			...factory.build(userTurnNdjson),
			_spawnFn: deps._spawnFn,
			abortSignal: abortController.signal,
		});

		const dispatchResult = await dispatchUnreadOnce({
			agentName: agent.name,
			optsFactory,
			runTurnFn,
			mailStorePath: mailDbPath,
		});

		if (dispatchResult.drove && dispatchResult.turnResult) {
			turnsPerAgent.set(agent.name, (turnsPerAgent.get(agent.name) ?? 0) + 1);
			trackSessionId(agent.name, dispatchResult.turnResult.newSessionId);
			lastExitCodeByAgent.set(agent.name, dispatchResult.turnResult.exitCode);
		}
		return { drove: dispatchResult.drove };
	};

	// From here on, any unexpected throw (a dispatch/merge call rejecting
	// rather than returning a structured result) must still reach `finish`
	// exactly once (HIGH-5) instead of leaking a live run/session/store.
	// Every EXPECTED outcome path below returns directly from within this
	// try block via `finish(...)`, so the catch only ever fires for a truly
	// unexpected exception.
	try {
		// Step 2: seed the top agent (direct spawn, no parent, depth 0).
		const seedBreaker = checkBudgetOrDeadlineBreaker();
		if (seedBreaker) {
			return await finish("breaker", { breaker: seedBreaker });
		}

		let topAgentName: string;
		try {
			const baseBranch =
				(await getCurrentBranch(config.project.root)) ?? config.project.canonicalBranch;
			const spawnResult = await spawnDriveAgent({
				requestedName: `${capability}-${seedId}`,
				capability,
				taskId: seedId,
				parentAgent: null,
				depth: 0,
				runId,
				baseBranch,
				config,
				manifest,
				store,
				tracker,
				trackerCliName: trackerCliName(backend),
				trackerBackendName: backend,
				slingerName: process.env.OVERSTORY_AGENT_NAME?.trim() || null,
				_spawnFn: deps._spawnFn,
				abortSignal: abortController.signal,
			});
			topAgentName = spawnResult.agentName;
			trackSessionId(topAgentName, spawnResult.firstTurn.newSessionId);
			lastExitCodeByAgent.set(topAgentName, spawnResult.firstTurn.exitCode);
		} catch {
			// finding D / finding 4: a deadline abort that killed this spawn's
			// in-flight first turn must be reported as `breaker`, not a generic
			// `failed` — but ONLY a deadline abort (`checkDeadlineAbort`), never
			// the turn budget: exhausting `maxTurns` cannot itself have killed an
			// already-in-flight turn, so it must never be used to (mis)classify
			// one (finding 4).
			const breaker = checkDeadlineAbort();
			return breaker ? await finish("breaker", { breaker }) : await finish("failed", {});
		}
		// The seed's own first turn counts toward the overall turn budget
		// (HIGH-2) — a hostile `--max-turns 1` can no longer get a "free" extra
		// turn for the reviewer past the configured limit.
		turnsUsed += 1;

		// Step 3: drive claimed mail until the WHOLE RUN is quiescent (HIGH-3:
		// not just "the top agent reached terminal" — a still-working child
		// must not be skipped).
		const mainLoopResult = await runSweepEngine({
			getLiveAgents: getLiveAgentsForRun,
			dispatchOnce,
			isDone: () => getLiveAgentsForRun().length === 0,
			turnsRemaining: maxTurns - turnsUsed,
			maxTurnsLimit: maxTurns,
			deadlineAtMs,
			timeoutSecondsLimit: timeoutSeconds,
			noProgressSweepLimit: DEFAULT_NO_PROGRESS_SWEEP_LIMIT,
			now,
		});
		turnsUsed += mainLoopResult.turnsTaken;

		if (mainLoopResult.breaker) {
			return await finish("breaker", { breaker: mainLoopResult.breaker });
		}

		const topSessionAfterMain = store.getByName(topAgentName);
		if (!topSessionAfterMain || topSessionAfterMain.state === "zombie") {
			// finding D / finding 4: a zombie state here can mean the deadline
			// abort killed this agent's in-flight turn (see `checkDeadlineAbort`'s
			// doc comment) — report that as `breaker`, not a generic `failed`.
			// Deliberately NOT the turn-budget check: a zombie here can equally
			// well be an internal stall unrelated to this run's turn budget, and
			// `turnsUsed` happening to already be at `maxTurns` is not evidence
			// that the budget caused this particular zombie (finding 4).
			const breaker = checkDeadlineAbort();
			return breaker ? await finish("breaker", { breaker }) : await finish("failed", {});
		}

		// Step 4: reconcile — discover builder branch(es) for this run.
		let builderSessions: AgentSession[] = store
			.getByRun(runId)
			.filter((s) => s.capability === "builder");
		if (builderSessions.length === 0 && topSessionAfterMain.capability === "builder") {
			builderSessions = [topSessionAfterMain];
		}
		if (builderSessions.length === 0) {
			return await finish("no_op", {});
		}
		if (builderSessions.length > 1) {
			process.stderr.write(
				`ov drive: run ${runId} produced ${builderSessions.length} builder branches ` +
					`(${builderSessions.map((s) => s.branchName).join(", ")}). This version reviews+merges ` +
					`only the first in discovery order ("${builderSessions[0]?.branchName}"); the rest are left ` +
					"untouched — multi-builder integration ordering/gates are a documented follow-up.\n",
			);
		}
		const primaryBuilder = builderSessions[0];
		if (!primaryBuilder) {
			return await finish("no_op", {});
		}

		// HIGH-3: capture the builder branch's immutable HEAD sha the moment
		// reconcile selects it. This is the exact snapshot the reviewer is
		// asked to inspect, and is re-verified below immediately before the
		// real merge.
		const reviewedSha = await getBranchHeadShaFn(config.project.root, primaryBuilder.branchName);
		if (!reviewedSha) {
			return await finish("failed", {});
		}

		// Spawn a reviewer on the builder's branch and drive it to terminal.
		// CRITICAL-1: tracker-neutral (skipTaskCheck) — a real builder/lead
		// closes its OWN seed task as part of its completion protocol before
		// sending terminal mail, so `primaryBuilder.taskId` (often == seedId)
		// may already be "closed" by the time we get here. Requiring it to be
		// workable would wrongly fail every real run.
		const reviewerBreaker = checkBudgetOrDeadlineBreaker();
		if (reviewerBreaker) {
			return await finish("breaker", { breaker: reviewerBreaker });
		}

		let reviewerName: string;
		// finding B: snapshot the mail table's monotonic rowid high-water-mark
		// immediately before the reviewer spawn. Mail `created_at` is only
		// millisecond-resolution and can collide (or be forged/backdated by a
		// stale/replayed row) — only a mail whose `rowid` is strictly greater
		// than this snapshot can ever be treated as THIS reviewer's verdict,
		// regardless of its timestamp.
		const reviewSeqMailStore = createMailStore(mailDbPath);
		let reviewMailSeqSnapshot: number;
		try {
			reviewMailSeqSnapshot = reviewSeqMailStore.getMaxRowid();
		} finally {
			reviewSeqMailStore.close();
		}
		try {
			const reviewerSpawn = await spawnDriveAgent({
				requestedName: `reviewer-${primaryBuilder.taskId}`,
				capability: "reviewer",
				taskId: primaryBuilder.taskId,
				parentAgent: topAgentName,
				depth: topSessionAfterMain.depth + 1,
				runId,
				baseBranch: primaryBuilder.branchName,
				config,
				manifest,
				store,
				tracker,
				trackerCliName: trackerCliName(backend),
				trackerBackendName: backend,
				slingerName: topAgentName,
				skipTaskCheck: true,
				_spawnFn: deps._spawnFn,
				abortSignal: abortController.signal,
			});
			reviewerName = reviewerSpawn.agentName;
			trackSessionId(reviewerName, reviewerSpawn.firstTurn.newSessionId);
			lastExitCodeByAgent.set(reviewerName, reviewerSpawn.firstTurn.exitCode);
		} catch {
			// finding D / finding 4: same breaker-vs-failed disambiguation as the
			// seed spawn — deadline-only, never the turn budget.
			const breaker = checkDeadlineAbort();
			return breaker ? await finish("breaker", { breaker }) : await finish("failed", {});
		}
		turnsUsed += 1;

		const reviewLoopResult = await runSweepEngine({
			getLiveAgents: getLiveAgentsForRun,
			dispatchOnce,
			isDone: () => getLiveAgentsForRun().length === 0,
			turnsRemaining: maxTurns - turnsUsed,
			maxTurnsLimit: maxTurns,
			deadlineAtMs,
			timeoutSecondsLimit: timeoutSeconds,
			noProgressSweepLimit: DEFAULT_NO_PROGRESS_SWEEP_LIMIT,
			now,
		});
		turnsUsed += reviewLoopResult.turnsTaken;

		if (reviewLoopResult.breaker) {
			return await finish("breaker", { breaker: reviewLoopResult.breaker });
		}

		const reviewerSession = store.getByName(reviewerName);
		if (!reviewerSession || reviewerSession.state === "zombie") {
			// finding D / finding 4: same breaker-vs-failed disambiguation as
			// topSessionAfterMain — deadline-only, never the turn budget.
			const breaker = checkDeadlineAbort();
			return breaker ? await finish("breaker", { breaker }) : await finish("failed", {});
		}

		// Parse the reviewer's terminal verdict from a mail STRICTLY AFTER this
		// review's pre-spawn rowid snapshot (finding B — rowid, not wall-clock,
		// so a stale/forged/collided timestamp can never qualify), of EITHER
		// terminal type a reviewer may legitimately send: this repo's own
		// deployed `.overstory/agent-defs/reviewer.md` sends `type: result`, not
		// `worker_done` (finding A). `list()` orders `created_at DESC, rowid
		// DESC`, so `messages[0]` is deterministically the most recent
		// qualifying mail. The verdict token is matched in the subject first,
		// falling back to the body (finding A) — never a stale prior-run mail
		// or a substring match (BYPASS/PASSING/FAILURE).
		const verdictMailStore = createMailStore(mailDbPath);
		let verdict: ReturnType<typeof parseReviewVerdict> = "unknown";
		try {
			const mailClient = createMailClient(verdictMailStore);
			const messages = mailClient.list({
				from: reviewerName,
				type: ["worker_done", "result"],
				afterRowid: reviewMailSeqSnapshot,
			});
			const last = messages[0];
			if (last) verdict = parseReviewVerdict(last.subject, last.body);
		} finally {
			verdictMailStore.close();
		}

		// MEDIUM-7: "review_failed" is reserved for an EXPLICIT reviewer FAIL
		// verdict. An inconclusive/missing verdict is an operational failure,
		// not a review verdict — classify it as "failed".
		if (verdict === "fail") {
			return await finish("review_failed", {});
		}
		if (verdict !== "pass") {
			return await finish("failed", {});
		}

		if (noMerge) {
			return await finish("no_op", {});
		}

		// Step 5: merge once. Dry-run structurally can never return outcome
		// "conflict" (see mergeBranch's doc comment) — the canonical "tier
		// above auto" signal is ConflictPrediction.wouldRequireAgent.
		//
		// MEDIUM-7: distinguish a genuine predicted conflict (`merge_blocked`,
		// a real policy gate) from a prediction INFRASTRUCTURE failure (a
		// mulch outage etc., surfaced by `safePredictForEntry`'s catch-fallback
		// as a synthetic `wouldRequireAgent: true` envelope whose `reason`
		// starts with "prediction-failed:") — an outage is an operational
		// failure, not a policy gate, and must not block an otherwise-clean
		// merge under the "merge_blocked" label. No prediction at all is also
		// an operational failure.
		const dryRunResult = await mergeBranchFn(primaryBuilder.branchName, { dryRun: true });
		const prediction = dryRunResult.prediction;
		if (!prediction) {
			return await finish("failed", {});
		}
		if (prediction.reason.startsWith(PREDICTION_FAILED_PREFIX)) {
			return await finish("failed", {});
		}
		if (prediction.wouldRequireAgent) {
			return await finish("merge_blocked", {});
		}

		// HIGH-3: re-verify the builder branch's HEAD sha immediately before
		// merging still equals what was reviewed. If it advanced (a builder or
		// anything else landed a newer, unreviewed commit on that branch
		// between review and merge), refuse the merge rather than land an
		// unreviewed tip. Documented lean-scope gap: this fails the run rather
		// than looping back into a re-review.
		//
		// finding G (documented residual gap, no code change — a merge-time
		// lock is the full fix and is deferred): this re-check closes the LARGE
		// window (the entire review turn-loop), but a narrow TOCTOU window still
		// exists between this read and `mergeBranchFn(...)` actually landing the
		// merge below — nothing in this single-process, lease-free driver (see
		// the file's SOLE-SUPERVISOR ASSUMPTION doc comment) prevents another
		// writer from advancing `primaryBuilder.branchName` in that small gap.
		// Given the sole-supervisor assumption already documented for this
		// version, this residual window is accepted rather than closed here.
		const shaAtMerge = await getBranchHeadShaFn(config.project.root, primaryBuilder.branchName);
		if (shaAtMerge !== reviewedSha) {
			return await finish("failed", {});
		}

		const realResult = await mergeBranchFn(primaryBuilder.branchName);
		if (realResult.outcome === "conflict") {
			return await finish("merge_blocked", {});
		}
		if (realResult.outcome !== "merged") {
			// "failed" (resolver error, no content conflict) or any other
			// non-merged/non-conflict outcome -> operational failure (MEDIUM-7),
			// not a policy gate.
			return await finish("failed", {});
		}
		mergedAgentName = primaryBuilder.agentName;
		mergedTier = realResult.tier ?? null;

		// Step 6/7: verify (mergeBranch's own "merged" outcome is the
		// verification signal — no extra ancestor cross-check; documented
		// lean-scope gap) then close the seed and finalize metrics.
		//
		// CRITICAL-1: the driver always ATTEMPTS to close the seed (catching
		// non-fatally — the seed may already be closed by the builder's own
		// protocol, or the close may fail for unrelated reasons); `finish()`
		// then reads the tracker's ACTUAL resulting status fresh, rather than
		// this call site assuming "closed" or "close_failed".
		if (config.taskTracker.enabled) {
			try {
				await tracker.close(seedId, `ov drive: merged ${primaryBuilder.branchName}`);
			} catch {
				// Non-fatal: finish()'s resolveSeedStatus() reports the tracker's
				// real resulting state regardless of whether close() itself
				// succeeded.
			}
		}

		return await finish("merged", { mergedBranch: primaryBuilder.branchName });
	} catch (err) {
		// HIGH-5: an unexpected throw from any dispatch/merge call above (as
		// opposed to an expected structured failure) must still reach `finish`
		// exactly once so live sessions are terminalized, metrics are
		// finalized best-effort, and the store is closed. `finish` itself is
		// defensively wrapped step-by-step and cannot throw; the nested
		// try/catch below is a last-resort fallback only in case that
		// invariant is ever violated by a future change.
		//
		// finding F: surface the thrown error's message (e.g. the
		// non-headless-descendant AgentError) to stderr before collapsing to
		// the generic "failed" outcome, so this failure mode is diagnosable
		// instead of silently indistinguishable from every other exception.
		try {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`ov drive: run ${runId} aborted: ${msg}\n`);
		} catch {
			// Non-fatal: diagnostic output must not mask the real outcome.
		}
		try {
			return await finish("failed", {});
		} catch {
			clearTimeout(deadlineTimer);
			try {
				store.close();
			} catch {
				// Already closed or unavailable — nothing more to do.
			}
			return { outcome: "failed", runId, agents: [], seedStatus: "unknown" };
		}
	}
}

/** Create the Commander command for `ov drive`. */
export function createDriveCommand(): Command {
	return new Command("drive")
		.description(
			"Headless run-to-completion: seed a top agent, drive mail until quiescent, " +
				"reconcile+review+merge once, close the seed. SOLE-SUPERVISOR ASSUMPTION: do not " +
				"run `ov serve` or another `ov drive` against the same run concurrently (no cross-process lease). " +
				"Requires every driven agent to be spawn-per-turn (headless); a non-headless/legacy " +
				"descendant fails the run fast with a clear error.",
		)
		.argument("<seed-id>", "Tracker issue ID to seed the drive run against")
		.option("--capability <name>", "Capability for the seed top agent: lead or builder", "lead")
		.option("--max-turns <n>", "Circuit breaker: max total driven turns", String(DEFAULT_MAX_TURNS))
		.option(
			"--timeout <seconds>",
			"Circuit breaker: wall-clock timeout in seconds",
			String(DEFAULT_TIMEOUT_SECONDS),
		)
		.option("--no-merge", "Reconcile and review, but stop before merging")
		.option("--json", "Output the result as JSON")
		.action(async (seedId: string, opts: DriveCliOptions) => {
			try {
				const result = await driveCommand(seedId, opts);
				if (opts.json) {
					jsonOutput("drive", { ...result });
				} else {
					printSuccess("Drive finished", result.outcome);
					process.stdout.write(`   Run:      ${result.runId}\n`);
					process.stdout.write(
						`   Agents:   ${result.agents.map((a) => `${a.name}(${a.finalState})`).join(", ") || "none"}\n`,
					);
					if (result.mergedBranch) process.stdout.write(`   Merged:   ${result.mergedBranch}\n`);
					process.stdout.write(`   Seed:     ${result.seedStatus}\n`);
					if (result.breaker) {
						process.stdout.write(
							`   Breaker:  ${result.breaker.kind} (limit ${result.breaker.limit})\n`,
						);
					}
				}
				if (result.outcome !== "merged" && result.outcome !== "no_op") {
					process.exitCode = 1;
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (opts.json) {
					jsonError("drive", msg);
				} else {
					printError(msg);
				}
				process.exitCode = 1;
			}
		});
}
