import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { MailMessage } from "../types.ts";
import {
	_runPersistentMailTick,
	_runTurnRunnerTick,
	dispatchUnreadOnce,
	formatMailBatch,
	startPersistentMailLoop,
	startTurnRunnerMailLoop,
	type TurnRunnerOptsFactory,
} from "./headless-mail-injector.ts";
import type { RunTurnOpts, TurnResult } from "./turn-runner.ts";

describe("formatMailBatch", () => {
	function makeMessage(overrides: Partial<MailMessage>): MailMessage {
		return {
			id: "m-1",
			from: "lead",
			to: "build-agent",
			subject: "Subject",
			body: "Body",
			type: "dispatch",
			priority: "normal",
			threadId: null,
			payload: null,
			read: false,
			createdAt: "2026-04-30T00:00:00.000Z",
			...overrides,
		};
	}

	test("escapes pipes in metadata so a crafted subject can't inject a fake field", () => {
		const text = formatMailBatch([makeMessage({ subject: "Real | Priority: urgent" })]);
		expect(text).toBe(
			"[MAIL] From: lead | Subject: Real \\| Priority: urgent | Priority: normal\n\nBody",
		);
	});

	test("escapes newlines in metadata so a crafted subject can't smuggle a fake body", () => {
		const text = formatMailBatch([makeMessage({ subject: "line1\nINJECTED BODY" })]);
		// First \n\n must come *after* the metadata, not be introduced by the subject.
		const firstSep = text.indexOf("\n\n");
		const metaLine = text.slice(0, firstSep);
		expect(metaLine).toContain("Subject: line1\\nINJECTED BODY");
		expect(metaLine).not.toContain("\n");
		expect(text.slice(firstSep + 2)).toBe("Body");
	});

	test("escapes carriage returns and backslashes in metadata", () => {
		const text = formatMailBatch([makeMessage({ from: "a\\b", subject: "c\rd" })]);
		expect(text).toContain("From: a\\\\b");
		expect(text).toContain("Subject: c\\rd");
	});

	test("does not modify body content", () => {
		const text = formatMailBatch([
			makeMessage({ body: "Body with | pipes\nand newlines\nand \\ backslashes" }),
		]);
		expect(text.endsWith("Body with | pipes\nand newlines\nand \\ backslashes")).toBe(true);
	});

	test("preserves benign metadata exactly", () => {
		const text = formatMailBatch([
			makeMessage({ from: "lead", subject: "Plain subject", priority: "high" }),
		]);
		expect(text).toBe("[MAIL] From: lead | Subject: Plain subject | Priority: high\n\nBody");
	});
});

describe("startTurnRunnerMailLoop", () => {
	let tempDir: string;
	let mailDbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-turnrunner-test-"));
		mailDbPath = join(tempDir, "mail.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeRunTurnStub(result: Partial<TurnResult> = {}): {
		runTurn: (opts: RunTurnOpts) => Promise<TurnResult>;
		calls: RunTurnOpts[];
	} {
		const calls: RunTurnOpts[] = [];
		const filled: TurnResult = {
			exitCode: 0,
			cleanResult: true,
			newSessionId: null,
			resumeMismatch: false,
			terminalMailObserved: false,
			durationMs: 1,
			initialState: "booting",
			finalState: "working",
			stallAborted: false,
			terminalMailMissing: false,
			...result,
		};
		return {
			calls,
			runTurn: async (opts) => {
				calls.push(opts);
				return filled;
			},
		};
	}

	function fakeOptsFactory(agentName: string): TurnRunnerOptsFactory {
		return (userTurnNdjson: string): RunTurnOpts =>
			({
				agentName,
				capability: "builder",
				overstoryDir: tempDir,
				worktreePath: tempDir,
				projectRoot: tempDir,
				taskId: "task-x",
				userTurnNdjson,
				// `runtime` and `resolvedModel` are placeholders — the stub never calls them.
				runtime: { id: "claude" } as unknown as RunTurnOpts["runtime"],
				resolvedModel: { model: "test", isExplicitOverride: false },
				runId: null,
				mailDbPath,
				eventsDbPath: join(tempDir, "events.db"),
				sessionsDbPath: join(tempDir, "sessions.db"),
			}) satisfies RunTurnOpts;
	}

	test("invokes runTurn with batched user turn and marks messages read on success", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		const idA = client.send({
			from: "lead",
			to: "build-agent",
			subject: "Task A",
			body: "Work on A.",
			type: "dispatch",
			priority: "normal",
		});
		const idB = client.send({
			from: "lead",
			to: "build-agent",
			subject: "Task B",
			body: "Work on B.",
			type: "status",
			priority: "low",
		});
		store.close();

		const stub = makeRunTurnStub();
		const result = await _runTurnRunnerTick(
			"build-agent",
			fakeOptsFactory("build-agent"),
			stub.runTurn,
			mailDbPath,
		);
		expect(result.kind).toBe("delivered");
		expect(stub.calls.length).toBe(1);
		const opts = stub.calls[0];
		expect(opts).toBeDefined();
		const parsed = JSON.parse(opts?.userTurnNdjson?.trimEnd() ?? "");
		expect(parsed.type).toBe("user");
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("Task A");
		expect(text).toContain("Task B");

		// A delivered tick must carry the claimed batch's message ids —
		// callers correlate a dispatch back to the mail it delivered
		// (overstory ov-drive-completion Phase 1 Codex-fix: this used to be
		// hardcoded to `[]` after the dispatchUnreadOnce extraction).
		if (result.kind === "delivered") {
			expect(result.messageIds).toEqual([idA, idB]);
		}

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("build-agent").length).toBe(0);
		} finally {
			checkStore.close();
		}
	});

	test("does not mark messages read when runTurn exits non-zero", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "fail-agent",
			subject: "Try again",
			body: "Should not be marked read.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stub = makeRunTurnStub({ exitCode: 1, cleanResult: false });
		const result = await _runTurnRunnerTick(
			"fail-agent",
			fakeOptsFactory("fail-agent"),
			stub.runTurn,
			mailDbPath,
		);
		expect(result.kind).toBe("delivered");
		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("fail-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("does not mark messages read when runTurn throws", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		const throwId = client.send({
			from: "lead",
			to: "throw-agent",
			subject: "Boom",
			body: "Throw inside runTurn.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const result = await _runTurnRunnerTick(
			"throw-agent",
			fakeOptsFactory("throw-agent"),
			async () => {
				throw new Error("simulated spawn failure");
			},
			mailDbPath,
		);
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.error).toBeInstanceOf(Error);
			// An errored tick must still carry the claimed batch's message ids
			// so a failed dispatch can be correlated back to the mail that
			// triggered it (overstory ov-drive-completion Phase 1 Codex-fix:
			// this used to be hardcoded to `[]` after the dispatchUnreadOnce
			// extraction, losing failed-batch correlation).
			expect(result.messageIds).toEqual([throwId]);
		}

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("throw-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("idle tick when no unread mail does not invoke runTurn", async () => {
		const stub = makeRunTurnStub();
		const result = await _runTurnRunnerTick(
			"empty-agent",
			fakeOptsFactory("empty-agent"),
			stub.runTurn,
			mailDbPath,
		);
		expect(result.kind).toBe("idle");
		expect(stub.calls.length).toBe(0);
	});

	test("loop returns a stop function that prevents further runTurn invocations", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "loop-agent",
			subject: "Stop test",
			body: "Should be delivered once at most.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stub = makeRunTurnStub();
		const stop = startTurnRunnerMailLoop(
			"loop-agent",
			fakeOptsFactory("loop-agent"),
			stub.runTurn,
			mailDbPath,
			60,
		);

		await new Promise((r) => setTimeout(r, 250));
		stop();
		const callsAfterStop = stub.calls.length;
		await new Promise((r) => setTimeout(r, 200));

		expect(stub.calls.length).toBe(callsAfterStop);
		// Should have been invoked at most once (mark-read + idle on subsequent tick).
		expect(callsAfterStop).toBeLessThanOrEqual(1);
		expect(callsAfterStop).toBeGreaterThan(0);
	});

	test("per-tick isAgentLive=false short-circuits dispatch and self-stops the loop", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "stopped-agent",
			subject: "Late mail",
			body: "Should never be dispatched to a stopped agent.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		// Simulate the agent being marked completed before the first tick fires.
		// The per-tick guard must short-circuit dispatch — closing the rescan
		// window in serve.ts that allows ov stop to leak a fresh runTurn call
		// (overstory-eb7c).
		const stub = makeRunTurnStub();
		const stop = startTurnRunnerMailLoop(
			"stopped-agent",
			fakeOptsFactory("stopped-agent"),
			stub.runTurn,
			mailDbPath,
			30,
			() => false,
		);

		await new Promise((r) => setTimeout(r, 200));
		stop();

		expect(stub.calls.length).toBe(0);
		// Mail must remain unread because the loop never delivered it.
		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("stopped-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("isAgentLive flips to false mid-loop: no further runTurn invocations", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		// Two batches of mail. The first runTurn marks batch 1 read; before the
		// next tick fires we flip the agent to terminal, and a second batch of
		// mail arrives. The guard must prevent that second batch from
		// dispatching.
		client.send({
			from: "lead",
			to: "flipping-agent",
			subject: "Batch 1",
			body: "First batch.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		let live = true;
		const stub = makeRunTurnStub();
		const wrappedRunTurn = async (opts: RunTurnOpts): Promise<TurnResult> => {
			// After the first turn completes, simulate ov stop: agent flips to
			// completed and a new mail arrives that the rescan would see.
			const r = await stub.runTurn(opts);
			live = false;
			const s = createMailStore(mailDbPath);
			const c = createMailClient(s);
			c.send({
				from: "lead",
				to: "flipping-agent",
				subject: "Batch 2 (post-stop)",
				body: "Should not be dispatched.",
				type: "dispatch",
				priority: "normal",
			});
			s.close();
			return r;
		};

		const stop = startTurnRunnerMailLoop(
			"flipping-agent",
			fakeOptsFactory("flipping-agent"),
			wrappedRunTurn,
			mailDbPath,
			30,
			() => live,
		);

		await new Promise((r) => setTimeout(r, 300));
		stop();

		// Exactly one runTurn call: the first batch. Batch 2 must not have
		// reached the dispatcher.
		expect(stub.calls.length).toBe(1);
		const checkStore = createMailStore(mailDbPath);
		try {
			// Batch 1 marked read (delivered). Batch 2 still unread (never
			// dispatched).
			expect(checkStore.getUnread("flipping-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("re-entrancy guard: second tick while first is in flight is a no-op", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "concurrency-agent",
			subject: "First",
			body: "First batch",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		// Block the first runTurn until we explicitly resolve it. While in flight,
		// any subsequent tick must short-circuit (the loop's in-flight guard).
		let resolveFirst!: () => void;
		const firstPromise = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});

		let calls = 0;
		const slowRun = async (_opts: RunTurnOpts): Promise<TurnResult> => {
			calls++;
			await firstPromise;
			return {
				exitCode: 0,
				cleanResult: true,
				newSessionId: null,
				resumeMismatch: false,
				terminalMailObserved: false,
				durationMs: 0,
				initialState: "booting",
				finalState: "working",
				stallAborted: false,
				terminalMailMissing: false,
			};
		};

		const stop = startTurnRunnerMailLoop(
			"concurrency-agent",
			fakeOptsFactory("concurrency-agent"),
			slowRun,
			mailDbPath,
			30,
		);

		// Allow several ticks to fire while the first runTurn is still pending.
		await new Promise((r) => setTimeout(r, 150));
		expect(calls).toBe(1);

		resolveFirst();
		await new Promise((r) => setTimeout(r, 80));
		stop();

		// At most one extra retry tick after the first turn resolved (with the
		// only message already marked read). Allow ≤2 to keep the assertion
		// resilient to scheduler timing on slower CI runners.
		expect(calls).toBeLessThanOrEqual(2);
	});
});

describe("dispatchUnreadOnce", () => {
	let tempDir: string;
	let mailDbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-dispatch-once-test-"));
		mailDbPath = join(tempDir, "mail.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeRunTurnStub(result: Partial<TurnResult> = {}): {
		runTurn: (opts: RunTurnOpts) => Promise<TurnResult>;
		calls: RunTurnOpts[];
	} {
		const calls: RunTurnOpts[] = [];
		const filled: TurnResult = {
			exitCode: 0,
			cleanResult: true,
			newSessionId: null,
			resumeMismatch: false,
			terminalMailObserved: false,
			durationMs: 1,
			initialState: "booting",
			finalState: "working",
			stallAborted: false,
			terminalMailMissing: false,
			...result,
		};
		return {
			calls,
			runTurn: async (opts) => {
				calls.push(opts);
				return filled;
			},
		};
	}

	function fakeOptsFactory(agentName: string): TurnRunnerOptsFactory {
		return (userTurnNdjson: string): RunTurnOpts =>
			({
				agentName,
				capability: "builder",
				overstoryDir: tempDir,
				worktreePath: tempDir,
				projectRoot: tempDir,
				taskId: "task-x",
				userTurnNdjson,
				runtime: { id: "claude" } as unknown as RunTurnOpts["runtime"],
				resolvedModel: { model: "test", isExplicitOverride: false },
				runId: null,
				mailDbPath,
				eventsDbPath: join(tempDir, "events.db"),
				sessionsDbPath: join(tempDir, "sessions.db"),
			}) satisfies RunTurnOpts;
	}

	test("resolves { drove: false } and never invokes runTurnFn when there is no unread mail", async () => {
		const stub = makeRunTurnStub();

		const outcome = await dispatchUnreadOnce({
			agentName: "empty-agent",
			optsFactory: fakeOptsFactory("empty-agent"),
			runTurnFn: stub.runTurn,
			mailStorePath: mailDbPath,
		});

		expect(outcome.drove).toBe(false);
		expect(outcome.turnResult).toBeUndefined();
		expect(stub.calls.length).toBe(0);
	});

	test("drives one turn and marks mail read when runTurnFn exits 0", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		const messageId = client.send({
			from: "lead",
			to: "dispatch-agent",
			subject: "Task A",
			body: "Work on A.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stub = makeRunTurnStub({ exitCode: 0 });
		const outcome = await dispatchUnreadOnce({
			agentName: "dispatch-agent",
			optsFactory: fakeOptsFactory("dispatch-agent"),
			runTurnFn: stub.runTurn,
			mailStorePath: mailDbPath,
		});

		expect(outcome.drove).toBe(true);
		expect(outcome.turnResult?.exitCode).toBe(0);
		expect(outcome.messageIds).toEqual([messageId]);
		expect(stub.calls.length).toBe(1);

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("dispatch-agent").length).toBe(0);
		} finally {
			checkStore.close();
		}
	});

	test("leaves mail unread when runTurnFn exits non-zero", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "fail-agent",
			subject: "Try again",
			body: "Should not be marked read.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stub = makeRunTurnStub({ exitCode: 1, cleanResult: false });
		const outcome = await dispatchUnreadOnce({
			agentName: "fail-agent",
			optsFactory: fakeOptsFactory("fail-agent"),
			runTurnFn: stub.runTurn,
			mailStorePath: mailDbPath,
		});

		expect(outcome.drove).toBe(true);
		expect(outcome.turnResult?.exitCode).toBe(1);

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("fail-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("propagates a thrown error from runTurnFn uncaught, leaving mail unread", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "throw-agent",
			subject: "Boom",
			body: "Throw inside runTurn.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const rejecting = async (): Promise<TurnResult> => {
			throw new Error("simulated spawn failure");
		};

		await expect(
			dispatchUnreadOnce({
				agentName: "throw-agent",
				optsFactory: fakeOptsFactory("throw-agent"),
				runTurnFn: rejecting,
				mailStorePath: mailDbPath,
			}),
		).rejects.toThrow("simulated spawn failure");

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("throw-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});
});

describe("startPersistentMailLoop", () => {
	let tempDir: string;
	let mailDbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-persistent-mail-test-"));
		mailDbPath = join(tempDir, "mail.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeFakeConn(): {
		conn: { followUp(text: string): Promise<void> };
		writes: string[];
		failNext?: () => void;
	} {
		const writes: string[] = [];
		let nextFailure: Error | null = null;
		return {
			writes,
			conn: {
				async followUp(text: string): Promise<void> {
					if (nextFailure !== null) {
						const err = nextFailure;
						nextFailure = null;
						throw err;
					}
					writes.push(text);
				},
			},
			failNext: () => {
				nextFailure = new Error("simulated stdin write failure");
			},
		};
	}

	test("writes batched user turn to followUp and marks messages read", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead-1",
			to: "coordinator",
			subject: "merge_ready",
			body: "branch ready",
			type: "merge_ready",
			priority: "normal",
		});
		client.send({
			from: "operator",
			to: "coordinator",
			subject: "check in",
			body: "status please",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const fake = makeFakeConn();
		const result = await _runPersistentMailTick("coordinator", mailDbPath, {
			getConn: () => fake.conn,
		});

		expect(result.kind).toBe("delivered");
		expect(fake.writes.length).toBe(1);
		const ndjson = fake.writes[0]?.trimEnd() ?? "";
		const parsed = JSON.parse(ndjson);
		expect(parsed.type).toBe("user");
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("merge_ready");
		expect(text).toContain("check in");

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("coordinator").length).toBe(0);
		} finally {
			checkStore.close();
		}
	});

	test("idle when no unread mail: does not invoke followUp", async () => {
		const fake = makeFakeConn();
		const result = await _runPersistentMailTick("coordinator", mailDbPath, {
			getConn: () => fake.conn,
		});

		expect(result.kind).toBe("idle");
		expect(fake.writes.length).toBe(0);
	});

	test("no-connection short-circuits delivery (mail stays unread)", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "operator",
			to: "coordinator",
			subject: "hi",
			body: "x",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const result = await _runPersistentMailTick("coordinator", mailDbPath, {
			getConn: () => undefined,
		});

		expect(result.kind).toBe("no-connection");

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("coordinator").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("agent-stopped predicate short-circuits before reading mail", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "operator",
			to: "coordinator",
			subject: "hi",
			body: "x",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const fake = makeFakeConn();
		const result = await _runPersistentMailTick("coordinator", mailDbPath, {
			getConn: () => fake.conn,
			isAgentLive: () => false,
		});

		expect(result.kind).toBe("agent-stopped");
		expect(fake.writes.length).toBe(0);

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("coordinator").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("loop returns a stop function that prevents further followUp invocations", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "operator",
			to: "coordinator",
			subject: "first",
			body: "first body",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const fake = makeFakeConn();
		const stop = startPersistentMailLoop("coordinator", mailDbPath, {
			getConn: () => fake.conn,
			intervalMs: 30,
		});

		// Wait for a tick to fire and deliver
		await new Promise((r) => setTimeout(r, 100));
		stop();

		const writeCountBeforeNewMail = fake.writes.length;
		expect(writeCountBeforeNewMail).toBeGreaterThanOrEqual(1);

		// Send new mail after stop — must not be delivered
		const store2 = createMailStore(mailDbPath);
		const client2 = createMailClient(store2);
		client2.send({
			from: "operator",
			to: "coordinator",
			subject: "after-stop",
			body: "should not be delivered",
			type: "dispatch",
			priority: "normal",
		});
		store2.close();

		await new Promise((r) => setTimeout(r, 100));
		expect(fake.writes.length).toBe(writeCountBeforeNewMail);
	});

	test("isAgentLive=false self-stops the loop", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "operator",
			to: "coordinator",
			subject: "hi",
			body: "x",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const fake = makeFakeConn();
		let alive = true;
		const stop = startPersistentMailLoop("coordinator", mailDbPath, {
			getConn: () => fake.conn,
			isAgentLive: () => alive,
			intervalMs: 30,
		});

		alive = false;
		// Wait long enough for several ticks — none should deliver since
		// isAgentLive returns false on the very first tick.
		await new Promise((r) => setTimeout(r, 150));
		stop();

		expect(fake.writes.length).toBe(0);

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("coordinator").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("write failure leaves messages unread for retry", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "operator",
			to: "coordinator",
			subject: "retry-me",
			body: "x",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const fake = makeFakeConn();
		fake.failNext?.();

		const result = await _runPersistentMailTick("coordinator", mailDbPath, {
			getConn: () => fake.conn,
		});

		expect(result.kind).toBe("error");

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("coordinator").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});
});
