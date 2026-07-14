import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { ClaudeRuntime } from "../runtimes/claude.ts";
import type { AgentRuntime, DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore, type SessionStore } from "../sessions/store.ts";
import type { AgentSession, ResolvedModel } from "../types.ts";
import { spawnHeadlessSession } from "./headless-session.ts";
import type { TurnSpawnFn, TurnSubprocess } from "./turn-runner.ts";

// ---------- fake subprocess plumbing (mirrors turn-runner.test.ts) ----------

interface FakeProc extends TurnSubprocess {
	_pushLine(line: string): void;
	_exit(code: number | null): void;
}

let fakeProcCounter = 5000;

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

function makeSpyRuntime(): { runtime: AgentRuntime; spawnCalls: DirectSpawnOpts[] } {
	const calls: DirectSpawnOpts[] = [];
	const base = new ClaudeRuntime();
	const original = base.buildDirectSpawn?.bind(base);
	if (original) {
		(base as unknown as { buildDirectSpawn: typeof original }).buildDirectSpawn = (
			opts: DirectSpawnOpts,
		) => {
			calls.push({ ...opts });
			return original(opts);
		};
	}
	return { runtime: base, spawnCalls: calls };
}

// ---------- test suite ----------

const RESOLVED_MODEL: ResolvedModel = { model: "sonnet", env: {}, isExplicitOverride: false };

describe("spawnHeadlessSession", () => {
	let overstoryDir: string;
	let worktreePath: string;
	let projectRoot: string;
	let sessionsDbPath: string;
	let store: SessionStore;

	beforeEach(async () => {
		overstoryDir = await mkdtemp(join(tmpdir(), "overstory-headless-session-test-"));
		worktreePath = overstoryDir;
		projectRoot = overstoryDir;
		sessionsDbPath = join(overstoryDir, "sessions.db");
		store = createSessionStore(sessionsDbPath);
	});

	afterEach(async () => {
		store.close();
		await rm(overstoryDir, { recursive: true, force: true });
	});

	test("drives the first turn and returns agentName/branchName/worktreePath/runId/firstTurn", async () => {
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "hs-session" });
			fake._exit(0);
			return fake;
		};

		const result = await spawnHeadlessSession({
			agentName: "hs-agent",
			capability: "builder",
			taskId: "task-hs",
			overstoryDir,
			worktreePath,
			projectRoot,
			branchName: "overstory/builder/task-hs",
			parentAgent: null,
			depth: 0,
			runtime,
			resolvedModel: RESOLVED_MODEL,
			runId: "run-explicit-1",
			store,
			existingSession: null,
			_spawnFn: spawnFn,
		});

		expect(result.agentName).toBe("hs-agent");
		expect(result.branchName).toBe("overstory/builder/task-hs");
		expect(result.worktreePath).toBe(worktreePath);
		expect(result.runId).toBe("run-explicit-1");
		expect(result.firstTurn.newSessionId).toBe("hs-session");
		expect(result.firstTurn.cleanResult).toBe(true);

		// Session was upserted with the explicit runId — no current-run.txt fallback.
		const persisted = store.getByName("hs-agent");
		expect(persisted?.runId).toBe("run-explicit-1");
	});

	test("uses the explicit runId and never touches current-run.txt", async () => {
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "hs-session-2" });
			fake._exit(0);
			return fake;
		};

		// No current-run.txt exists in overstoryDir at all — if this service
		// tried to read it, it would find nothing and the explicit runId would
		// still have to win for this assertion to pass either way, so also
		// assert the file was never created as a side effect.
		await spawnHeadlessSession({
			agentName: "hs-agent-2",
			capability: "builder",
			taskId: "task-hs-2",
			overstoryDir,
			worktreePath,
			projectRoot,
			branchName: "overstory/builder/task-hs-2",
			parentAgent: null,
			depth: 0,
			runtime,
			resolvedModel: RESOLVED_MODEL,
			runId: "run-explicit-2",
			store,
			existingSession: null,
			_spawnFn: spawnFn,
		});

		const currentRunFile = Bun.file(join(overstoryDir, "current-run.txt"));
		expect(await currentRunFile.exists()).toBe(false);
	});

	test("carries the prior claudeSessionId forward on re-spawn", async () => {
		const { runtime, spawnCalls } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "hs-resumed-session" });
			fake._exit(0);
			return fake;
		};

		const existingSession: AgentSession = {
			id: "session-prior",
			agentName: "hs-respawn",
			capability: "builder",
			worktreePath,
			branchName: "overstory/builder/task-hs-3",
			taskId: "task-hs-3",
			tmuxSession: "",
			state: "zombie",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: "run-old",
			startedAt: new Date(0).toISOString(),
			lastActivity: new Date(0).toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
			claudeSessionId: "prior-claude-session-id",
		};

		await spawnHeadlessSession({
			agentName: "hs-respawn",
			capability: "builder",
			taskId: "task-hs-3",
			overstoryDir,
			worktreePath,
			projectRoot,
			branchName: "overstory/builder/task-hs-3",
			parentAgent: null,
			depth: 0,
			runtime,
			resolvedModel: RESOLVED_MODEL,
			runId: "run-explicit-3",
			store,
			existingSession,
			_spawnFn: spawnFn,
		});

		// spawnHeadlessSession upserts the row with the prior claudeSessionId
		// BEFORE driving the turn; runTurn re-reads the store under its lock and
		// uses that value as the resume target for the spawn (turn-runner.ts
		// re-read-under-lock + `resumeSessionId: priorSessionId`). Asserting the
		// captured spawn opts proves the linkage was actually carried through,
		// rather than just checking the post-turn row (which runTurn legitimately
		// overwrites with the NEW session id once the turn completes).
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.resumeSessionId).toBe("prior-claude-session-id");

		const persisted = store.getByName("hs-respawn");
		expect(persisted?.runId).toBe("run-explicit-3");
	});

	test("wraps a preflightDirectSpawn failure in AgentError and never calls runTurn", async () => {
		const { runtime } = makeSpyRuntime();
		(runtime as { preflightDirectSpawn?: () => Promise<void> }).preflightDirectSpawn = async () => {
			throw new Error("proxy unreachable");
		};

		let spawnFnCalled = false;
		const spawnFn: TurnSpawnFn = () => {
			spawnFnCalled = true;
			const fake = makeFakeProc();
			fake._exit(0);
			return fake;
		};

		await expect(
			spawnHeadlessSession({
				agentName: "hs-preflight-fail",
				capability: "builder",
				taskId: "task-hs-4",
				overstoryDir,
				worktreePath,
				projectRoot,
				branchName: "overstory/builder/task-hs-4",
				parentAgent: null,
				depth: 0,
				runtime,
				resolvedModel: RESOLVED_MODEL,
				runId: "run-explicit-4",
				store,
				existingSession: null,
				_spawnFn: spawnFn,
			}),
		).rejects.toBeInstanceOf(AgentError);

		expect(spawnFnCalled).toBe(false);
		// No session row should have been upserted — the spawn never happened.
		expect(store.getByName("hs-preflight-fail")).toBeNull();
	});
});
