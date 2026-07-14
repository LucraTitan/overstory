import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnRunnerFn } from "../agents/headless-mail-injector.ts";
import type { TurnSpawnFn, TurnSubprocess } from "../agents/turn-runner.ts";
import { ValidationError } from "../errors.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { cleanupTempDir, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import type { TrackerClient, TrackerIssue } from "../tracker/types.ts";
import type { SessionMetrics } from "../types.ts";
import { driveCommand } from "./drive.ts";
import type { Spawner } from "./init.ts";
import { initCommand } from "./init.ts";
import type { MergeBranchResult } from "./merge.ts";

/**
 * `ov drive` unit + integration tests, modeled on
 * `src/agents/headless-session.test.ts` (fake-proc/TurnSpawnFn injection) and
 * `src/e2e/init-sling-lifecycle.test.ts` (real temp-repo + noop-spawner
 * harness). No live Claude agents — every simulated agent turn is driven by
 * a fake `_spawnFn` that emits stream-json events and, where relevant, real
 * git commits + real mail rows as side effects.
 *
 * SIMPLIFICATION (documented, matches drive.ts's own reconcile fallback):
 * every test seeds the top agent with `--capability builder`. Per
 * `driveCommand`'s reconcile step, when no separate builder session exists
 * under the run, the top agent itself becomes `primaryBuilder` if its own
 * capability is "builder" — so a fake top-level lead-spawns-a-builder
 * sub-agent flow is unnecessary to exercise reconcile/review/merge.
 */

/** No-op spawner: treats all ecosystem CLIs (ml/sd/cn) as not installed. */
const noopSpawner: Spawner = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });

// ---------- fake subprocess plumbing (mirrors headless-session.test.ts) ----------

interface FakeProc extends TurnSubprocess {
	_pushLine(line: string): void;
	_exit(code: number | null): void;
}

let fakeProcCounter = 9000;

function makeFakeProc(): FakeProc {
	let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			stdoutController = c;
		},
	});
	let stdoutClosed = false;
	const closeStdout = (): void => {
		if (stdoutClosed) return;
		stdoutClosed = true;
		try {
			stdoutController.close();
		} catch {
			// already closed
		}
	};

	let resolveExited!: (code: number | null) => void;
	const exited = new Promise<number | null>((resolve) => {
		resolveExited = resolve;
	});
	let exitedDone = false;
	const finishExit = (code: number | null): void => {
		if (exitedDone) return;
		exitedDone = true;
		resolveExited(code);
	};

	const proc: FakeProc = {
		pid: fakeProcCounter++,
		stdin: {
			write(_data: string | Uint8Array): number {
				return 0;
			},
			end(): void {
				// no-op for fakes
			},
		},
		stdout,
		exited,
		kill(): void {
			closeStdout();
			finishExit(null);
		},
		_pushLine(line: string): void {
			if (stdoutClosed) return;
			stdoutController.enqueue(new TextEncoder().encode(`${line}\n`));
		},
		_exit(code: number | null): void {
			closeStdout();
			finishExit(code);
		},
	};
	return proc;
}

function emitFakeTurn(proc: FakeProc, opts: { sessionId?: string; isError?: boolean }): void {
	const sessionId = opts.sessionId ?? "session-test";
	proc._pushLine(
		JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: sessionId,
			model: "claude-test",
		}),
	);
	proc._pushLine(
		JSON.stringify({
			type: "result",
			subtype: "success",
			session_id: sessionId,
			result: "done",
			is_error: opts.isError ?? false,
			duration_ms: 10,
			num_turns: 1,
		}),
	);
}

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: "Overstory Test",
	GIT_AUTHOR_EMAIL: "test@overstory.dev",
	GIT_COMMITTER_NAME: "Overstory Test",
	GIT_COMMITTER_EMAIL: "test@overstory.dev",
};

/**
 * Insert a real terminal mail row from `agentName` (terminal-mail contract).
 * `type` defaults to `"worker_done"` (matches every pre-existing test's
 * fixture); pass `"result"` to exercise finding A (this repo's real deployed
 * `.overstory/agent-defs/reviewer.md` sends `type: result`, not
 * `worker_done`). Returns the inserted message id.
 */
function sendTerminalMailSync(
	overstoryDir: string,
	agentName: string,
	subject: string,
	type: "worker_done" | "result" = "worker_done",
): string {
	const store = createMailStore(join(overstoryDir, "mail.db"));
	try {
		return createMailClient(store).send({
			from: agentName,
			to: agentName,
			subject,
			body: "done",
			type,
			priority: "normal",
		});
	} finally {
		store.close();
	}
}

/** Real git commit into the agent's worktree, so its branch has a mergeable diff. */
function commitFileChangeSync(worktreePath: string, agentName: string): void {
	writeFileSync(join(worktreePath, "drive-output.txt"), `written by ${agentName}\n`);
	const add = Bun.spawnSync(["git", "add", "-A"], {
		cwd: worktreePath,
		env: { ...process.env, ...GIT_TEST_ENV },
	});
	if (add.exitCode !== 0) {
		throw new Error(`git add failed: ${new TextDecoder().decode(add.stderr)}`);
	}
	const commit = Bun.spawnSync(["git", "commit", "-m", "drive-e2e: add file"], {
		cwd: worktreePath,
		env: { ...process.env, ...GIT_TEST_ENV },
	});
	if (commit.exitCode !== 0) {
		throw new Error(`git commit failed: ${new TextDecoder().decode(commit.stderr)}`);
	}
}

/**
 * HIGH-3 race-test helper: commit an EXTRA, out-of-band change directly onto
 * an already-spawned agent's own worktree/branch (simulating something
 * landing on the builder branch AFTER `ov drive` already captured its
 * reviewed HEAD sha). Reuses the builder's own worktree path -- it is still
 * checked out on that branch (worktrees are only rolled back on spawn
 * failure), so a second `git worktree add` for the same branch would fail
 * with "already checked out" -- committing directly into the existing
 * worktree is both simpler and realistic.
 */
function raceCommitOntoBranch(worktreePath: string): void {
	writeFileSync(join(worktreePath, "raced-file.txt"), "raced by an out-of-band actor\n");
	const add = Bun.spawnSync(["git", "add", "-A"], {
		cwd: worktreePath,
		env: { ...process.env, ...GIT_TEST_ENV },
	});
	if (add.exitCode !== 0) {
		throw new Error(`git add failed: ${new TextDecoder().decode(add.stderr)}`);
	}
	const commit = Bun.spawnSync(
		["git", "commit", "-m", "race: advance branch after review baseline"],
		{ cwd: worktreePath, env: { ...process.env, ...GIT_TEST_ENV } },
	);
	if (commit.exitCode !== 0) {
		throw new Error(`git commit failed: ${new TextDecoder().decode(commit.stderr)}`);
	}
}

/**
 * Build a shared fake `_spawnFn`. Branches purely on
 * `OVERSTORY_AGENT_NAME` prefix (`reviewer-...` vs. the top "builder-..."
 * agent) — always present in the spawn env regardless of runtime
 * (`turn-runner.ts` sets it unconditionally).
 */
function makeFakeSpawn(opts: {
	overstoryDir: string;
	/** Reviewer's terminal-mail verdict. Omit terminal mail entirely with "none". */
	reviewVerdict?: "PASS" | "FAIL" | "none";
	/**
	 * When false, the top agent's turns never emit a clean result — it stays
	 * non-terminal forever (used to exercise the no-progress breaker).
	 */
	builderTerminal?: boolean;
	/**
	 * Called synchronously right after the builder commits its change, before
	 * it sends terminal mail — lets a test simulate a real agent's protocol of
	 * closing its own seed task before terminal mail (CRITICAL-1), or
	 * inserting an extra live session row (HIGH-3 quiescence).
	 */
	onBuilderCommit?: () => void;
	/**
	 * Called synchronously at the very start of the reviewer's first turn,
	 * before it emits any result or sends its verdict mail — lets a test race
	 * an out-of-band commit onto the builder's branch between `ov drive`'s
	 * reviewed-sha capture and its pre-merge re-verification (HIGH-3).
	 */
	onReviewerSpawn?: () => void;
	/**
	 * finding A: the reviewer's terminal mail type. This repo's real deployed
	 * `.overstory/agent-defs/reviewer.md` sends `type: "result"`, not
	 * `worker_done`. Defaults to `"worker_done"` so every pre-existing test's
	 * behavior is unchanged; opt into `"result"` to exercise the fix.
	 */
	reviewerMailType?: "worker_done" | "result";
}): TurnSpawnFn {
	let counter = 0;
	return (_cmd, spawnOpts) => {
		const agentName = spawnOpts.env.OVERSTORY_AGENT_NAME ?? "unknown";
		const worktreePath = spawnOpts.cwd;
		const fake = makeFakeProc();
		const sessionId = `sess-${agentName}-${counter++}`;

		if (agentName.startsWith("reviewer-")) {
			opts.onReviewerSpawn?.();
			const verdict = opts.reviewVerdict ?? "PASS";
			if (verdict !== "none") {
				sendTerminalMailSync(
					opts.overstoryDir,
					agentName,
					`Worker done: review — ${verdict}`,
					opts.reviewerMailType ?? "worker_done",
				);
			}
			emitFakeTurn(fake, { sessionId });
			fake._exit(0);
			return fake;
		}

		// Top ("builder") agent.
		if (opts.builderTerminal === false) {
			emitFakeTurn(fake, { sessionId, isError: true });
			fake._exit(0);
			return fake;
		}
		commitFileChangeSync(worktreePath, agentName);
		opts.onBuilderCommit?.();
		sendTerminalMailSync(opts.overstoryDir, agentName, `Worker done: ${agentName}`);
		emitFakeTurn(fake, { sessionId });
		fake._exit(0);
		return fake;
	};
}

// ---------- fake tracker ----------

/**
 * `statusById` reflects REAL open->closed transitions (CRITICAL-1): `show()`
 * reads it, `close()` writes it. `ov drive` now always resolves seed status
 * by reading the tracker fresh at its single exit point rather than assuming
 * "open"/"closed" — so a test simulating a real agent's own self-close
 * (before `ov drive`'s own end-of-run close) needs `show()` to reflect that.
 */
function makeFakeTracker(overrides: Partial<TrackerClient> = {}): {
	tracker: TrackerClient;
	closedIds: string[];
	statusById: Map<string, string>;
} {
	const closedIds: string[] = [];
	const statusById = new Map<string, string>();
	const tracker: TrackerClient = {
		async ready(): Promise<TrackerIssue[]> {
			return [];
		},
		async show(id: string): Promise<TrackerIssue> {
			return {
				id,
				title: "drive test seed",
				status: statusById.get(id) ?? "open",
				priority: 1,
				type: "task",
			};
		},
		async create(): Promise<string> {
			return "unused";
		},
		async claim(): Promise<void> {},
		async close(id: string): Promise<void> {
			closedIds.push(id);
			statusById.set(id, "closed");
		},
		async list(): Promise<TrackerIssue[]> {
			return [];
		},
		async sync(): Promise<void> {},
		...overrides,
	};
	return { tracker, closedIds, statusById };
}

// ---------- test suite ----------

describe("driveCommand", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		await initCommand({ _spawner: noopSpawner });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	describe("pre-flight validation", () => {
		test("throws ValidationError for an unrecognized --capability", async () => {
			await expect(driveCommand("seed-1", { capability: "scout" })).rejects.toBeInstanceOf(
				ValidationError,
			);
		});

		test("throws ValidationError for --max-turns 0 (breakers must be non-zero)", async () => {
			await expect(
				driveCommand("seed-1", { capability: "builder", maxTurns: "0" }),
			).rejects.toBeInstanceOf(ValidationError);
		});

		test("throws ValidationError for a blank seed id", async () => {
			await expect(driveCommand("   ", {})).rejects.toBeInstanceOf(ValidationError);
		});
	});

	test("happy path: reconcile -> review PASS -> merge -> seed closed -> metrics recorded", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const result = await driveCommand("seed-1", { capability: "builder" }, { _spawnFn, tracker });

		expect(result.outcome).toBe("merged");
		expect(result.mergedBranch).toBeTruthy();
		expect(result.seedStatus).toBe("closed");
		expect(closedIds).toContain("seed-1");
		expect(result.agents.length).toBeGreaterThanOrEqual(2); // top + reviewer

		// The merge actually landed: the canonical checkout (tempDir, still on
		// "main") now has the builder's committed file.
		expect(await Bun.file(join(tempDir, "drive-output.txt")).exists()).toBe(true);

		// Exactly-once F2 metrics finalization produced session rows for this run.
		const metricsStore = createMetricsStore(join(overstoryDir, "metrics.db"));
		try {
			const rows = metricsStore.getSessionsByRun(result.runId);
			expect(rows.length).toBeGreaterThanOrEqual(2);
			const agentNames = rows.map((r) => r.agentName);
			for (const summary of result.agents) {
				expect(agentNames).toContain(summary.name);
			}
		} finally {
			metricsStore.close();
		}
	});

	test("finding E: metrics startedAt reflects each session's real pre-first-turn timestamp, not a post-hoc override from the injectable breaker clock", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		// A deliberately bogus injected `now()`, far from real wall-clock time.
		// `ov drive` only ever uses this for the deadline/turn-budget breaker
		// clock (HIGH-2) -- it must never leak into a metrics timestamp.
		// Pre-fix, `drive.ts` derived each agent's metrics `startedAt` from
		// THIS injected clock (`new Date(now()).toISOString()`), captured
		// AFTER `spawnDriveAgent` already returned -- overriding the session
		// row's own correct pre-first-turn timestamp (set by
		// `spawnHeadlessSession` BEFORE driving the first turn) with both a
		// wrong VALUE (the sentinel) and a wrong INSTANT (post-first-turn,
		// undercounting agents that spend most of their time in that turn).
		const SENTINEL_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
		const now = () => SENTINEL_MS;

		const recordedStartedAts: string[] = [];
		const recordSessionFn = (metrics: SessionMetrics): void => {
			recordedStartedAts.push(metrics.startedAt);
		};

		const beforeSpawnMs = Date.now();
		const result = await driveCommand(
			"seed-startedat",
			{ capability: "builder" },
			{ _spawnFn, tracker, now, recordSessionFn },
		);
		const afterSpawnMs = Date.now();

		expect(result.outcome).toBe("merged");
		expect(recordedStartedAts.length).toBeGreaterThanOrEqual(2); // top + reviewer

		for (const startedAt of recordedStartedAts) {
			// Not derived from the sentinel breaker clock at all.
			expect(startedAt).not.toBe(new Date(SENTINEL_MS).toISOString());
			// Genuinely close to real wall-clock spawn time.
			const ts = new Date(startedAt).getTime();
			expect(ts).toBeGreaterThanOrEqual(beforeSpawnMs - 5000);
			expect(ts).toBeLessThanOrEqual(afterSpawnMs + 5000);
		}
	});

	test("finding A: reviewer's terminal mail is type 'result' (this repo's real deployed reviewer.md) -> still reaches 'merged'", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir, reviewerMailType: "result" });

		const result = await driveCommand(
			"seed-result-type",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		// Pre-fix, drive.ts only accepted `type: "worker_done"` for the
		// reviewer's verdict mail. `terminalMailTypesFor("reviewer")` allows
		// EITHER `worker_done` OR `result`, and the real deployed
		// `.overstory/agent-defs/reviewer.md` template actually sends `result`
		// — so every real review would have reported "failed" here.
		expect(result.outcome).toBe("merged");
		expect(result.mergedBranch).toBeTruthy();
		expect(result.seedStatus).toBe("closed");
		expect(closedIds).toContain("seed-result-type");
	});

	test("live-spike fix: reviewer's initial turn carries a review-specific AUTHORITATIVE prompt (not just the seed dispatch brief), so a persisted PASS verdict from a reviewer whose parent (the builder) is already 'completed' by review time still reaches 'merged'", async () => {
		// Root cause (confirmed via a live sandbox spike): the reviewer is
		// spawned with `parentAgent: topAgentName`, and the top/builder session
		// is already `completed` by the time the reviewer's first turn runs (a
		// spawn-per-turn agent's session terminalizes as soon as its own last
		// turn resolves cleanly). A real reviewer LLM, seeing its parent
		// terminated, reasoned its `worker_done` mail would "bounce" and gave up
		// without sending -- so `drive.ts`'s `from=reviewerName` verdict lookup
		// found nothing and the run failed, even though the review itself
		// reached PASS. The fix gives the reviewer an explicit, unconditional
		// "send regardless of any agent's liveness" instruction via
		// `specContent` (threaded through `spawnDriveAgent` ->
		// `spawnHeadlessSession` -> `buildInitialHeadlessPrompt`'s
		// "AUTHORITATIVE" section), superseding the reviewer agent-def's own
		// advisory "send to parent" prose.
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const topAgentName = "builder-seed-reviewer-prompt";

		let capturedReviewerStdin = "";
		let topStateAtReviewSpawn: string | undefined;
		let reviewerSpawnCount = 0;

		const _spawnFn: TurnSpawnFn = (_cmd, spawnOpts) => {
			const agentName = spawnOpts.env.OVERSTORY_AGENT_NAME ?? "unknown";
			const worktreePath = spawnOpts.cwd;
			const fake = makeFakeProc();
			const sessionId = `sess-${agentName}`;

			if (agentName.startsWith("reviewer-")) {
				reviewerSpawnCount += 1;

				// Confirm the live-spike scenario: the top/builder session is
				// already terminated ("completed") by the moment the reviewer's
				// first turn is dispatched.
				const { store } = openSessionStore(overstoryDir);
				try {
					topStateAtReviewSpawn = store.getByName(topAgentName)?.state;
				} finally {
					store.close();
				}

				// Capture the exact stream-json envelope `runTurn` writes to this
				// reviewer's stdin for its first turn -- this IS the reviewer's
				// initial prompt (`userTurnNdjson`, built from `specContent` +
				// the auto-dispatch mail + the beacon).
				fake.stdin.write = (data: string | Uint8Array): number => {
					capturedReviewerStdin += typeof data === "string" ? data : new TextDecoder().decode(data);
					return 0;
				};

				sendTerminalMailSync(overstoryDir, agentName, "Worker done: review — PASS", "worker_done");
				emitFakeTurn(fake, { sessionId });
				fake._exit(0);
				return fake;
			}

			// Top ("builder") agent: commit + send terminal mail, exactly like
			// `makeFakeSpawn`'s default builder branch.
			commitFileChangeSync(worktreePath, agentName);
			sendTerminalMailSync(overstoryDir, agentName, `Worker done: ${agentName}`);
			emitFakeTurn(fake, { sessionId });
			fake._exit(0);
			return fake;
		};

		const result = await driveCommand(
			"seed-reviewer-prompt",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		expect(reviewerSpawnCount).toBe(1);
		expect(topStateAtReviewSpawn).toBe("completed");

		// The reviewer's own persisted PASS verdict was captured and the run
		// reached 'merged' -- not 'failed' the way a dropped/unsent verdict
		// mail would have produced pre-fix.
		expect(result.outcome).toBe("merged");
		expect(result.mergedBranch).toBeTruthy();
		expect(closedIds).toContain("seed-reviewer-prompt");

		// The reviewer's initial prompt carries the NEW review-specific
		// AUTHORITATIVE section -- proof this is a review-specific brief, not
		// just the generic seed/dispatch mail + beacon a reviewer got pre-fix.
		expect(capturedReviewerStdin).toContain(
			"## Task Specification (AUTHORITATIVE — follow exactly; deviations are bugs)",
		);
		expect(capturedReviewerStdin).toContain("You are REVIEWING already-completed work");
		expect(capturedReviewerStdin).toContain("SEND THIS MAIL UNCONDITIONALLY");
	});

	test("review FAIL -> outcome 'review_failed', nothing merged, seed left open", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir, reviewVerdict: "FAIL" });

		const result = await driveCommand("seed-2", { capability: "builder" }, { _spawnFn, tracker });

		expect(result.outcome).toBe("review_failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(result.seedStatus).toBe("open");
		expect(closedIds).toEqual([]);
		expect(await Bun.file(join(tempDir, "drive-output.txt")).exists()).toBe(false);
	});

	test("--no-merge -> outcome 'no_op' after a passing review, branch left unmerged", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const result = await driveCommand(
			"seed-3",
			{ capability: "builder", merge: false },
			{ _spawnFn, tracker },
		);

		expect(result.outcome).toBe("no_op");
		expect(result.mergedBranch).toBeUndefined();
		expect(result.seedStatus).toBe("open");
		expect(closedIds).toEqual([]);
		expect(await Bun.file(join(tempDir, "drive-output.txt")).exists()).toBe(false);
	});

	test("merge dry-run predicts a tier above auto -> outcome 'merge_blocked'", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const blockedMergeFn = async (
			branch: string,
			_mergeOpts?: { dryRun?: boolean; into?: string },
		): Promise<MergeBranchResult> => {
			return {
				outcome: "noop",
				branch,
				tier: "ai-resolve",
				entry: {
					branchName: branch,
					taskId: "seed-4",
					agentName: "builder-seed-4",
					filesModified: ["drive-output.txt"],
					enqueuedAt: new Date().toISOString(),
					status: "pending",
					resolvedTier: null,
				},
				prediction: {
					predictedTier: "ai-resolve",
					conflictFiles: ["drive-output.txt"],
					wouldRequireAgent: true,
					reason: "forced-for-test",
				},
			};
		};

		const result = await driveCommand(
			"seed-4",
			{ capability: "builder" },
			{ _spawnFn, tracker, mergeBranchFn: blockedMergeFn },
		);

		expect(result.outcome).toBe("merge_blocked");
		expect(result.mergedBranch).toBeUndefined();
		expect(result.seedStatus).toBe("open");
		expect(closedIds).toEqual([]);
	});

	test("tracker.show throws (task not found) -> outcome 'failed', no agent spawned", async () => {
		const { tracker } = makeFakeTracker({
			show: async (id: string) => {
				throw new Error(`no such task: ${id}`);
			},
		});

		const result = await driveCommand("seed-missing", { capability: "builder" }, { tracker });

		expect(result.outcome).toBe("failed");
		expect(result.agents).toEqual([]);
		// CRITICAL-1: seed status is always read fresh from the tracker at the
		// single finish() exit point rather than assumed -- a tracker that
		// can't even be read resolves to "unknown", never a hardcoded "open".
		expect(result.seedStatus).toBe("unknown");
	});

	test("top agent never reaches terminal -> no-progress breaker trips", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir, builderTerminal: false });

		const result = await driveCommand("seed-5", { capability: "builder" }, { _spawnFn, tracker });

		expect(result.outcome).toBe("breaker");
		expect(result.breaker?.kind).toBe("no-progress");
		expect(result.breaker?.limit).toBe(3);
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});

	test("CRITICAL-1: seed already closed by the builder before the reviewer is spawned -> still reaches 'merged'", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, statusById } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({
			overstoryDir,
			// Simulates a real builder/lead's own completion protocol: it closes
			// its seed task itself, BEFORE sending terminal mail -- well before
			// `ov drive` ever gets to spawning a reviewer against it.
			onBuilderCommit: () => statusById.set("seed-critical1", "closed"),
		});

		const result = await driveCommand(
			"seed-critical1",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		// Pre-fix, spawnDriveAgent's workability check on the (now-closed) seed
		// task would reject the reviewer spawn and the run would report
		// "failed" here instead.
		expect(result.outcome).toBe("merged");
		expect(result.mergedBranch).toBeTruthy();
		expect(result.seedStatus).toBe("closed");
	});

	test("HIGH-2: --max-turns counts the seed's own first turn -- reviewer is never spawned once the budget is exhausted", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const result = await driveCommand(
			"seed-budget",
			{ capability: "builder", maxTurns: "1" },
			{ _spawnFn, tracker },
		);

		// The seed completes cleanly in exactly its own first turn (quiescent
		// immediately, no main-loop breaker) -- proving the budget is exhausted
		// specifically by the reviewer's pre-spawn check counting that turn,
		// not by the sweep engine's own turnsRemaining=0 short-circuit.
		expect(result.outcome).toBe("breaker");
		expect(result.breaker?.kind).toBe("max-turns");
		expect(result.breaker?.limit).toBe(1);
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});

	test("HIGH-2: timeout is checked before the seed's own first turn is ever spawned", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const BASE = 1_700_000_000_000;
		let calls = 0;
		const now = () => {
			calls++;
			// First call establishes the deadline (nowAtStart); every call after
			// that (the pre-spawn breaker check, sweep-engine checks, ...) sees
			// a clock far past that deadline -- deterministically proving the
			// deadline is checked BEFORE the first turn is spawned, not only
			// after some turn eventually yields.
			return calls === 1 ? BASE : BASE + 999_999_000;
		};

		const result = await driveCommand(
			"seed-timeout",
			{ capability: "builder", timeout: "1" },
			{ _spawnFn, tracker, now },
		);

		expect(result.outcome).toBe("breaker");
		expect(result.breaker?.kind).toBe("timeout");
		expect(result.breaker?.limit).toBe(1);
		expect(closedIds).toEqual([]);
		// The seed was never even spawned.
		expect(await Bun.file(join(tempDir, "drive-output.txt")).exists()).toBe(false);
	});

	test("finding D: a hung top agent aborted at the real wall-clock deadline -> outcome 'breaker' (timeout), not 'failed'", async () => {
		const { tracker, closedIds } = makeFakeTracker();

		// A genuinely hung fake process for the top ("builder") agent: never
		// pushes any stream-json line, never exits on its own. The only thing
		// that ends it is the REAL `AbortController` this driver arms at its
		// wall-clock `--timeout`, which sends SIGTERM -> the fake proc's
		// kill() immediately closes its stream and resolves `exited`.
		//
		// Pre-fix, `turn-runner.ts` zombies this session on abort
		// (`aborted -> finalState = "zombie"`), and `runSweepEngine`'s
		// `isDone()` (zero LIVE agents) short-circuited BEFORE the breaker
		// check ever ran -- reporting a clean, breaker-free quiescent exit
		// that masked the real timeout. Post-fix, the zombie state right
		// after the seed's own first turn is disambiguated via
		// `checkBreakerNow()`.
		const hungSpawnFn: TurnSpawnFn = (_cmd, spawnOpts) => {
			const agentName = spawnOpts.env.OVERSTORY_AGENT_NAME ?? "unknown";
			// Unreachable in this test -- the run never gets past the seed --
			// but kept realistic in case a future refactor changes ordering.
			if (agentName.startsWith("reviewer-")) {
				const fake = makeFakeProc();
				emitFakeTurn(fake, { sessionId: `sess-${agentName}` });
				fake._exit(0);
				return fake;
			}
			return makeFakeProc(); // hangs forever: no _pushLine, no _exit
		};

		const result = await driveCommand(
			"seed-hung",
			{ capability: "builder", timeout: "1" },
			{ _spawnFn: hungSpawnFn, tracker },
		);

		expect(result.outcome).toBe("breaker");
		expect(result.breaker?.kind).toBe("timeout");
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	}, 15000);

	test("finding 4: a stall-aborted zombie on the last permitted turn -> outcome 'failed', not 'breaker' (turnsUsed==maxTurns is not evidence of what caused the zombie)", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();

		// The seed's OWN first turn: emits one non-terminal event (no commit, no
		// terminal mail) so it settles to a LIVE "between_turns" state, then --
		// as a side effect of this same synchronous turn, plants an unread
		// "status" message addressed to itself. That mail is what lets the main
		// sweep loop's SECOND dispatch for this same agent actually fire
		// (`dispatchUnreadOnce` only drives a turn when unread mail exists).
		const seedSpawnFn: TurnSpawnFn = (_cmd, spawnOpts) => {
			const agentName = spawnOpts.env.OVERSTORY_AGENT_NAME ?? "unknown";
			const fake = makeFakeProc();
			const plantMailStore = createMailStore(join(overstoryDir, "mail.db"));
			try {
				createMailClient(plantMailStore).send({
					from: "operator",
					to: agentName,
					subject: "keep going",
					body: "there is more to do",
					type: "status",
					priority: "normal",
				});
			} finally {
				plantMailStore.close();
			}
			// `isError: true` matters: a clean (`isError: false`) result with no
			// terminal mail sent is itself treated as an implicit "completed"
			// (contract-violation fallback, see turn-runner's `terminalMailMissing`
			// branch) -- NOT a live state. An error result keeps `cleanResult`
			// false so the turn instead settles to the live "between_turns" state
			// (matches `makeFakeSpawn`'s `builderTerminal: false` path).
			emitFakeTurn(fake, { sessionId: `sess-${agentName}`, isError: true });
			fake._exit(0);
			return fake;
		};

		// The SECOND turn for this same agent (driven by the main sweep loop's
		// `dispatchOnce` -> `dispatchUnreadOnce` -> `runTurnFn`, NOT by
		// `spawnDriveAgent`'s hardcoded seed path) is intercepted here instead
		// of going through the real turn-runner. This simulates turn-runner's
		// OWN internal event-stall watchdog (`eventStallTimeoutMs`, default
		// 600_000ms) killing the turn -- completely independent of `ov drive`'s
		// own `AbortController`/wall-clock deadline, which this test's generous
		// default `--timeout` never comes close to. Sets the session to
		// "zombie" directly, mirroring the real runTurn's persisted side
		// effect for an aborted/stalled turn.
		let mockRunTurnCalls = 0;
		const runTurnFn: TurnRunnerFn = async (opts) => {
			mockRunTurnCalls++;
			const { store } = openSessionStore(opts.overstoryDir);
			try {
				const session = store.getByName(opts.agentName);
				if (!session) throw new Error("session missing for finding-4 runTurnFn mock");
				store.upsert({ ...session, state: "zombie" });
			} finally {
				store.close();
			}
			return {
				exitCode: null,
				cleanResult: false,
				newSessionId: null,
				resumeMismatch: false,
				terminalMailObserved: false,
				durationMs: 1,
				initialState: "between_turns",
				finalState: "zombie",
				stallAborted: true,
				terminalMailMissing: false,
			};
		};

		// `--max-turns 2`: the seed's own first turn (1) plus this one stalled
		// second turn (2) makes `turnsUsed === maxTurns` exactly when
		// `topSessionAfterMain.state === "zombie"` is evaluated -- the precise
		// coincidence finding 4 covers. Pre-fix, the combined breaker check
		// would misattribute this to `max-turns` purely because the budget
		// counter happened to match, even though the budget never prevented or
		// killed anything -- the turn died from an unrelated internal cause.
		const result = await driveCommand(
			"seed-stall4",
			{ capability: "builder", maxTurns: "2" },
			{ _spawnFn: seedSpawnFn, runTurnFn, tracker },
		);

		// Confirms the mocked runTurnFn (the stall-zombie site) is actually what
		// fired -- not some other, coincidental "failed" path.
		expect(mockRunTurnCalls).toBe(1);
		expect(result.outcome).toBe("failed");
		expect(result.breaker).toBeUndefined();
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});

	test("HIGH-3: a live child session blocks quiescence -- run does not reconcile/merge while it is still working", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const topAgentName = "builder-seed-quiescence";

		const _spawnFn = makeFakeSpawn({
			overstoryDir,
			onBuilderCommit: () => {
				const { store } = openSessionStore(overstoryDir);
				try {
					const top = store.getByName(topAgentName);
					if (!top) throw new Error("top agent session missing for quiescence hook");
					// A sibling agent that is spawned but never given any mail to
					// respond to -- it never reaches a terminal state on its own.
					store.upsert({
						id: "session-fake-child",
						agentName: "fake-child-1",
						capability: "builder",
						worktreePath: top.worktreePath,
						branchName: "fake-child-branch",
						taskId: top.taskId,
						tmuxSession: "",
						state: "working",
						pid: null,
						parentAgent: top.agentName,
						depth: top.depth + 1,
						runId: top.runId,
						startedAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
						escalationLevel: 0,
						stalledSince: null,
						transcriptPath: null,
					});
				} finally {
					store.close();
				}
			},
		});

		const result = await driveCommand(
			"seed-quiescence",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		// Pre-fix, isDone only checked the top agent -- reconcile/review/merge
		// would proceed even with the child still "working". Post-fix, the main
		// sweep loop requires TRUE quiescence (zero live agents in the run), so
		// the never-progressing child trips the no-progress breaker instead.
		expect(result.outcome).toBe("breaker");
		expect(result.breaker?.kind).toBe("no-progress");
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});

	test("finding F: a non-headless/legacy descendant (non-task-scoped capability) fails the run fast, not silently forever", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const topAgentName = "builder-seed-nonheadless";

		const _spawnFn = makeFakeSpawn({
			overstoryDir,
			onBuilderCommit: () => {
				const { store } = openSessionStore(overstoryDir);
				try {
					const top = store.getByName(topAgentName);
					if (!top) throw new Error("top agent session missing for non-headless hook");
					// A live descendant this driver has no mechanism to supervise:
					// a non-task-scoped capability ("coordinator" -- see
					// `isTaskScopedCapability`), standing in for a tmux-mode/legacy
					// session that would otherwise never reach a terminal state
					// under `ov drive`'s spawn-per-turn dispatch.
					store.upsert({
						id: "session-fake-nonheadless",
						agentName: "fake-nonheadless-1",
						capability: "coordinator",
						worktreePath: top.worktreePath,
						branchName: "fake-nonheadless-branch",
						taskId: top.taskId,
						tmuxSession: "",
						state: "working",
						pid: null,
						parentAgent: top.agentName,
						depth: top.depth + 1,
						runId: top.runId,
						startedAt: new Date().toISOString(),
						lastActivity: new Date().toISOString(),
						escalationLevel: 0,
						stalledSince: null,
						transcriptPath: null,
					});
				} finally {
					store.close();
				}
			},
		});

		const result = await driveCommand(
			"seed-nonheadless",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		// Pre-fix, `dispatchOnce` silently returned `{ drove: false }` for a
		// session `isSpawnPerTurnAgent` rejects -- this descendant would sit
		// "working" forever, either hanging the run to its breaker with no
		// diagnosis, or (worse) getting excluded from "live" entirely and
		// masking a still-working session as a clean quiescent exit. Post-fix,
		// `dispatchOnce` throws immediately and the whole run fails fast and
		// loud instead.
		expect(result.outcome).toBe("failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});

	test("HIGH-3: builder branch advances between review and merge -- merge is refused, raced commit not merged", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker } = makeFakeTracker();
		const topAgentName = "builder-seed-race";

		const _spawnFn = makeFakeSpawn({
			overstoryDir,
			onReviewerSpawn: () => {
				const { store } = openSessionStore(overstoryDir);
				try {
					const top = store.getByName(topAgentName);
					if (!top) throw new Error("top agent session missing for race hook");
					raceCommitOntoBranch(top.worktreePath);
				} finally {
					store.close();
				}
			},
		});

		const result = await driveCommand(
			"seed-race",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		// Pre-fix, ov drive would review one snapshot and then merge whatever
		// the branch tip happened to be at merge time -- silently landing the
		// raced-in, never-reviewed commit. Post-fix, the sha mismatch is
		// detected immediately before the real merge and the whole merge is
		// refused.
		expect(result.outcome).toBe("failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(await Bun.file(join(tempDir, "raced-file.txt")).exists()).toBe(false);
		expect(await Bun.file(join(tempDir, "drive-output.txt")).exists()).toBe(false);
	});

	test("HIGH-4: a stale prior-run PASS mail predating the review baseline is not selected -> outcome 'failed'", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker } = makeFakeTracker();

		// Pre-seed mail.db with a PASS mail from the EXACT reviewer name this
		// run will end up using, with a created_at forced unambiguously into
		// the past (a fast synchronous test could otherwise collide at
		// millisecond resolution with the real baseline captured moments
		// later).
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		let staleId: string;
		try {
			staleId = createMailClient(mailStore).send({
				from: "reviewer-seed-stale",
				to: "reviewer-seed-stale",
				subject: "Worker done: review — PASS",
				body: "stale prior-run verdict",
				type: "worker_done",
				priority: "normal",
			});
		} finally {
			mailStore.close();
		}
		const rawDb = new Database(join(overstoryDir, "mail.db"));
		try {
			rawDb.run("UPDATE messages SET created_at = ? WHERE id = ?", [
				new Date(0).toISOString(),
				staleId,
			]);
		} finally {
			rawDb.close();
		}

		// This run's OWN reviewer sends no terminal mail at all.
		const _spawnFn = makeFakeSpawn({ overstoryDir, reviewVerdict: "none" });

		const result = await driveCommand(
			"seed-stale",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		// Pre-fix, the stale PASS mail (matching reviewer name, matching
		// token, queried with no time boundary) would have been selected and
		// the run would have merged off a verdict from a different run.
		expect(result.outcome).toBe("failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(await Bun.file(join(tempDir, "drive-output.txt")).exists()).toBe(false);
	});

	test("finding B: a stale PASS mail forged with a FUTURE timestamp is still excluded -- selection is rowid-gated, not wall-clock-gated", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();

		// Pre-seed mail.db with a PASS mail from the EXACT reviewer name this
		// run will end up using, BEFORE the run starts (so its rowid predates
		// the pre-spawn snapshot) -- then forge its created_at far into the
		// FUTURE. A naive `createdAt >= baseline` freshness check (HIGH-4's
		// original fix) would wrongly treat this as fresher than -- or at
		// least eligible alongside -- this run's own real verdict mail. Only
		// a rowid-based (strict insertion-order) check correctly excludes it
		// regardless of its forged timestamp.
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		let staleId: string;
		try {
			staleId = createMailClient(mailStore).send({
				from: "reviewer-seed-rowid-race",
				to: "reviewer-seed-rowid-race",
				subject: "Worker done: review — PASS",
				body: "stale prior-run verdict, timestamp forged into the future",
				type: "worker_done",
				priority: "normal",
			});
		} finally {
			mailStore.close();
		}
		const rawDb = new Database(join(overstoryDir, "mail.db"));
		try {
			rawDb.run("UPDATE messages SET created_at = ? WHERE id = ?", [
				new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
				staleId,
			]);
		} finally {
			rawDb.close();
		}

		// This run's OWN reviewer sends an explicit FAIL.
		const _spawnFn = makeFakeSpawn({ overstoryDir, reviewVerdict: "FAIL" });

		const result = await driveCommand(
			"seed-rowid-race",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		// Pre-fix (a `createdAt >= baseline` freshness check with no
		// insertion-order guarantee), the forged-future stale PASS could win
		// out over this run's real FAIL and the run could wrongly merge.
		// Post-fix, only mail whose rowid is strictly after the pre-spawn
		// snapshot -- i.e. actually inserted by THIS run's reviewer -- is
		// ever considered, so the real FAIL wins deterministically.
		expect(result.outcome).toBe("review_failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});

	test("HIGH-4 / MEDIUM-7: reviewer completes with no terminal verdict mail -> outcome 'failed', not 'review_failed'", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir, reviewVerdict: "none" });

		const result = await driveCommand(
			"seed-noverdict",
			{ capability: "builder" },
			{ _spawnFn, tracker },
		);

		expect(result.outcome).toBe("failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});

	test("HIGH-5: an unexpected throw from mergeBranchFn still finalizes the run -- no live session rows survive", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const throwingMergeFn = async (): Promise<MergeBranchResult> => {
			throw new Error("simulated merge-queue outage");
		};

		const result = await driveCommand(
			"seed-throw",
			{ capability: "builder" },
			{ _spawnFn, tracker, mergeBranchFn: throwingMergeFn },
		);

		expect(result.outcome).toBe("failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);

		const { store } = openSessionStore(overstoryDir);
		try {
			const sessions = store.getByRun(result.runId);
			expect(sessions.length).toBeGreaterThan(0);
			for (const s of sessions) {
				expect(["completed", "zombie"]).toContain(s.state);
			}
		} finally {
			store.close();
		}

		const metricsStore = createMetricsStore(join(overstoryDir, "metrics.db"));
		try {
			const rows = metricsStore.getSessionsByRun(result.runId);
			expect(rows.length).toBeGreaterThan(0);
		} finally {
			metricsStore.close();
		}
	});

	test("MEDIUM-7: a prediction-infrastructure failure ('prediction-failed:' reason) -> outcome 'failed', not 'merge_blocked'", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker, closedIds } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const outageMergeFn = async (branch: string): Promise<MergeBranchResult> => {
			return {
				outcome: "noop",
				branch,
				tier: "ai-resolve",
				entry: {
					branchName: branch,
					taskId: "seed-outage",
					agentName: "builder-seed-outage",
					filesModified: [],
					enqueuedAt: new Date().toISOString(),
					status: "pending",
					resolvedTier: null,
				},
				prediction: {
					predictedTier: "ai-resolve",
					conflictFiles: [],
					wouldRequireAgent: true,
					reason: "prediction-failed: mulch client outage (simulated)",
				},
			};
		};

		const result = await driveCommand(
			"seed-outage",
			{ capability: "builder" },
			{ _spawnFn, tracker, mergeBranchFn: outageMergeFn },
		);

		// A genuinely predicted conflict (see "merge dry-run predicts a tier
		// above auto" above) still maps to "merge_blocked" -- only a
		// prediction-INFRASTRUCTURE failure is reclassified here.
		expect(result.outcome).toBe("failed");
		expect(result.mergedBranch).toBeUndefined();
		expect(closedIds).toEqual([]);
	});
});

// Sanity: confirm the merged branch's commit is actually reachable from the
// canonical branch's history (not just that the file materialized in the
// working tree, which a merge, cherry-pick, OR a stray un-merged commit on
// main could also produce).
describe("driveCommand merge lands on canonical branch history", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		await initCommand({ _spawner: noopSpawner });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("the builder branch is an ancestor of (or equal to) canonical HEAD after a merge", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const { tracker } = makeFakeTracker();
		const _spawnFn = makeFakeSpawn({ overstoryDir });

		const result = await driveCommand("seed-6", { capability: "builder" }, { _spawnFn, tracker });
		expect(result.outcome).toBe("merged");
		const branch = result.mergedBranch;
		expect(branch).toBeTruthy();
		if (!branch) throw new Error("unreachable: asserted above");

		// git merge-base --is-ancestor <branch> HEAD exits 0 iff branch is an
		// ancestor of (or equal to) the current HEAD (canonical checkout, main).
		await runGitInDir(tempDir, ["merge-base", "--is-ancestor", branch, "HEAD"]);
	});
});
