// Sapling runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `sp` CLI (Sapling headless coding agent).
//
// Key characteristics:
// - Headless: Sapling runs as a Bun subprocess (no tmux TUI)
// - Instruction file: SAPLING.md (auto-read from worktree root)
// - Communication: NDJSON event stream on stdout (--json)
// - Guards: .sapling/guards.json (written by deployConfig from guard-rules.ts constants)
// - Events: NDJSON stream on stdout (parsed for token usage and agent events)

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	DANGEROUS_BASH_PATTERNS,
	INTERACTIVE_TOOLS,
	NATIVE_TEAM_TOOLS,
} from "../agents/guard-rules.ts";
import type { ResolvedModel, SaplingRuntimeConfig } from "../types.ts";
import {
	assertLoopbackProxyUrl,
	ensureSaplingProxyRunning,
	resolveSaplingProxy,
	SAPLING_PROXY_DUMMY_KEY,
} from "./sapling-proxy.ts";
import type {
	AgentEvent,
	AgentRuntime,
	ConnectionState,
	DirectSpawnOpts,
	HooksDef,
	OverlayContent,
	ReadyState,
	RpcProcessHandle,
	RuntimeConnection,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Fallback map for bare model aliases when no ANTHROPIC_DEFAULT_*_MODEL env var is set.
 * Used by buildDirectSpawn() to resolve short names to concrete model IDs.
 */
const SAPLING_ALIAS_FALLBACKS: Record<string, string> = {
	haiku: "claude-haiku-4-5-20251001",
	sonnet: "claude-sonnet-4-6-20251015",
	opus: "claude-opus-4-6-20251015",
};

/**
 * Bash patterns that modify files and require path boundary validation
 * for implementation agents (builder/merger). Mirrors the constant in pi-guards.ts.
 */
const FILE_MODIFYING_BASH_PATTERNS = [
	"sed\\s+-i",
	"sed\\s+--in-place",
	"echo\\s+.*>",
	"printf\\s+.*>",
	"cat\\s+.*>",
	"tee\\s",
	"\\bmv\\s",
	"\\bcp\\s",
	"\\brm\\s",
	"\\bmkdir\\s",
	"\\btouch\\s",
	"\\bchmod\\s",
	"\\bchown\\s",
	">>",
	"\\binstall\\s",
	"\\brsync\\s",
];

/** Capabilities that must not modify project files (read-only mode). */
const NON_IMPLEMENTATION_CAPABILITIES = new Set([
	"scout",
	"reviewer",
	"lead",
	"orchestrator",
	"coordinator",
	"supervisor",
	"monitor",
]);

/**
 * Normalize a sapling terminal `result` event so the runtime-agnostic
 * turn-runner completion check (`cleanResult = event.isError !== true`) is
 * correct for sapling's real event shape.
 *
 * LIVE sapling emits its final result as:
 *   { type: "result", outcome: "success" | "max_turns" | "error", summary,
 *     totalTurns, totalInputTokens, totalOutputTokens }
 * (https://github.com/jayminwest/sapling/blob/main/src/hooks/events.ts).
 *
 * Critically, that event carries NO `isError` field — the success/failure
 * discriminator is `outcome`. Without normalization, `event.isError !== true`
 * is vacuously true for an `outcome:"error"` (or `"max_turns"`) result, so an
 * ERRORED sapling task would set `cleanResult=true` → `completedViaEvents=true`
 * → FALSE completion (a failure reported upstream as success).
 *
 * This derives `isError` from `outcome` for result events: a clean completion
 * requires `outcome === "success"`; `"error"` and `"max_turns"` are failures.
 * Rules (immutability preserved — returns a new object, never mutates the input):
 * - An explicit `isError` already on the event WINS (any future sapling shape
 *   that sets it pass through untouched — `isError:false` stays clean,
 *   `isError:true` stays a failure).
 * - `outcome === "success"` → clean (`isError:false`).
 * - Any OTHER recognized outcome string (`"error"`, `"max_turns"`) → failure.
 * - A `result` event with NEITHER a recognizable success discriminator
 *   (`outcome === "success"` or explicit `isError === false`) FAILS CLOSED:
 *   `isError:true`. This runs only inside `SaplingRuntime.parseEvents`, so every
 *   `result` here is a sapling terminal result — a malformed one lacking any
 *   success signal (no string `outcome`, no explicit `isError`) must NOT be
 *   treated as a clean completion (that would false-complete a failure as
 *   success). Failing closed makes the worst case a spurious failure signal, not
 *   a silently-dropped failure.
 * - Non-`result` events are never touched, even if they carry an `outcome`.
 */
function normalizeResultEvent(event: AgentEvent): AgentEvent {
	if (event.type !== "result") return event;
	// An explicit discriminator already present — respect it (true or false).
	if ("isError" in event) return event;
	// A recognizable clean success discriminator keeps the result clean.
	if (event.outcome === "success") return { ...event, isError: false };
	// Otherwise FAIL CLOSED: a sapling result with no success signal (a known
	// failure outcome, an unrecognized/non-string outcome, or no outcome at all)
	// is treated as a failure so a malformed result never false-completes.
	return { ...event, isError: true };
}

/**
 * sp 0.3.2 `GuardConfig` (the EXACT shape `sp run --guards-file` parses).
 *
 * Mirrors `@os-eco/sapling-cli` `src/types.ts` `GuardConfig` (lines 304-314).
 * `rules` is REQUIRED — sp throws `Guards file must have a "rules" array` when
 * it is absent, which is the bug that made every sapling worker hard-error once
 * the 2026-06-13 `--guards-file` change made sp actually LOAD this file. The flat
 * fields (`pathBoundary`/`readOnly`/`blockedTools`/`blockedBashPatterns`) do the
 * enforcement and are evaluated before `rules`, so an empty `rules: []` is valid.
 *
 * Only fields sp defines are emitted — ov-internal concepts (agentName, capability,
 * writeToolsBlocked, writeToolNames, qualityGates, safePrefixes, nested bashGuards)
 * are intentionally NOT written, so the file is unambiguous to sp.
 */
interface SaplingGuardConfig {
	version?: string;
	rules: never[];
	pathBoundary?: string;
	readOnly?: boolean;
	blockedBashPatterns?: string[];
	blockedTools?: string[];
	eventConfig?: {
		onToolStart?: string[];
		onToolEnd?: string[];
		onSessionEnd?: string[];
	};
}

/**
 * Build the guards configuration object for .sapling/guards.json.
 *
 * Emits EXACTLY sp 0.3.2's `GuardConfig` shape (see {@link SaplingGuardConfig})
 * so `sp run --guards-file` parses it. ov's enforcement intent is preserved via
 * sp's flat fields:
 * - `pathBoundary`: all file ops must target paths within worktreePath.
 * - `readOnly`: true for non-implementation capabilities (blocks write/edit tools).
 * - `blockedTools`: NATIVE_TEAM_TOOLS + INTERACTIVE_TOOLS for all agents.
 * - `blockedBashPatterns`: a single FLAT regex list — DANGEROUS_BASH_PATTERNS always,
 *   plus FILE_MODIFYING_BASH_PATTERNS for read-only/non-impl agents (which must not
 *   modify files at all). sp evaluates these against every bash command.
 * - `eventConfig`: argv arrays for activity tracking via `ov log` (sp fires these
 *   natively on tool-start/tool-end/session-end).
 *
 * Note: sp has no `safePrefixes` allowlist, so ov's safe-prefix bypass is dropped.
 * To avoid blocking coordination agents' own git/quality-gate commands, the
 * file-modifying git patterns are only added for read-only agents (impl agents
 * legitimately run them).
 *
 * @param hooks - Agent identity, capability, and worktree path.
 * @returns sp-compatible guards configuration object.
 */
function buildGuardsConfig(hooks: HooksDef): SaplingGuardConfig {
	const { agentName, capability, worktreePath } = hooks;
	const isNonImpl = NON_IMPLEMENTATION_CAPABILITIES.has(capability);

	// Flat blocked-bash list. DANGEROUS patterns always apply; FILE_MODIFYING
	// patterns are added for read-only (non-impl) agents — they must not modify
	// files via bash. Implementation agents (builder/merger) need file-modifying
	// bash (sed/mv/cp/mkdir/etc.) to do their job, so those are NOT blocked for
	// them — the pathBoundary still confines writes to the worktree.
	const blockedBashPatterns: string[] = [
		...DANGEROUS_BASH_PATTERNS,
		...(isNonImpl ? FILE_MODIFYING_BASH_PATTERNS : []),
	];

	return {
		// sp's version is `version?: string` — use a string, not a number.
		version: "1",
		// REQUIRED by sp. The flat fields below do the enforcement; empty is valid.
		rules: [],
		// Path boundary: all file writes must target paths within this directory.
		pathBoundary: worktreePath,
		// Read-only mode: true for non-implementation capabilities (scout, reviewer,
		// lead, etc.). sp blocks all write/edit tools when true.
		readOnly: isNonImpl,
		// Tool names blocked for ALL agents.
		// - NATIVE_TEAM_TOOLS: use `ov sling` for delegation instead.
		// - INTERACTIVE_TOOLS: escalate via `ov mail --type question` instead.
		blockedTools: [...NATIVE_TEAM_TOOLS, ...INTERACTIVE_TOOLS],
		// Flat regex blocklist evaluated by sp against every bash command.
		blockedBashPatterns,
		// Activity tracking event configuration (sp fires these natively).
		// Each value is an argv array passed to a subprocess — no shell interpolation.
		eventConfig: {
			// Fires before each tool executes (updates lastActivity in SessionStore).
			onToolStart: ["ov", "log", "tool-start", "--agent", agentName],
			// Fires after each tool completes.
			onToolEnd: ["ov", "log", "tool-end", "--agent", agentName],
			// Fires when the agent's work loop completes or the process exits.
			onSessionEnd: ["ov", "log", "session-end", "--agent", agentName],
		},
	};
}

/** Pending JSON-RPC getState request waiting for a response. */
interface PendingRequest {
	resolve: (state: ConnectionState) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * RPC connection to a running Sapling agent process.
 *
 * Communicates over stdin/stdout using a simple NDJSON protocol:
 * - Fire-and-forget control messages (steer, followUp, abort) written as plain NDJSON.
 * - getState() uses JSON-RPC 2.0 (id + method) with a background reader routing responses.
 *
 * Background drainStdout() loop reads stdout and routes JSON-RPC 2.0 responses
 * (lines with `jsonrpc` field and numeric `id`) to pending getState() waiters.
 * All other NDJSON events are silently discarded.
 *
 * Not exported — constructed only by SaplingRuntime.connect().
 */
class SaplingConnection implements RuntimeConnection {
	private nextId = 0;
	private readonly pending = new Map<number, PendingRequest>();
	private closed = false;
	private readonly proc: RpcProcessHandle;
	private readonly timeoutMs: number;

	constructor(proc: RpcProcessHandle, timeoutMs = 5000) {
		this.proc = proc;
		this.timeoutMs = timeoutMs;
		this.drainStdout();
	}

	/**
	 * Background reader: consumes stdout, routes JSON-RPC responses to pending waiters.
	 * Follows the same buffer/split pattern as parseEvents().
	 * On stream end or error, rejects all pending requests.
	 */
	private drainStdout(): void {
		const reader = this.proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		const processLine = (line: string): void => {
			const trimmed = line.trim();
			if (!trimmed) return;

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				// Skip malformed lines — partial writes or non-JSON debug output
				return;
			}

			// Route JSON-RPC 2.0 responses: must have jsonrpc field and numeric id
			if (parsed.jsonrpc !== undefined && typeof parsed.id === "number") {
				const pending = this.pending.get(parsed.id);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(parsed.id);
					pending.resolve(parsed.result as ConnectionState);
				}
			}
			// Non-RPC NDJSON lines are silently discarded
		};

		const read = async (): Promise<void> => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						processLine(line);
					}
				}

				// Flush remaining buffer on clean stream end
				if (buffer.trim()) {
					processLine(buffer);
				}
			} catch {
				// Stream error — fall through to reject all pending
			} finally {
				reader.releaseLock();
				// Reject all pending on stream end or error
				for (const [, pending] of this.pending) {
					clearTimeout(pending.timer);
					pending.reject(new Error("connection closed"));
				}
				this.pending.clear();
			}
		};

		// Fire-and-forget background reader
		read().catch(() => {
			// Errors are handled in the finally block above
		});
	}

	/** Write a JSON message + newline to stdin. */
	private writeMsg(msg: Record<string, unknown>): void {
		const line = `${JSON.stringify(msg)}\n`;
		const result = this.proc.stdin.write(line);
		if (result instanceof Promise) {
			result.catch(() => {
				// Fire-and-forget write errors are non-fatal for control messages
			});
		}
	}

	async sendPrompt(text: string): Promise<void> {
		this.writeMsg({ method: "steer", params: { content: text } });
	}

	async followUp(text: string): Promise<void> {
		this.writeMsg({ method: "followUp", params: { content: text } });
	}

	async abort(): Promise<void> {
		this.writeMsg({ method: "abort" });
	}

	getState(): Promise<ConnectionState> {
		if (this.closed) {
			return Promise.reject(new Error("connection closed"));
		}
		const id = this.nextId++;
		return new Promise<ConnectionState>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("getState timed out"));
			}, this.timeoutMs);

			this.pending.set(id, { resolve, reject, timer });

			// Send the request — on write failure, clean up the pending entry
			const line = `${JSON.stringify({ id, method: "getState" })}\n`;
			const result = this.proc.stdin.write(line);
			if (result instanceof Promise) {
				result.catch(() => {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(new Error("write failed"));
				});
			}
		});
	}

	close(): void {
		this.closed = true;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("connection closed"));
		}
		this.pending.clear();
	}
}

/**
 * Sapling runtime adapter.
 *
 * Implements AgentRuntime for the `sp` CLI (Sapling headless coding agent).
 * Sapling workers run as headless Bun subprocesses — they communicate via
 * JSON-RPC on stdin/stdout rather than a TUI in a tmux pane. This means
 * all tmux lifecycle methods (buildSpawnCommand, detectReady, requiresBeaconVerification)
 * are stubs: the orchestrator checks `runtime.headless === true` and takes the
 * direct-spawn code path instead.
 *
 * Instructions are delivered via `SAPLING.md` in the worktree root.
 * Guard configuration is written to `.sapling/guards.json` (stub for Wave 3).
 *
 * Hardware impact: Sapling workers use 60–120 MB RAM vs 250–400 MB for TUI agents,
 * enabling 4–6× more concurrent workers on a typical developer machine.
 */
export class SaplingRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "sapling";

	/** Stability level. Sapling is the primary headless runtime. */
	readonly stability = "stable" as const;

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = "SAPLING.md";

	/**
	 * Whether this runtime is headless (no tmux, direct subprocess).
	 * Headless runtimes bypass all tmux session management and use Bun.spawn directly.
	 */
	readonly headless = true;

	/**
	 * Sapling signals task completion via its NDJSON `result` event, NOT via an
	 * outbound `ov mail`. Post Warren-decoupling, sapling workers no longer make
	 * `ov mail` calls, so the turn-runner must treat a clean `result` event as the
	 * terminal signal — otherwise a clean sapling exit is flagged as a "no terminal
	 * mail" contract violation and the parent is told the worker died.
	 */
	readonly signalsCompletionViaEvents = true;

	/**
	 * Optional sapling-scoped runtime config (e.g. subscription-proxy routing).
	 * Sourced from `config.runtime.sapling` at construction via the registry,
	 * mirroring how PiRuntime receives `config.runtime.pi`. Undefined → no proxy.
	 */
	private readonly config?: SaplingRuntimeConfig;

	/**
	 * @param config - Optional `runtime.sapling` config. When omitted, sapling
	 *   behaves exactly as before (no subscription-proxy routing).
	 */
	constructor(config?: SaplingRuntimeConfig) {
		this.config = config;
	}

	/**
	 * Per-spawn readiness preflight (HIGH 3). Sapling is spawn-per-turn — there is no
	 * long-lived worker process — so this runs before EVERY sapling spawn (the initial
	 * `ov sling` dispatch AND each later turn driven by the turn-runner), not just the
	 * first. A proxy that died between turns would otherwise yield a silent 401 mid-task.
	 *
	 * No-op when subscription-proxy mode is disabled. When enabled it:
	 *   1. validates the proxy URL is loopback (token-leak guard), then
	 *   2. health-gates readiness via {@link ensureSaplingProxyRunning} — a single cheap
	 *      localhost GET to /__ov_proxy_health when already healthy, an auto-start when
	 *      down, and a hard error (thrown AgentError-equivalent) when the port is squatted
	 *      by another service or no subscription token is available.
	 *
	 * Idempotent and cheap: callers may invoke it redundantly (e.g. sling.ts already ran
	 * it for the same dispatch) — the health probe makes the already-healthy case a
	 * no-op, so there is no need to conditionally skip it.
	 */
	async preflightDirectSpawn(): Promise<void> {
		const proxy = resolveSaplingProxy(this.config);
		if (!proxy.enabled) return;
		assertLoopbackProxyUrl(proxy.proxyUrl);
		const result = await ensureSaplingProxyRunning(proxy.proxyUrl);
		if (!result.ready) {
			throw new Error(
				`sapling subscription proxy is not ready at ${proxy.proxyUrl} (see the guidance logged above). ` +
					"Refusing to spawn a sapling worker against a dead/misconfigured proxy.",
			);
		}
	}

	/**
	 * Build the shell command string to spawn a Sapling agent in a tmux pane.
	 *
	 * This method exists for the TUI fallback path (e.g., `ov sling --runtime sapling`
	 * on a host that has tmux). Under normal operation, Sapling is headless and
	 * buildDirectSpawn() is used instead.
	 *
	 * Maps SpawnOpts to `sp run` flags:
	 * - `model` → `--model <model>`
	 * - `appendSystemPromptFile` → prepended via `$(cat ...)` shell expansion
	 * - `appendSystemPrompt` → appended inline
	 * - `permissionMode` is accepted but NOT mapped — Sapling enforces security
	 *   via .sapling/guards.json rather than permission flags.
	 *
	 * @param opts - Spawn options (model, appendSystemPrompt; permissionMode ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `sp run --model ${opts.model} --json`;

		if (opts.appendSystemPromptFile) {
			// Read role definition from file at shell expansion time — avoids tmux
			// IPC message size limits. Append the "read SAPLING.md" instruction.
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` "$(cat '${escaped}')"' Read SAPLING.md for your task assignment and begin immediately.'`;
		} else if (opts.appendSystemPrompt) {
			// Inline role definition + instruction to read SAPLING.md.
			const prompt = `${opts.appendSystemPrompt}\n\nRead SAPLING.md for your task assignment and begin immediately.`;
			const escaped = prompt.replace(/'/g, "'\\''");
			cmd += ` '${escaped}'`;
		} else {
			cmd += ` 'Read SAPLING.md for your task assignment and begin immediately.'`;
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Sapling invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `sp print` subcommand
	 * processes a prompt and exits, printing the result to stdout.
	 *
	 * Used by merge/resolver.ts (AI-assisted conflict resolution) and
	 * watchdog/triage.ts (AI-assisted failure classification).
	 *
	 * @param prompt - The prompt to pass as the argument
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["sp", "print"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		cmd.push(prompt);
		return cmd;
	}

	/**
	 * Build the argv array for Bun.spawn() to launch a Sapling agent subprocess.
	 *
	 * Returns an argv array that starts the Sapling agent with NDJSON event output. The agent
	 * reads its instructions from the file at `opts.instructionPath`, processes
	 * the task, emits NDJSON events on stdout, and exits on completion.
	 *
	 * @param opts - Direct spawn options (cwd, env, model, instructionPath)
	 * @returns Argv array for Bun.spawn — do not shell-interpolate
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		const argv = ["sp", "run"];
		if (opts.model !== undefined) {
			// Resolve the actual model name: if this is an alias (e.g. "sonnet") routed
			// through a gateway, the real model ID is in the env vars. Sapling passes
			// --model directly to the SDK, so it needs the actual model ID, not the alias.
			let model = opts.model;
			let resolved = false;
			if (opts.env) {
				const aliasKey = `ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL`;
				const envResolved = opts.env[aliasKey];
				if (envResolved) {
					model = envResolved;
					resolved = true;
				}
			}
			// Fallback: bare aliases (haiku/sonnet/opus) with no gateway env var → concrete model ID.
			if (!resolved) {
				const fallback = SAPLING_ALIAS_FALLBACKS[model];
				if (fallback !== undefined) {
					model = fallback;
				}
			}
			argv.push("--model", model);
		}
		argv.push("--json", "--cwd", opts.cwd, "--system-prompt-file", opts.instructionPath);

		// Per-worktree base path for guards/metrics. deployConfig writes
		// .sapling/guards.json into the worktree; the same path must be passed to
		// `sp run --guards-file` because sp 0.3.2 loads guards ONLY via the explicit
		// flag (it does not auto-discover .sapling/guards.json). Prefer the explicit
		// worktreePath when present, else fall back to cwd (they are the same in the
		// normal headless-worker spawn path).
		const worktreeBase = opts.worktreePath ?? opts.cwd;

		// Patch (b): point sp at the guards file deployConfig already wrote.
		argv.push("--guards-file", join(worktreeBase, ".sapling", "guards.json"));

		// Patch (c): ecosystem identity + metrics flags. agentName/taskId come from
		// the dispatch (also exported as OVERSTORY_AGENT_NAME/OVERSTORY_TASK_ID env).
		// Omit a single flag gracefully rather than passing an empty operand when a
		// value is absent.
		if (opts.agentName) {
			argv.push("--agent-name", opts.agentName);
		}
		if (opts.taskId) {
			argv.push("--task-id", opts.taskId);
		}
		// Metrics land under the worktree so they're scoped per-agent and cleaned
		// up with the worktree.
		argv.push("--metrics-path", join(worktreeBase, ".sapling", "metrics.json"));

		// Prompt remains the final positional argument: `sp run [flags] <prompt>`.
		argv.push("Read SAPLING.md for your task assignment and begin immediately.");
		return argv;
	}

	/**
	 * Deploy per-agent instructions and guard configuration to a worktree.
	 *
	 * Writes the overlay content to `SAPLING.md` in the worktree root.
	 * Also writes `.sapling/guards.json` with the full guard configuration
	 * derived from `hooks` — translating overstory guard-rules.ts constants
	 * into JSON-serializable form for the `sp` CLI to enforce.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as SAPLING.md, or undefined for hooks-only deployment
	 * @param hooks - Agent identity, capability, and quality gates for guard config
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		hooks: HooksDef,
	): Promise<void> {
		// Write SAPLING.md instruction file (only when overlay is provided).
		if (overlay) {
			const saplingPath = join(worktreePath, this.instructionPath);
			await mkdir(dirname(saplingPath), { recursive: true });
			await Bun.write(saplingPath, overlay.content);
		}

		// Always write .sapling/guards.json — even when overlay is undefined
		// (hooks-only deployment for coordinator/supervisor/monitor).
		const guardsPath = join(worktreePath, ".sapling", "guards.json");
		await mkdir(dirname(guardsPath), { recursive: true });
		await Bun.write(guardsPath, `${JSON.stringify(buildGuardsConfig(hooks), null, 2)}\n`);
	}

	/**
	 * Sapling is headless — always ready.
	 *
	 * Sapling runs as a direct subprocess that emits a `{"type":"ready"}` event
	 * on stdout when initialization completes. Tmux-based readiness detection
	 * is never used for Sapling workers.
	 *
	 * @param _paneContent - Captured tmux pane content (unused)
	 * @returns Always `{ phase: "ready" }`
	 */
	detectReady(_paneContent: string): ReadyState {
		return { phase: "ready" };
	}

	/**
	 * Sapling does not require beacon verification/resend.
	 *
	 * The beacon verification loop exists because Claude Code's TUI sometimes
	 * swallows the initial Enter during late initialization. Sapling is headless —
	 * it communicates via stdin/stdout with no TUI startup delay.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Parse a Sapling NDJSON transcript file into normalized token usage.
	 *
	 * Sapling emits NDJSON events on stdout during execution. The transcript
	 * file records these events. Token usage is extracted from events that
	 * carry a `usage` object with `input_tokens` and/or `output_tokens` fields.
	 * Model identity is extracted from any event that carries a `model` field.
	 *
	 * Returns null if the file does not exist or cannot be parsed.
	 *
	 * @param path - Absolute path to the Sapling NDJSON transcript file
	 * @returns Aggregated token usage, or null if unavailable
	 */
	async parseTranscript(path: string): Promise<TranscriptSummary | null> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return null;
		}

		try {
			const text = await file.text();
			const lines = text.split("\n").filter((l) => l.trim().length > 0);

			let inputTokens = 0;
			let outputTokens = 0;
			let model = "";

			for (const line of lines) {
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Skip malformed lines — partial writes during capture.
					continue;
				}

				// Extract token usage from any event carrying a usage object.
				if (typeof event.usage === "object" && event.usage !== null) {
					const usage = event.usage as Record<string, unknown>;
					if (typeof usage.input_tokens === "number") {
						inputTokens += usage.input_tokens;
					}
					if (typeof usage.output_tokens === "number") {
						outputTokens += usage.output_tokens;
					}
				}

				// Capture model from any event that carries it.
				if (typeof event.model === "string" && event.model && !model) {
					model = event.model;
				}
			}

			return { inputTokens, outputTokens, model };
		} catch {
			return null;
		}
	}

	/**
	 * Parse NDJSON stdout from a Sapling agent subprocess into typed AgentEvent objects.
	 *
	 * Reads the ReadableStream from Bun.spawn() stdout, buffers partial lines,
	 * and yields a typed AgentEvent for each complete JSON line. Malformed lines
	 * (partial writes, non-JSON output) are silently skipped.
	 *
	 * The NDJSON format mirrors Pi's `--mode json` output so `ov feed`, `ov trace`,
	 * and `ov costs` work without runtime-specific parsing.
	 *
	 * @param stream - ReadableStream<Uint8Array> from Bun.spawn stdout
	 * @yields Parsed AgentEvent objects in emission order
	 */
	async *parseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;

				buffer += decoder.decode(result.value, { stream: true });

				// Split on newlines, keeping the remainder in the buffer.
				const lines = buffer.split("\n");
				// The last element is either empty or an incomplete line.
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					try {
						const event = normalizeResultEvent(JSON.parse(trimmed) as AgentEvent);
						yield event;
					} catch {
						// Skip malformed lines — partial writes or debug output.
					}
				}
			}

			// Flush any remaining buffer content after stream ends.
			const remaining = buffer.trim();
			if (remaining) {
				try {
					const event = normalizeResultEvent(JSON.parse(remaining) as AgentEvent);
					yield event;
				} catch {
					// Skip malformed trailing line.
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Build runtime-specific environment variables for spawning sapling.
	 *
	 * Translates overstory's gateway provider env vars into what sapling expects.
	 * Worktrees don't have .env files (gitignored), so overstory must pass
	 * provider credentials — same as it does for every other runtime.
	 *
	 * Key translations:
	 * - ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY (sapling SDK reads API_KEY)
	 * - ANTHROPIC_BASE_URL passed through as-is
	 * - SAPLING_BACKEND=sdk forced when gateway provider is configured
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map for sapling subprocess
	 */
	/**
	 * Establish a direct RPC connection to a running Sapling agent process.
	 *
	 * Returns a SaplingConnection that multiplexes getState() JSON-RPC 2.0
	 * requests over stdin/stdout alongside the normal NDJSON event stream.
	 *
	 * @param process - Stdin/stdout handles from the spawned agent subprocess
	 * @returns RuntimeConnection for RPC-based health checks and control
	 */
	connect(process: RpcProcessHandle): RuntimeConnection {
		return new SaplingConnection(process);
	}

	buildEnv(model: ResolvedModel): Record<string, string> {
		const env: Record<string, string> = {
			// Clear Claude Code session markers so sapling doesn't auto-detect
			// SDK backend when spawned from a Claude Code session (CLAUDECODE=1).
			CLAUDECODE: "",
			CLAUDE_CODE_SSE_PORT: "",
			CLAUDE_CODE_ENTRYPOINT: "",
			// Clear ANTHROPIC_API_KEY so the parent session's key doesn't leak
			// into the sapling subprocess. Gateway providers re-set this below.
			ANTHROPIC_API_KEY: "",
		};

		const providerEnv = model.env ?? {};

		// Gateway providers use ANTHROPIC_AUTH_TOKEN; sapling's SDK reads ANTHROPIC_API_KEY.
		if (providerEnv.ANTHROPIC_AUTH_TOKEN) {
			env.ANTHROPIC_API_KEY = providerEnv.ANTHROPIC_AUTH_TOKEN;
		}
		if (providerEnv.ANTHROPIC_BASE_URL) {
			env.ANTHROPIC_BASE_URL = providerEnv.ANTHROPIC_BASE_URL;
		}
		// Force SDK backend when a gateway provider is configured.
		if (providerEnv.ANTHROPIC_AUTH_TOKEN || providerEnv.ANTHROPIC_BASE_URL) {
			env.SAPLING_BACKEND = "sdk";
		}

		// Forward model alias env vars so buildDirectSpawn can resolve gateway-routed models.
		// resolveProviderEnv sets ANTHROPIC_DEFAULT_<ALIAS>_MODEL (e.g. ANTHROPIC_DEFAULT_SONNET_MODEL)
		// to point to the real model ID behind the gateway. Without forwarding these,
		// buildDirectSpawn cannot find the real model ID and falls back to the bare alias.
		for (const [key, value] of Object.entries(providerEnv)) {
			if (key.startsWith("ANTHROPIC_DEFAULT_") && key.endsWith("_MODEL")) {
				env[key] = value;
			}
		}

		// Subscription-proxy routing (SAPLING-SCOPED). When enabled via
		// config.runtime.sapling.subscriptionProxy (or the OV_SAPLING_SUBSCRIPTION_PROXY
		// env fallback), point the sapling worker's Anthropic SDK at the local
		// bearer-injecting proxy. The proxy swaps the dummy x-api-key for the operator's
		// Claude Code subscription token, so sapling runs with no `sk-ant-api…` key.
		//
		// This MUST stay inside SaplingRuntime.buildEnv: it is the only point scoped to
		// sapling workers. ClaudeRuntime.buildEnv never sets ANTHROPIC_BASE_URL, so claude
		// workers are unaffected (their auth path is untouched). When the toggle is unset,
		// resolveSaplingProxy returns { enabled: false } and this block is a no-op — the
		// returned env is byte-identical to the pre-feature behavior.
		const proxy = resolveSaplingProxy(this.config);
		if (proxy.enabled) {
			// Loopback-only: the proxy injects the operator's subscription token into
			// every forwarded request, so a non-loopback host would leak that token to a
			// remote. Reject before we ever wire ANTHROPIC_BASE_URL at it.
			assertLoopbackProxyUrl(proxy.proxyUrl);
			env.ANTHROPIC_BASE_URL = proxy.proxyUrl;
			// The proxy ignores x-api-key, but the SDK still requires a non-empty key.
			env.ANTHROPIC_API_KEY = SAPLING_PROXY_DUMMY_KEY;
			env.SAPLING_BACKEND = "sdk";
		}

		return env;
	}

	/** Sapling uses NDJSON event streaming — no transcript files. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}
}
