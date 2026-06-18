/**
 * Team roster resolver for per-capability commit identity.
 *
 * Reads <projectRoot>/.team/roster.json and maps an ov capability + agent name
 * to a stable { name, email } pair so dispatched workers self-attribute their
 * commits to the correct GitHub account (noreply email → avatars + contributor
 * graph, no real email leaked).
 *
 * Fully backward compatible: returns null on any miss (absent file, unknown
 * capability, malformed JSON). Callers inject the four GIT_* env vars only when
 * the result is non-null.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_EMAIL_PATTERN = "{id}+{login}@users.noreply.github.com";

interface RosterRole {
	login: string;
	id: number;
	name: string;
	label?: string;
}

interface RosterJson {
	version?: number;
	email_pattern?: string;
	roles?: Record<string, RosterRole>;
	capabilities?: Record<string, string | string[]>;
}

/** Derived commit identity returned to callers. */
export interface CommitIdentity {
	name: string;
	email: string;
}

/**
 * Derive the commit email from the pattern by substituting {id} and {login}.
 * Falls back to the default noreply pattern when the pattern is absent.
 */
function deriveEmail(pattern: string | undefined, role: RosterRole): string {
	const tpl = typeof pattern === "string" && pattern.length > 0 ? pattern : DEFAULT_EMAIL_PATTERN;
	return tpl.replace("{id}", String(role.id)).replace("{login}", role.login);
}

/**
 * Stable index selection for array capabilities.
 *
 * Maps an agentName to a deterministic index in [0, length) using a
 * simple sum-of-char-codes hash. Same name always picks the same slot,
 * but different names distribute across coder-a / coder-b.
 */
function pickIndexByName(agentName: string, length: number): number {
	let sum = 0;
	for (let i = 0; i < agentName.length; i++) {
		sum += agentName.charCodeAt(i);
	}
	return sum % length;
}

/**
 * Resolve the commit identity for a given capability and agentName.
 *
 * @param rosterJson - Parsed roster JSON (or null/undefined/invalid — all safe).
 * @param capability - The ov capability string (e.g. "builder", "reviewer").
 * @param agentName  - The worker's agent name (used for deterministic array pick).
 * @returns CommitIdentity when successfully resolved, null on any miss.
 */
export function resolveCommitIdentity(
	rosterJson: unknown,
	capability: string,
	agentName: string,
): CommitIdentity | null {
	try {
		if (
			rosterJson === null ||
			rosterJson === undefined ||
			typeof rosterJson !== "object" ||
			Array.isArray(rosterJson)
		) {
			return null;
		}

		const roster = rosterJson as RosterJson;

		if (!roster.capabilities || typeof roster.capabilities !== "object") return null;
		if (!roster.roles || typeof roster.roles !== "object") return null;

		const capEntry = roster.capabilities[capability];
		if (capEntry === undefined || capEntry === null) return null;

		let roleKey: string;

		if (typeof capEntry === "string") {
			roleKey = capEntry;
		} else if (Array.isArray(capEntry)) {
			if (capEntry.length === 0) return null;
			// Only allow string elements in the array
			const stringEntries = capEntry.filter((e): e is string => typeof e === "string");
			if (stringEntries.length === 0) return null;
			const idx = pickIndexByName(agentName, stringEntries.length);
			roleKey = stringEntries[idx]!;
		} else {
			return null;
		}

		const role = roster.roles[roleKey];
		if (!role || typeof role !== "object") return null;
		if (typeof role.login !== "string" || typeof role.id !== "number") return null;
		if (typeof role.name !== "string") return null;

		return {
			name: role.name,
			email: deriveEmail(roster.email_pattern, role),
		};
	} catch {
		return null;
	}
}

/**
 * Load and JSON-parse <projectRoot>/.team/roster.json.
 *
 * Returns null on ENOENT, permission errors, or JSON parse failures.
 * Never throws.
 */
export function loadRoster(projectRoot: string): unknown | null {
	try {
		const rosterPath = join(projectRoot, ".team", "roster.json");
		const raw = readFileSync(rosterPath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
