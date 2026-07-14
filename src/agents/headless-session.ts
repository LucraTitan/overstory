/**
 * Programmatic service: spawn a headless (spawn-per-turn) agent's first turn.
 *
 * Extracted from `ov sling`'s headless branch (`src/commands/sling.ts`,
 * overstory ov-drive-completion Phase 1) so a later headless
 * run-to-completion driver can spawn an agent and get back a typed result
 * instead of parsing CLI stdout. `slingCommand` calls this service for the
 * headless spawn path and prints the same output as before using the
 * returned `SpawnHeadlessSessionResult`.
 *
 * Scope: this covers ONLY the headless-specific preflight → initial-prompt
 * build → session upsert → first `runTurn` sequence. All of the setup that is
 * SHARED with the tmux spawn path (config/manifest load, hierarchy and
 * concurrency checks, worktree creation, overlay + hooks deployment,
 * auto-dispatch mail, tracker claim, identity creation, and run-id
 * resolution) stays inline in `sling.ts` — it is entangled with the tmux
 * path too and extracting it is out of scope for this phase.
 *
 * IMPORTANT: this service takes an EXPLICIT `runId` and never falls back to
 * the mutable global `.overstory/current-run.txt` the way `sling.ts`'s run-id
 * resolution does. Callers (including a future driver) must resolve the run
 * id themselves before calling this function.
 */

import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { AgentRuntime } from "../runtimes/types.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { AgentSession, ResolvedModel } from "../types.ts";
import { buildBeacon } from "./beacon.ts";
import { buildInitialHeadlessPrompt, formatMailSection } from "./headless-prompt.ts";
import { runTurn, type TurnResult, type TurnSpawnFn } from "./turn-runner.ts";

/** Options for {@link spawnHeadlessSession}. */
export interface SpawnHeadlessSessionOpts {
	/** Resolved agent name (post name-collision resolution). */
	agentName: string;
	capability: string;
	taskId: string;
	/** Absolute path to the project's `.overstory` directory. */
	overstoryDir: string;
	worktreePath: string;
	/** Absolute path to the project root (repo root). */
	projectRoot: string;
	branchName: string;
	parentAgent: string | null;
	depth: number;
	runtime: AgentRuntime;
	resolvedModel: ResolvedModel;
	/**
	 * Explicit run id for this spawn. Callers resolve this themselves — this
	 * service does NOT fall back to the mutable global `current-run.txt`.
	 */
	runId: string;
	/** Session store to upsert the new "booting" row into before driving the turn. */
	store: SessionStore;
	/**
	 * Prior session row when re-spawning against an existing agent name (used
	 * to preserve `claudeSessionId` linkage). Pass `null` for a brand-new
	 * agent name.
	 */
	existingSession: AgentSession | null;
	/** Mulch expertise text to fold into the initial prompt, if any. */
	mulchExpertise?: string;
	/** Spec file content to fold into the initial prompt, if any. */
	specContent?: string;
	/**
	 * Test injection: forwarded to `runTurn`'s `_spawnFn` (defaults to
	 * `Bun.spawn` when omitted). Production callers (`ov sling`) never pass
	 * this — it exists so this service's happy/error paths can be unit
	 * tested deterministically without spawning a real claude process.
	 */
	_spawnFn?: TurnSpawnFn;
}

/** Result of {@link spawnHeadlessSession}. */
export interface SpawnHeadlessSessionResult {
	agentName: string;
	branchName: string;
	worktreePath: string;
	runId: string;
	/** The result of the first turn driven by `runTurn`. */
	firstTurn: TurnResult;
}

/**
 * Preflight, build the initial prompt, upsert the session row, and drive the
 * first turn for a headless spawn-per-turn agent.
 *
 * Mirrors `ov sling --headless`'s setup exactly (same preflight call, same
 * beacon/prompt construction, same session shape, same `runTurn` opts) so
 * `slingCommand`'s observable behavior is unchanged when it delegates here.
 */
export async function spawnHeadlessSession(
	opts: SpawnHeadlessSessionOpts,
): Promise<SpawnHeadlessSessionResult> {
	const {
		agentName,
		capability,
		taskId,
		overstoryDir,
		worktreePath,
		projectRoot,
		branchName,
		parentAgent,
		depth,
		runtime,
		resolvedModel,
		runId,
		store,
		existingSession,
		mulchExpertise,
		specContent,
		_spawnFn,
	} = opts;

	// Preflight the FIRST dispatch. The same per-spawn readiness check the
	// turn-runner runs before every later turn (runtime.preflightDirectSpawn)
	// is delegated here for the initial spawn, so both paths share one source
	// of truth.
	if (runtime.preflightDirectSpawn) {
		try {
			await runtime.preflightDirectSpawn();
		} catch (err) {
			throw new AgentError(err instanceof Error ? err.message : String(err), {
				agentName,
			});
		}
	}

	// `existingSession` (captured by the caller during its name-collision
	// check) carries the re-spawn linkage forward.
	const priorClaudeSessionId = existingSession?.claudeSessionId ?? null;

	// Build the initial prompt (mulch expertise + pending mail + beacon) as
	// the first user turn.
	const mailDbPath = join(overstoryDir, "mail.db");
	const pendingMailStore = createMailStore(mailDbPath);
	let initialPrompt: string;
	try {
		const pendingMailClient = createMailClient(pendingMailStore);
		const pendingMessages = pendingMailClient.check(agentName);
		const mailSection = formatMailSection(pendingMessages);
		const beacon = buildBeacon({
			agentName,
			capability,
			taskId,
			parentAgent,
			depth,
			instructionPath: runtime.instructionPath,
		});
		initialPrompt = buildInitialHeadlessPrompt(
			mulchExpertise,
			mailSection || undefined,
			beacon,
			specContent,
		);
	} finally {
		pendingMailStore.close();
	}

	// Record session BEFORE runTurn so the runner reads it under its lock.
	// pid is null — there is no persistent process; the runner publishes a
	// per-turn PID via .overstory/agents/<name>/turn.pid for the duration of
	// each turn.
	const session: AgentSession = {
		id: `session-${Date.now()}-${agentName}`,
		agentName,
		capability,
		worktreePath,
		branchName,
		taskId,
		tmuxSession: "",
		state: "booting",
		pid: null,
		parentAgent,
		depth,
		runId,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...(priorClaudeSessionId !== null ? { claudeSessionId: priorClaudeSessionId } : {}),
	};
	store.upsert(session);

	// Drive the first user turn synchronously. runTurn manages spawn,
	// stdin write+EOF, event drain, session_id capture, terminal-mail
	// detection, and state transition.
	const firstTurn = await runTurn({
		agentName,
		capability,
		overstoryDir,
		worktreePath,
		projectRoot,
		taskId,
		userTurnNdjson: initialPrompt,
		runtime,
		resolvedModel,
		runId,
		mailDbPath,
		eventsDbPath: join(overstoryDir, "events.db"),
		sessionsDbPath: join(overstoryDir, "sessions.db"),
		...(_spawnFn !== undefined ? { _spawnFn } : {}),
	});

	return { agentName, branchName, worktreePath, runId, firstTurn };
}
