/**
 * Action wrappers for the coordinator console REST endpoints.
 *
 * Thin functions consumed by `src/commands/serve/rest.ts` to drive the headless
 * coordinator without going through tmux. Each function opens its own short-lived
 * SQLite handles when no override is provided so the actions remain DI-friendly
 * and never share long-lived stores with the request lifetime.
 *
 * The CLI command `ov coordinator start` is intentionally untouched — the new
 * headless start path is gated behind `headless: true` in CoordinatorSessionOptions
 * (see src/commands/coordinator.ts).
 */

import { join } from "node:path";
import { AgentError, OverstoryError } from "../../errors.ts";
import { createMailClient } from "../../mail/client.ts";
import type { MailStore } from "../../mail/store.ts";
import { createMailStore } from "../../mail/store.ts";
import { getConnection } from "../../runtimes/connections.ts";
import type { SessionStore } from "../../sessions/store.ts";
import { createSessionStore } from "../../sessions/store.ts";
import type { MailMessage } from "../../types.ts";
import {
	type CheckCompleteResult,
	COORDINATOR_NAME,
	checkComplete,
	startCoordinatorSession,
	stopCoordinatorSession,
} from "../coordinator.ts";

/**
 * Raised when the coordinator is running in tmux mode and cannot be controlled
 * from the headless web-UI surface. The REST layer maps this to HTTP 409.
 *
 * Defined inline (not in src/errors.ts) because adding error types is out of
 * scope for the ui-coord-console-server slice (overstory-82b4). When/if a future
 * task promotes ConflictError to a shared error type, this local class can be
 * deleted in favor of an import.
 */
export class ConflictError extends OverstoryError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "CONFLICT_ERROR", options);
		this.name = "ConflictError";
	}
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoordinatorState {
	running: boolean;
	agentName: string;
	pid: number | null;
	/** Empty string for headless coordinators is normalized to null. */
	tmuxSession: string | null;
	runId: string | null;
	startedAt: string | null;
	lastActivityAt: string | null;
	/** True when a HeadlessClaudeConnection is registered for this agent. */
	headless: boolean;
}

export interface CoordinatorActionDeps {
	projectRoot: string;
	/**
	 * Inject a SessionStore (closing is the caller's responsibility). When omitted,
	 * each action opens a short-lived store from `<projectRoot>/.overstory/sessions.db`.
	 */
	_sessionStore?: SessionStore;
	/**
	 * Inject a MailStore (closing is the caller's responsibility). When omitted,
	 * each action opens a short-lived store from `<projectRoot>/.overstory/mail.db`.
	 */
	_mailStore?: MailStore;
	/** Override the ask poll interval (default 500ms). Used by tests. */
	_askPollIntervalMs?: number;
	/**
	 * Override startCoordinatorSession (used by tests to avoid spawning a real
	 * coordinator process). Falls back to the live import when omitted.
	 */
	_startCoordinatorSession?: typeof startCoordinatorSession;
	/** Override stopCoordinatorSession (used by tests). Falls back to the live import. */
	_stopCoordinatorSession?: typeof stopCoordinatorSession;
}

interface OpenedStores {
	session: SessionStore;
	mail: MailStore;
	close: () => void;
}

const DEFAULT_ASK_POLL_INTERVAL_MS = 500;

function openStores(deps: CoordinatorActionDeps): OpenedStores {
	if (deps._sessionStore !== undefined && deps._mailStore !== undefined) {
		return {
			session: deps._sessionStore,
			mail: deps._mailStore,
			close: () => {},
		};
	}
	const ovDir = join(deps.projectRoot, ".overstory");
	const session = deps._sessionStore ?? createSessionStore(join(ovDir, "sessions.db"));
	const mail = deps._mailStore ?? createMailStore(join(ovDir, "mail.db"));
	return {
		session,
		mail,
		close: () => {
			if (deps._sessionStore === undefined) session.close();
			if (deps._mailStore === undefined) mail.close();
		},
	};
}

/**
 * Active means: a session row exists with a non-terminal state. Returns null
 * for completed/zombie/missing sessions so callers can short-circuit.
 */
function getActiveCoordinatorSession(
	store: SessionStore,
): import("../../types.ts").AgentSession | null {
	const session = store.getByName(COORDINATOR_NAME);
	if (session === null) return null;
	if (session.state === "completed" || session.state === "zombie") return null;
	return session;
}

// ─── State ────────────────────────────────────────────────────────────────────

/** Snapshot of the coordinator's live state. Cheap — single SQLite read. */
export function getCoordinatorState(deps: CoordinatorActionDeps): CoordinatorState {
	const stores = openStores(deps);
	try {
		const session = getActiveCoordinatorSession(stores.session);
		if (session === null) {
			return {
				running: false,
				agentName: COORDINATOR_NAME,
				pid: null,
				tmuxSession: null,
				runId: null,
				startedAt: null,
				lastActivityAt: null,
				headless: false,
			};
		}
		return {
			running: true,
			agentName: session.agentName,
			pid: session.pid,
			tmuxSession: session.tmuxSession === "" ? null : session.tmuxSession,
			runId: session.runId,
			startedAt: session.startedAt,
			lastActivityAt: session.lastActivity,
			headless: getConnection(COORDINATOR_NAME) !== undefined,
		};
	} finally {
		stores.close();
	}
}

// ─── Send ─────────────────────────────────────────────────────────────────────

interface SendOpts {
	subject: string;
	from?: string;
}

/**
 * Send mail to the coordinator and immediately deliver via the headless
 * connection's followUp() when one is registered.
 *
 * Throws AgentError when no active coordinator session exists.
 * Throws ConflictError when the active session is tmux-only (tmuxSession !== "")
 * and no headless connection is registered — the operator must fall back to
 * `ov coordinator send` from the shell.
 */
export async function sendToCoordinator(
	deps: CoordinatorActionDeps,
	body: string,
	opts: SendOpts,
): Promise<{ messageId: string }> {
	const stores = openStores(deps);
	try {
		const session = getActiveCoordinatorSession(stores.session);
		if (session === null) {
			throw new AgentError("Coordinator is not running", { agentName: COORDINATOR_NAME });
		}

		const conn = getConnection(COORDINATOR_NAME);
		if (conn === undefined && session.tmuxSession !== "") {
			throw new ConflictError(
				"Coordinator is tmux-only — use 'ov coordinator send' from the shell",
			);
		}

		const from = opts.from ?? "operator";
		const mailClient = createMailClient(stores.mail);
		const messageId = mailClient.send({
			from,
			to: COORDINATOR_NAME,
			subject: opts.subject,
			body,
			type: "dispatch",
			priority: "normal",
		});

		// Headless coordinator: `installMailInjectors` (serve.ts) runs a
		// per-agent persistent mail loop that polls `mail.db` and writes the
		// batch to the live `HeadlessClaudeConnection.followUp()` (overstory-b03a).
		// We intentionally do not call followUp() inline here to keep delivery
		// single-sourced — the loop handles batching, marking-read, and retry.
		// Tmux coordinators are excluded above (ConflictError).
		return { messageId };
	} finally {
		stores.close();
	}
}

// ─── Ask ──────────────────────────────────────────────────────────────────────

interface AskOpts {
	subject: string;
	from?: string;
	timeoutSec: number;
}

interface AskResult {
	messageId: string;
	reply: { id: string; body: string; subject: string } | null;
	timedOut: boolean;
}

/**
 * Send a synchronous request to the coordinator and poll the mail thread for
 * a correlated reply.
 *
 * Returns `{ reply: null, timedOut: true }` when the deadline expires. Same
 * tmux/headless rejection rules as sendToCoordinator.
 */
export async function askCoordinatorAction(
	deps: CoordinatorActionDeps,
	body: string,
	opts: AskOpts,
): Promise<AskResult> {
	const stores = openStores(deps);
	try {
		const session = getActiveCoordinatorSession(stores.session);
		if (session === null) {
			throw new AgentError("Coordinator is not running", { agentName: COORDINATOR_NAME });
		}

		const conn = getConnection(COORDINATOR_NAME);
		if (conn === undefined && session.tmuxSession !== "") {
			throw new ConflictError("Coordinator is tmux-only — use 'ov coordinator ask' from the shell");
		}

		const from = opts.from ?? "operator";
		const correlationId = crypto.randomUUID();
		const mailClient = createMailClient(stores.mail);
		const messageId = mailClient.send({
			from,
			to: COORDINATOR_NAME,
			subject: opts.subject,
			body,
			type: "dispatch",
			priority: "normal",
			payload: JSON.stringify({ correlationId }),
		});

		const pollIntervalMs = deps._askPollIntervalMs ?? DEFAULT_ASK_POLL_INTERVAL_MS;
		const deadline = Date.now() + opts.timeoutSec * 1000;
		while (Date.now() < deadline) {
			await Bun.sleep(pollIntervalMs);
			const replies: MailMessage[] = stores.mail.getByThread(messageId);
			const reply = replies.find((m) => m.from === COORDINATOR_NAME && m.to === from);
			if (reply !== undefined) {
				return {
					messageId,
					reply: { id: reply.id, body: reply.body, subject: reply.subject },
					timedOut: false,
				};
			}
		}

		return { messageId, reply: null, timedOut: true };
	} finally {
		stores.close();
	}
}

// ─── Check complete ───────────────────────────────────────────────────────────

/**
 * Wraps the existing checkComplete() function. Returns the structured result
 * without printing anything to stdout — suitable for HTTP responses.
 */
export async function checkCoordinatorComplete(
	_deps: CoordinatorActionDeps,
): Promise<CheckCompleteResult> {
	return await checkComplete({ json: true });
}

// ─── Start headless ───────────────────────────────────────────────────────────

interface StartHeadlessResult {
	started: boolean;
	alreadyRunning: boolean;
	pid: number | null;
	runId: string | null;
}

/**
 * Start the coordinator in headless mode (no tmux). Idempotent: when a
 * coordinator session is already active (either tmux or headless), returns
 * `{ started: false, alreadyRunning: true }` instead of throwing.
 */
export async function startCoordinatorHeadless(
	deps: CoordinatorActionDeps,
): Promise<StartHeadlessResult> {
	// If a session is already active, short-circuit before spawning.
	const stores = openStores(deps);
	let preExisting: import("../../types.ts").AgentSession | null;
	try {
		preExisting = getActiveCoordinatorSession(stores.session);
	} finally {
		stores.close();
	}
	if (preExisting !== null) {
		return {
			started: false,
			alreadyRunning: true,
			pid: preExisting.pid,
			runId: preExisting.runId,
		};
	}

	const start = deps._startCoordinatorSession ?? startCoordinatorSession;
	try {
		await start({
			json: true,
			attach: false,
			watchdog: false,
			monitor: false,
			headless: true,
		});
	} catch (err) {
		// Race: another caller spawned the coordinator between our preflight check
		// and start(). Translate to an idempotent response rather than a 500.
		if (err instanceof AgentError && /already running/i.test(err.message)) {
			const stores2 = openStores(deps);
			try {
				const existing = getActiveCoordinatorSession(stores2.session);
				return {
					started: false,
					alreadyRunning: true,
					pid: existing?.pid ?? null,
					runId: existing?.runId ?? null,
				};
			} finally {
				stores2.close();
			}
		}
		throw err;
	}

	// Read back the freshly-created session so the caller can correlate.
	const stores2 = openStores(deps);
	try {
		const created = getActiveCoordinatorSession(stores2.session);
		return {
			started: true,
			alreadyRunning: false,
			pid: created?.pid ?? null,
			runId: created?.runId ?? null,
		};
	} finally {
		stores2.close();
	}
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

/**
 * Stop the coordinator (works for both tmux and headless sessions).
 * Returns `{ stopped: false }` when no active coordinator was found.
 */
export async function stopCoordinator(deps: CoordinatorActionDeps): Promise<{ stopped: boolean }> {
	const stores = openStores(deps);
	let session: import("../../types.ts").AgentSession | null;
	try {
		session = getActiveCoordinatorSession(stores.session);
	} finally {
		stores.close();
	}
	if (session === null) {
		return { stopped: false };
	}

	const stop = deps._stopCoordinatorSession ?? stopCoordinatorSession;
	try {
		await stop({ json: true });
	} catch (err) {
		if (err instanceof AgentError) {
			// Race: someone else stopped the session between our check and the call.
			return { stopped: false };
		}
		throw err;
	}
	return { stopped: true };
}
