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
 * MULTI-BUILDER SUPPORT (F3 fix): if the driven run produces more than one
 * builder branch, this driver reviews and merges EVERY one of them, in
 * `started_at ASC` discovery order (via `SessionStore.getByRun`), integrating
 * each successful merge onto the moving canonical target before the next
 * branch's dry-run predict + merge run (`mergeBranch` resolves its target
 * fresh on every call, so this "just works" without extra plumbing here). A
 * branch whose reviewer FAILS or whose merge is blocked/failed does not abort
 * the run — the remaining branches are still attempted, and the terminal
 * outcome honestly reflects the mix (`"merged"` only when ALL branches
 * merged, `"merged_partial"` when some-but-not-all did). `DriveResult`'s
 * `mergedBranch` field stays populated (first merged branch) for back-compat;
 * `mergedBranches` and `builderOutcomes` carry the full per-branch picture.
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
import { type QualityGateOutcome, runQualityGates } from "../insights/quality-gates.ts";
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
import type { AgentSession, QualityGate, ResolutionTier, SessionMetrics } from "../types.ts";
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

/**
 * Terminal outcome of one `ov drive` invocation.
 *
 * `"merged_partial"` (F3 fix): a multi-builder run where SOME but not ALL
 * builder branches merged. Deliberately NOT a success outcome — see
 * `finish()`'s run-completion mapping and the CLI exit-code rule below,
 * both of which treat it the same as `"failed"` (non-zero exit, run marked
 * incomplete). The seed is also left open rather than closed for this
 * outcome (Step 6/7 below) since the task is genuinely unfinished.
 *
 * `"integration_failed"` (review-round HIGH-3 fix): every builder branch
 * merged individually, but the COMBINED canonical state — after all of
 * them landed — failed this project's configured quality gates. Each
 * branch's own reviewer only ever inspected its OWN branch in isolation, so
 * two individually clean, non-conflicting branches can still integrate into
 * a broken combined build; this outcome exists so that case is never
 * silently reported as `"merged"`. Deliberately NOT a success outcome —
 * same non-zero-exit / seed-left-open treatment as `"merged_partial"`.
 */
export type DriveOutcome =
	| "merged"
	| "merged_partial"
	| "integration_failed"
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

/** One builder branch's own outcome within a (possibly multi-builder) drive run. */
export interface DriveBuilderOutcome {
	branch: string;
	outcome: string;
	reason?: string;
}

/**
 * Structured result of a drive run — also the `--json` output shape.
 *
 * Schema note (review-round LOW-6): `mergedBranches` and `builderOutcomes`
 * are ADDITIVE fields introduced by the F3 multi-builder fix. A single
 * ("N=1") run's `outcome`/`mergedBranch`/`seedStatus`/`breaker` shape is
 * byte-for-byte unchanged from before F3 — these two plural fields are
 * strictly new information layered on top, never a replacement for the
 * singular `mergedBranch`. A strict/versioned consumer can safely ignore
 * them; nothing existing changes meaning.
 */
export interface DriveResult {
	outcome: DriveOutcome;
	runId: string;
	agents: DriveAgentSummary[];
	/** First branch that merged (back-compat single-branch field). */
	mergedBranch?: string;
	/** Every branch that merged, in the order they were integrated (F3 fix). */
	mergedBranches?: string[];
	/** Per-builder-branch outcome, one entry per builder session this run drove (F3 fix). */
	builderOutcomes?: DriveBuilderOutcome[];
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
	/**
	 * Test injection: replaces the real `runQualityGates(...)` call
	 * (`../insights/quality-gates.ts`) used to gate the COMBINED canonical
	 * state after a multi-builder run merges every branch (review-round
	 * HIGH-3). Production default is the real quality-gate runner, which
	 * actually spawns each configured gate command — tests inject a fast,
	 * deterministic stub instead of depending on this project's own
	 * `bun test`/`bun run lint`/`bun run typecheck` succeeding against a
	 * bare temp fixture repo.
	 */
	runQualityGatesFn?: (gates: QualityGate[], cwd: string) => Promise<QualityGateOutcome | null>;
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
 * Review-round TOCTOU fix (Direct Assessment finding): create (or
 * force-update) a throwaway branch ref pinned at an exact, already-verified
 * sha. Used immediately before the real merge so `mergeBranchFn` merges
 * EXACTLY the sha that was reviewed and re-verified, never whatever the
 * mutable source branch ref happens to point at by the time the merge
 * subprocess actually runs — closing the narrow window between the
 * pre-merge sha re-check and the merge call itself. `mergeBranch`'s own
 * queue/branch-existence machinery requires a real `refs/heads/<name>`, so a
 * raw sha cannot be passed directly (see `merge.ts`) — pinning a dedicated
 * ref is the minimal way to make the merge target immutable without
 * touching `merge.ts`.
 */
async function pinRefAtSha(repoRoot: string, refName: string, sha: string): Promise<void> {
	const proc = Bun.spawn(["git", "update-ref", `refs/heads/${refName}`, sha], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		throw new AgentError(`failed to pin throwaway ref "${refName}" at ${sha}: ${stderr.trim()}`);
	}
}

/**
 * Best-effort cleanup counterpart to {@link pinRefAtSha}. Never throws —
 * this always runs from a `finally` block and a failure to delete a
 * throwaway ref must never mask the real merge outcome.
 */
async function deletePinnedRef(repoRoot: string, refName: string): Promise<void> {
	try {
		const proc = Bun.spawn(["git", "branch", "-D", refName], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
	} catch {
		// Non-fatal: a leaked throwaway ref is harmless (never merged into,
		// never a real builder/reviewer target) and must not mask the outcome.
	}
}

/**
 * Mail recipient label the reviewer's review-specific prompt (below)
 * instructs it to use for its verdict mail. Deliberately NOT a real
 * agent/session name: `ov drive` reads the reviewer's verdict by SENDER
 * (`from=<reviewer agent name>`), never by recipient, and `client.send`
 * persists unconditionally regardless of whether the recipient is a live
 * session (`src/mail/client.ts`'s `send()` is a plain, unconditional
 * `store.insert`, no liveness/format check on `to`) -- so any stable label
 * works. A fixed label -- rather than the reviewer's actual `parentAgent`,
 * which is the builder and is already `completed` by review time -- avoids
 * relying on the reviewer LLM to send to a target it can observe is
 * terminated, which is exactly the failure mode this fix addresses.
 */
const REVIEW_VERDICT_MAIL_RECIPIENT = "ov-drive-supervisor";

/**
 * Build a review-specific initial-turn prompt for the reviewer agent `ov
 * drive` spawns during reconcile. Passed as `specContent` (an existing
 * `spawnHeadlessSession` seam -- see `headless-prompt.ts`'s
 * `buildInitialHeadlessPrompt`), which surfaces it as an "AUTHORITATIVE"
 * task-specification section in the reviewer's very first turn, ahead of
 * the generic auto-dispatch mail and the startup beacon.
 *
 * Root cause this addresses (confirmed via a live sandbox spike): the
 * reviewer's own agent-def prose (`agents/reviewer.md`) only tells it to
 * "send worker_done to your parent" -- advisory text a reviewer LLM can (and
 * did) decide not to follow once it observes its parent (spawned as
 * `parentAgent: topAgentName`, the builder -- already `completed` by review
 * time) has terminated: it reasoned the mail would "bounce" and gave up
 * without sending, so the driver's `from=reviewerName` verdict lookup found
 * nothing and the run failed. This prompt overrides that with an explicit,
 * unconditional instruction to send regardless of any other agent's
 * apparent liveness, to a fixed recipient label that never needs to be a
 * live session (see {@link REVIEW_VERDICT_MAIL_RECIPIENT}).
 */
function buildReviewerPrompt(opts: { taskId: string; branchName: string }): string {
	const { taskId, branchName } = opts;
	return [
		`You are REVIEWING already-completed work for task "${taskId}", not building it.`,
		`The changes are already committed on branch "${branchName}", which is checked out in your worktree right now. There is nothing left to implement -- do not wait for further instructions or for anyone else to respond before proceeding.`,
		"1. Verify correctness: read the diff against the base branch, read the modified files in full, and run any applicable quality gates.",
		"2. Reach a PASS or FAIL verdict.",
		"3. Send your verdict mail as your final action, via:",
		`   ov mail send --to ${REVIEW_VERDICT_MAIL_RECIPIENT} --subject "Worker done: ${taskId} — PASS" --body "<your findings>" --type worker_done --agent $OVERSTORY_AGENT_NAME`,
		'   (use "— FAIL" in the subject instead if the review fails -- the PASS/FAIL token must be the last thing on the subject line, exactly as shown).',
		`SEND THIS MAIL UNCONDITIONALLY -- even if your parent agent, or any other agent in this run, appears completed, terminated, or unreachable. This run tracks your verdict by SENDER, not by recipient liveness: it is captured by matching "from=<your agent name>", never by whether "${REVIEW_VERDICT_MAIL_RECIPIENT}" is a live session. Sending never "bounces" and is never pointless -- it is the ONLY way this run learns your verdict. Do not skip sending, and do not narrate that the recipient is gone instead of sending.`,
	].join("\n\n");
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
	/**
	 * F3 fix: every builder branch this run merges is recorded here (not just
	 * a single "the" merge), so `finalizeAllSeen()` below can tag EACH merged
	 * builder's own metrics row with its own tier, not just one hardcoded
	 * "primary" builder's.
	 */
	const mergedTierByAgent = new Map<string, ResolutionTier | null>();

	/** One builder branch's own (non-breaker) outcome from `reviewAndMergeBranch`. */
	type BranchResult = {
		kind: Exclude<DriveOutcome, "breaker" | "merged_partial" | "integration_failed">;
		branch: string;
		agentName: string;
		tier: ResolutionTier | null;
	};
	/** Signals a run-wide circuit-breaker trip — aborts the whole loop below. */
	type BranchBreaker = { kind: "breaker"; breaker: DriveBreakerInfo };

	/**
	 * Review-round MEDIUM-4 fix: every branch outcome landed so far, hoisted
	 * to this OUTER scope (not just local to the per-branch loop below) so
	 * BOTH a mid-loop breaker trip AND the outer catch-all exception handler
	 * can still disclose whichever branches already merged before the
	 * breaker/exception hit. Canonical was already modified by those earlier
	 * merges — hiding that from the result would be a silent lie about what
	 * this run actually did to the repo.
	 */
	const branchResults: BranchResult[] = [];

	/**
	 * Derive the `mergedBranch`/`mergedBranches`/`builderOutcomes` disclosure
	 * fields from whatever `branchResults` holds RIGHT NOW (review-round
	 * MEDIUM-4). Used by the two "the run is ending abnormally mid-loop"
	 * sites (breaker trip, outer catch) — the three normal completion paths
	 * below (all-merged / merged_partial / none-merged) keep building these
	 * fields inline themselves since they also need `mergedResults`.
	 */
	const buildAccumulatedMergeExtra = (): Pick<
		DriveResult,
		"mergedBranch" | "mergedBranches" | "builderOutcomes"
	> => {
		const merged = branchResults.filter((r) => r.kind === "merged").map((r) => r.branch);
		return {
			mergedBranch: merged[0],
			mergedBranches: merged,
			builderOutcomes: branchResults.map((r) => ({ branch: r.branch, outcome: r.kind })),
		};
	};

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
					mergeResult: mergedTierByAgent.has(session.agentName)
						? (mergedTierByAgent.get(session.agentName) ?? null)
						: null,
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
		extra: Partial<
			Pick<DriveResult, "mergedBranch" | "mergedBranches" | "builderOutcomes" | "breaker">
		> = {},
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
		if (extra.mergedBranches && extra.mergedBranches.length > 0) {
			result.mergedBranches = extra.mergedBranches;
		}
		if (extra.builderOutcomes && extra.builderOutcomes.length > 0) {
			result.builderOutcomes = extra.builderOutcomes;
		}
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
		// MEDIUM-5: `SessionStore.getByRun`'s own SQL ordering is
		// `started_at ASC` only (millisecond resolution, no tiebreak) — two
		// builders spawned close enough together can tie, leaving merge order
		// (and therefore which branch's changes a LATER branch's dry-run
		// predict + real merge actually integrates onto) nondeterministic
		// across otherwise-identical runs. Re-sort here with a stable
		// secondary key (`id`, the session row's own unique primary key) so a
		// timestamp tie always resolves to the same order. `store.ts` itself
		// is out of scope for this fix (see the finding) — this sort is
		// equivalent for every caller of this driver, since `getByRun` is only
		// ever consumed here.
		builderSessions = [...builderSessions].sort((a, b) => {
			if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
			if (a.id === b.id) return 0;
			return a.id < b.id ? -1 : 1;
		});

		/**
		 * Review + merge (or reject) exactly ONE builder branch. Extracted
		 * (F3 fix) from the pre-fix single-branch flow so `driveCommand` can
		 * loop it over every builder branch this run produced, in
		 * `started_at ASC` order: reviewedSha snapshot -> reviewer
		 * spawn+drive+verdict -> `--no-merge` short-circuit -> dry-run predict
		 * -> pre-merge sha re-check -> real merge. Every finding referenced
		 * inline below (HIGH-3, finding A/B, MEDIUM-7) applies per-branch
		 * exactly as it did to the single "primary" branch before this fix —
		 * `mergeBranch` resolves its target fresh on every call, so a
		 * successful merge here naturally becomes the base the NEXT branch's
		 * dry-run predict + real merge integrate onto.
		 */
		const reviewAndMergeBranch = async (
			builder: AgentSession,
		): Promise<BranchResult | BranchBreaker> => {
			const branch = builder.branchName;
			const agentName = builder.agentName;
			const asFailed = (): BranchResult => ({ kind: "failed", branch, agentName, tier: null });

			// HIGH-3: capture this builder branch's immutable HEAD sha the moment
			// reconcile selects it. This is the exact snapshot the reviewer is
			// asked to inspect, and is re-verified below immediately before the
			// real merge.
			const reviewedSha = await getBranchHeadShaFn(config.project.root, branch);
			if (!reviewedSha) {
				return asFailed();
			}

			// Spawn a reviewer on this builder's branch and drive it to terminal.
			// CRITICAL-1: tracker-neutral (skipTaskCheck) — a real builder/lead
			// closes its OWN seed task as part of its completion protocol before
			// sending terminal mail, so `builder.taskId` (often == seedId) may
			// already be "closed" by the time we get here. Requiring it to be
			// workable would wrongly fail every real run.
			const reviewerBreaker = checkBudgetOrDeadlineBreaker();
			if (reviewerBreaker) {
				return { kind: "breaker", breaker: reviewerBreaker };
			}

			let reviewerName: string;
			// finding B: snapshot the mail table's monotonic rowid high-water-mark
			// immediately before THIS branch's reviewer spawn. Mail `created_at`
			// is only millisecond-resolution and can collide (or be forged /
			// backdated, or simply belong to a PRIOR branch's own reviewer in
			// this same run) — only a mail whose `rowid` is strictly greater than
			// this snapshot can ever be treated as THIS branch's verdict.
			const reviewSeqMailStore = createMailStore(mailDbPath);
			let reviewMailSeqSnapshot: number;
			try {
				reviewMailSeqSnapshot = reviewSeqMailStore.getMaxRowid();
			} finally {
				reviewSeqMailStore.close();
			}
			try {
				const reviewerSpawn = await spawnDriveAgent({
					requestedName: `reviewer-${builder.taskId}`,
					capability: "reviewer",
					taskId: builder.taskId,
					parentAgent: topAgentName,
					depth: topSessionAfterMain.depth + 1,
					runId,
					baseBranch: branch,
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
					specContent: buildReviewerPrompt({ taskId: builder.taskId, branchName: branch }),
				});
				reviewerName = reviewerSpawn.agentName;
				trackSessionId(reviewerName, reviewerSpawn.firstTurn.newSessionId);
				lastExitCodeByAgent.set(reviewerName, reviewerSpawn.firstTurn.exitCode);
			} catch {
				// finding D / finding 4: same breaker-vs-failed disambiguation as the
				// seed spawn — deadline-only, never the turn budget.
				const breaker = checkDeadlineAbort();
				return breaker ? { kind: "breaker", breaker } : asFailed();
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
				return { kind: "breaker", breaker: reviewLoopResult.breaker };
			}

			const reviewerSession = store.getByName(reviewerName);
			if (!reviewerSession || reviewerSession.state === "zombie") {
				// finding D / finding 4: same breaker-vs-failed disambiguation as
				// topSessionAfterMain — deadline-only, never the turn budget.
				const breaker = checkDeadlineAbort();
				return breaker ? { kind: "breaker", breaker } : asFailed();
			}

			// Parse the reviewer's terminal verdict from a mail STRICTLY AFTER
			// this branch's pre-spawn rowid snapshot (finding B — rowid, not
			// wall-clock, so a stale/forged/collided timestamp — including one
			// left behind by a PRIOR branch's reviewer in this same run — can
			// never qualify), of EITHER terminal type a reviewer may legitimately
			// send: this repo's own deployed `.overstory/agent-defs/reviewer.md`
			// sends `type: result`, not `worker_done` (finding A). `list()`
			// orders `created_at DESC, rowid DESC`, so `messages[0]` is
			// deterministically the most recent qualifying mail. The verdict
			// token is matched in the subject first, falling back to the body
			// (finding A) — never a stale prior-run mail or a substring match
			// (BYPASS/PASSING/FAILURE).
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
				return { kind: "review_failed", branch, agentName, tier: null };
			}
			if (verdict !== "pass") {
				return asFailed();
			}

			if (noMerge) {
				return { kind: "no_op", branch, agentName, tier: null };
			}

			// Step 5: merge this branch. Dry-run structurally can never return
			// outcome "conflict" (see mergeBranch's doc comment) — the canonical
			// "tier above auto" signal is ConflictPrediction.wouldRequireAgent.
			//
			// MEDIUM-7: distinguish a genuine predicted conflict (`merge_blocked`,
			// a real policy gate) from a prediction INFRASTRUCTURE failure (a
			// mulch outage etc., surfaced by `safePredictForEntry`'s catch-fallback
			// as a synthetic `wouldRequireAgent: true` envelope whose `reason`
			// starts with "prediction-failed:") — an outage is an operational
			// failure, not a policy gate, and must not block an otherwise-clean
			// merge under the "merge_blocked" label. No prediction at all is also
			// an operational failure.
			const dryRunResult = await mergeBranchFn(branch, { dryRun: true });
			const prediction = dryRunResult.prediction;
			if (!prediction) {
				return asFailed();
			}
			if (prediction.reason.startsWith(PREDICTION_FAILED_PREFIX)) {
				return asFailed();
			}
			if (prediction.wouldRequireAgent) {
				return { kind: "merge_blocked", branch, agentName, tier: null };
			}

			// HIGH-3: re-verify this branch's HEAD sha immediately before merging
			// still equals what was reviewed. If it advanced (a builder or
			// anything else landed a newer, unreviewed commit on that branch
			// between review and merge), refuse the merge rather than land an
			// unreviewed tip. Documented lean-scope gap: this fails the branch
			// rather than looping back into a re-review.
			const shaAtMerge = await getBranchHeadShaFn(config.project.root, branch);
			if (shaAtMerge !== reviewedSha) {
				return asFailed();
			}

			// Review-round TOCTOU fix (Direct Assessment finding, was finding G's
			// "documented residual gap, no code change" above): a narrow window
			// still existed between the sha re-check immediately above and
			// `mergeBranchFn(...)` actually landing the merge below — nothing in
			// this single-process, lease-free driver prevents another writer from
			// advancing the mutable `branch` ref in that small gap, and
			// `mergeBranchFn(branch)` always resolves the branch NAME fresh, not
			// the sha this driver just verified. Close it by pinning a throwaway
			// ref at exactly `reviewedSha` (already re-verified as the branch's
			// current tip one line above) and merging THAT immutable ref instead
			// of the mutable branch name — a ref advancing after this point can no
			// longer change what gets merged. `mergeBranchFn`'s own MergeQueue
			// entry is keyed by branch NAME, so the pinned ref must be passed
			// through and the resulting queue entry/branch bookkeeping cleaned up
			// (`deletePinnedRef` in `finally`) regardless of outcome.
			//
			// Documented trade-off: because no queue entry already exists under
			// `pinnedRefName` (the dry-run predict call above enqueued one under
			// the real `branch` name, not this one-off ref), `mergeBranch` builds
			// a FRESH entry for it and derives `agentName`/`taskId` from the ref
			// name via its own `overstory/{agentName}/{taskId}` convention parser
			// — which `ov-drive-pin/...` never matches, so that entry's
			// agent/task metadata is cosmetically "unknown" regardless of the
			// real branch's naming. This does not affect this driver's own
			// `DriveResult`/`BranchResult` (which always use the real `branch`
			// and `agentName` captured above, never `realResult.entry`), only the
			// merge-queue's own internal bookkeeping for this one throwaway entry.
			const pinnedRefName = `ov-drive-pin/${branch}`;
			let realResult: MergeBranchResult;
			try {
				await pinRefAtSha(config.project.root, pinnedRefName, reviewedSha);
				realResult = await mergeBranchFn(pinnedRefName);
			} finally {
				await deletePinnedRef(config.project.root, pinnedRefName);
			}
			if (realResult.outcome === "conflict") {
				return { kind: "merge_blocked", branch, agentName, tier: null };
			}
			if (realResult.outcome !== "merged") {
				// "failed" (resolver error, no content conflict) or any other
				// non-merged/non-conflict outcome -> operational failure (MEDIUM-7),
				// not a policy gate.
				return asFailed();
			}

			return { kind: "merged", branch, agentName, tier: realResult.tier ?? null };
		};

		// Loop over EVERY builder branch (F3 fix), in `started_at ASC`
		// discovery order (see `SessionStore.getByRun`'s own ordering, with
		// MEDIUM-5's stable secondary sort applied above). A branch whose
		// reviewer FAILS or whose merge is blocked/failed does NOT abort the
		// run — the loop keeps attempting the remaining branches, so the
		// terminal outcome (below) honestly reflects exactly which branches
		// integrated. A true circuit-breaker trip (turn budget or wall-clock
		// deadline) DOES abort the whole run immediately, same as the pre-fix
		// single-branch behavior -- but (MEDIUM-4) still discloses whichever
		// EARLIER branches in this loop already merged before the trip,
		// instead of silently dropping that canonical-modifying side effect.
		for (const builder of builderSessions) {
			const step = await reviewAndMergeBranch(builder);
			if (step.kind === "breaker") {
				return await finish("breaker", {
					breaker: step.breaker,
					...buildAccumulatedMergeExtra(),
				});
			}
			branchResults.push(step);
			if (step.kind === "merged") {
				mergedTierByAgent.set(step.agentName, step.tier);
			}
		}

		const mergedResults = branchResults.filter((r) => r.kind === "merged");
		const mergedBranchNames = mergedResults.map((r) => r.branch);
		const builderOutcomes: DriveBuilderOutcome[] = branchResults.map((r) => ({
			branch: r.branch,
			outcome: r.kind,
		}));

		if (mergedResults.length === builderSessions.length) {
			// ALL builder branches merged individually.
			//
			// Review-round HIGH-3 fix: each branch's own reviewer only ever
			// inspected THAT branch in isolation against the canonical state at
			// the time it ran — by the time a LATER branch merges, an EARLIER
			// branch's changes are already integrated onto canonical, but
			// nothing has reviewed the COMBINED result. Two individually clean,
			// non-conflicting branches can still integrate into a broken
			// combined build. Only relevant with more than one builder branch:
			// a single-builder run's reviewer already reviewed exactly what
			// just got merged, so gating it again here would add new behavior
			// to the N=1 path for zero additional coverage (this file's
			// documented "keep the single-builder path behaviorally identical"
			// contract). Judgment call (simpler-correct option, per the
			// review): reuse the project's already-existing, already-tested
			// `runQualityGates` module against the canonical checkout, rather
			// than spawning a whole extra integration-reviewer agent — same
			// signal, far less machinery, and it is exactly what session-end
			// already uses this module for (`src/commands/log.ts`).
			if (builderSessions.length > 1) {
				const runQualityGatesFn = deps.runQualityGatesFn ?? runQualityGates;
				const gates: QualityGate[] = config.project.qualityGates ?? [];
				let gateOutcome: QualityGateOutcome | null;
				try {
					gateOutcome = await runQualityGatesFn(gates, config.project.root);
				} catch {
					// A gate-runner crash is itself an integration-verification
					// failure, not a clean pass -- fail closed rather than silently
					// treating "we could not check" as "it's fine".
					gateOutcome = { status: "failure", results: [], totalDurationMs: 0 };
				}
				if (gateOutcome && gateOutcome.status !== "success") {
					// Do NOT close the seed here (left open, matching
					// "merged_partial"'s treatment below) -- the combined result
					// is unverified/broken even though every individual branch
					// merged cleanly, so the task is not actually done.
					return await finish("integration_failed", {
						mergedBranch: mergedBranchNames[0],
						mergedBranches: mergedBranchNames,
						builderOutcomes,
					});
				}
			}

			// Step 6/7: verify (mergeBranch's own "merged" outcome is the
			// per-branch verification signal — no extra ancestor cross-check;
			// documented lean-scope gap) then close the seed and finalize
			// metrics.
			//
			// CRITICAL-1: the driver always ATTEMPTS to close the seed (catching
			// non-fatally — the seed may already be closed by a builder's own
			// protocol, or the close may fail for unrelated reasons); `finish()`
			// then reads the tracker's ACTUAL resulting status fresh, rather than
			// this call site assuming "closed" or "close_failed".
			if (config.taskTracker.enabled) {
				try {
					await tracker.close(seedId, `ov drive: merged ${mergedBranchNames.join(", ")}`);
				} catch {
					// Non-fatal: finish()'s resolveSeedStatus() reports the tracker's
					// real resulting state regardless of whether close() itself
					// succeeded.
				}
			}
			return await finish("merged", {
				mergedBranch: mergedBranchNames[0],
				mergedBranches: mergedBranchNames,
				builderOutcomes,
			});
		}

		if (mergedResults.length > 0) {
			// F3 fix: SOME builder branches merged, some did not — an honest
			// partial outcome, deliberately NOT reported as "merged". The seed is
			// left OPEN here (unlike the all-merged branch above): the task is
			// genuinely incomplete, and `finish()`'s own run-completion mapping
			// marks the run itself as not "completed" for this outcome too.
			//
			// Review-round HIGH-1 fix: "left open" must be an actual guarantee,
			// not just "we didn't call close()". A real builder/lead can (and,
			// per this driver's own CRITICAL-1 handling, is explicitly allowed
			// to) close its OWN seed task as part of its completion protocol
			// BEFORE this driver ever reaches this point -- so the seed may
			// already be sitting "closed" from the builder's own side effect
			// even though this run's own outcome is only a partial merge.
			// `TrackerClient` has no dedicated reopen operation, so best-effort
			// re-claim it (the same call a real builder uses to mark an issue
			// "in_progress" / open) -- non-fatal, matching every other
			// tracker-mutation call site in this file: `finish()`'s
			// `resolveSeedStatus()` reads the tracker's ACTUAL resulting status
			// fresh regardless of whether this call itself succeeds.
			if (config.taskTracker.enabled) {
				try {
					await tracker.claim(seedId);
				} catch {
					// Non-fatal: best-effort reopen must not mask the real outcome;
					// finish()'s resolveSeedStatus() reports the truth either way.
				}
			}
			return await finish("merged_partial", {
				mergedBranch: mergedBranchNames[0],
				mergedBranches: mergedBranchNames,
				builderOutcomes,
			});
		}

		// NONE merged.
		//
		// Review-round HIGH-2 fix: pre-fix, this blindly adopted
		// `branchResults[0]`'s own outcome as the whole run's outcome --
		// correct for the true single-builder case (matches this driver's
		// pre-multi-builder behavior exactly, since there IS only one
		// element), but silently wrong for multi-builder: e.g.
		// `[no_op, review_failed]` would report `"no_op"` and the CLI would
		// exit 0 even though a real review genuinely failed. `"no_op"` is now
		// reported ONLY when EVERY branch's own outcome is `"no_op"` (the true
		// multi-builder `--no-merge` case, or every branch degenerately
		// no-op for some other reason); otherwise the first non-"no_op"
		// outcome wins (arbitrary among failure kinds, since none of them are
		// a success) so a real failure can never be masked by a co-occurring
		// no_op.
		const allNoOp = branchResults.length > 0 && branchResults.every((r) => r.kind === "no_op");
		const firstNonNoOp = branchResults.find((r) => r.kind !== "no_op");
		const noneMergedOutcome = allNoOp
			? "no_op"
			: ((firstNonNoOp ?? branchResults[0])?.kind ?? "failed");
		return await finish(noneMergedOutcome, { builderOutcomes });
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
			// Review-round MEDIUM-4 fix: an unexpected exception can just as well
			// land after one or more EARLIER branches in the loop already merged
			// (canonical was already modified) -- disclose that via the same
			// accumulator the mid-loop breaker-trip path above uses, instead of
			// silently reporting empty `mergedBranches`/`builderOutcomes`.
			return await finish("failed", buildAccumulatedMergeExtra());
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
					if (result.mergedBranches && result.mergedBranches.length > 0) {
						process.stdout.write(`   Merged:   ${result.mergedBranches.join(", ")}\n`);
					} else if (result.mergedBranch) {
						process.stdout.write(`   Merged:   ${result.mergedBranch}\n`);
					}
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
