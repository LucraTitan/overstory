/**
 * Pure validator for the normalized-plan JSON.
 *
 * Returns structured errors (never throws) so the command can print them.
 * Per contract §1: validates kind, units count, acceptance count, dependsOn
 * sibling-only constraint, self-edges, cycles, and required field presence.
 */

import type { NormalizedGroup, NormalizedPlan, PlanGroup, StandaloneGroup } from "./schema.ts";

const VALID_KINDS = new Set(["standalone", "plan"]);
const VALID_TYPES = new Set(["task", "bug", "feature", "epic"]);
const VALID_CONFIDENCE = new Set(["high", "low"]);

export type ValidationResult = { ok: true; errors: [] } | { ok: false; errors: string[] };

const SHA256_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Validate a normalized plan. Returns structured errors; never throws.
 */
export function validateNormalizedPlan(plan: NormalizedPlan): ValidationResult {
	const errors: string[] = [];

	// FIX 2: envelope-level checks (structured errors, never throw)
	const planRecord = plan as unknown as Record<string, unknown>;

	// schemaVersion must be 1
	if (planRecord.schemaVersion !== 1) {
		errors.push(`schemaVersion must be 1, got ${JSON.stringify(planRecord.schemaVersion)}`);
	}

	// source must be present with non-empty path and valid contentHash
	const source = planRecord.source as Record<string, unknown> | undefined;
	if (source === undefined || source === null || typeof source !== "object") {
		errors.push("source must be an object with 'path' and 'contentHash'");
	} else {
		if (typeof source.path !== "string" || (source.path as string).trim() === "") {
			errors.push("source.path must be a non-empty string");
		}
		if (
			typeof source.contentHash !== "string" ||
			!SHA256_HASH_RE.test(source.contentHash as string)
		) {
			errors.push(
				`source.contentHash must match sha256:<64 hex chars>, got ${JSON.stringify(source.contentHash)}`,
			);
		}
	}

	// ambiguities must be an array if present
	if (
		"ambiguities" in planRecord &&
		planRecord.ambiguities !== undefined &&
		!Array.isArray(planRecord.ambiguities)
	) {
		errors.push("ambiguities must be an array if present");
	}

	// B4: null/undefined plan.groups guard — never throw
	if (!Array.isArray(plan.groups)) {
		errors.push("plan.groups must be a non-empty array");
		return { ok: false, errors };
	}

	if (plan.groups.length === 0) {
		errors.push("plan.groups must be a non-empty array");
		return { ok: false, errors };
	}

	// FIX 2 + B5: ONE GLOBAL logicalId namespace — no collisions across groups AND units.
	// A group logicalId matching a unit logicalId is an error (not just within-kind duplicates).
	const allLogicalIds = new Set<string>(); // unified namespace
	for (const group of plan.groups) {
		const gRec = group as unknown as Record<string, unknown>;
		const gId = gRec.logicalId as string | undefined;
		if (gId !== undefined) {
			if (allLogicalIds.has(gId)) {
				errors.push(
					`Duplicate logicalId '${gId}' — logicalIds must be unique across groups and units`,
				);
			}
			allLogicalIds.add(gId);
		}
		if (
			(group as { kind?: unknown }).kind === "plan" &&
			Array.isArray((group as { units?: unknown }).units)
		) {
			for (const unit of (group as { units: Array<{ logicalId?: string }> }).units) {
				const uId = unit.logicalId;
				if (uId !== undefined) {
					if (allLogicalIds.has(uId)) {
						errors.push(
							`Duplicate logicalId '${uId}' — logicalIds must be unique across groups and units`,
						);
					}
					allLogicalIds.add(uId);
				}
			}
		}
	}

	for (const group of plan.groups) {
		validateGroup(group, errors);
	}

	return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function validateGroup(group: NormalizedGroup, errors: string[]): void {
	const groupRecord = group as unknown as Record<string, unknown>;
	const prefix = `Group '${groupRecord.logicalId ?? "?"}':`;

	// Validate kind
	const kind = groupRecord.kind;
	if (!VALID_KINDS.has(kind as string)) {
		errors.push(`${prefix} invalid kind '${String(kind)}'; must be 'standalone' or 'plan'`);
		return; // Can't validate further without a valid kind
	}

	// Validate common required fields
	validateCommonFields(group as StandaloneGroup | PlanGroup, prefix, errors);

	if (group.kind === "standalone") {
		// No additional standalone-specific checks beyond common fields
	} else if (group.kind === "plan") {
		validatePlanGroup(group, prefix, errors);
	}
}

function validateCommonFields(
	group: StandaloneGroup | PlanGroup,
	prefix: string,
	errors: string[],
): void {
	if (!group.title || group.title.trim() === "") {
		errors.push(`${prefix} title must be non-empty`);
	}
	if (!group.description || group.description.trim() === "") {
		errors.push(`${prefix} description must be non-empty`);
	}
	if (!VALID_TYPES.has(group.type)) {
		errors.push(`${prefix} invalid type '${group.type}'; must be task|bug|feature|epic`);
	}
	if (typeof group.priority !== "number" || group.priority < 0 || group.priority > 4) {
		errors.push(`${prefix} priority must be 0..4, got ${String(group.priority)}`);
	}
	if (!VALID_CONFIDENCE.has(group.confidence)) {
		errors.push(`${prefix} invalid confidence '${group.confidence}'`);
	}
}

function validatePlanGroup(group: PlanGroup, prefix: string, errors: string[]): void {
	// Template required for plan groups — v1: feature ONLY
	if (group.template !== "feature") {
		errors.push(
			`${prefix} plan group template must be 'feature' in v1 (got '${String(group.template)}'). Bug/refactor plan templates are v2; a bug-type item should be a standalone seed.`,
		);
	}

	// description must be >= 50 chars (becomes sd sections.context)
	if (!group.description || group.description.trim().length < 50) {
		errors.push(
			`${prefix} plan group description must be >= 50 characters (it becomes sd sections.context); got ${group.description?.length ?? 0} chars`,
		);
	}

	// Units: min 2 (sd min_steps=2)
	if (!group.units || group.units.length < 2) {
		errors.push(
			`${prefix} plan group requires units.length >= 2 (got ${group.units?.length ?? 0}); use 'standalone' for single items`,
		);
		return; // Can't validate units if not enough
	}

	// Acceptance: min 1 (sd requires at least 1 acceptance criterion)
	if (!group.acceptance || group.acceptance.length < 1) {
		errors.push(`${prefix} plan group requires acceptance.length >= 1`);
	}

	// Build set of sibling unit logicalIds
	const siblingIds = new Set(group.units.map((u) => u.logicalId));

	// Validate each unit
	for (const unit of group.units) {
		const unitPrefix = `${prefix} unit '${unit.logicalId}':`;

		// Common unit fields
		if (!unit.title || unit.title.trim() === "") {
			errors.push(`${unitPrefix} title must be non-empty`);
		}
		if (!unit.description || unit.description.trim() === "") {
			errors.push(`${unitPrefix} description must be non-empty`);
		}
		if (!VALID_TYPES.has(unit.type)) {
			errors.push(`${unitPrefix} invalid type '${unit.type}'`);
		}
		if (typeof unit.priority !== "number" || unit.priority < 0 || unit.priority > 4) {
			errors.push(`${unitPrefix} priority must be 0..4`);
		}

		// dependsOn validation: no self-edges, no cross-group, no duplicates
		const seenDeps = new Set<string>();
		for (const dep of unit.dependsOn) {
			// Self-edge
			if (dep === unit.logicalId) {
				errors.push(`${unitPrefix} self-dependency on '${dep}' (no self-edges allowed)`);
				continue;
			}
			// Must be a sibling unit
			if (!siblingIds.has(dep)) {
				errors.push(
					`${unitPrefix} dependsOn '${dep}' is not a sibling unit in this plan (cross-group deps are v2)`,
				);
				continue;
			}
			// Duplicate dependsOn entry
			if (seenDeps.has(dep)) {
				errors.push(`${unitPrefix} duplicate dependsOn entry '${dep}'`);
				continue;
			}
			seenDeps.add(dep);
		}
	}

	// Cycle detection via DFS (Kahn's algorithm over adjacency list)
	detectCycles(group, prefix, errors);
}

function detectCycles(group: PlanGroup, prefix: string, errors: string[]): void {
	// Build adjacency list: dep → [units that depend on dep]
	const adj = new Map<string, string[]>();
	const inDegree = new Map<string, number>();

	for (const unit of group.units) {
		if (!adj.has(unit.logicalId)) {
			adj.set(unit.logicalId, []);
		}
		if (!inDegree.has(unit.logicalId)) {
			inDegree.set(unit.logicalId, 0);
		}
	}

	for (const unit of group.units) {
		for (const dep of unit.dependsOn) {
			// Only consider valid sibling deps (invalid ones already flagged)
			if (adj.has(dep)) {
				const neighbors = adj.get(dep);
				if (neighbors !== undefined) {
					neighbors.push(unit.logicalId);
				}
				const current = inDegree.get(unit.logicalId) ?? 0;
				inDegree.set(unit.logicalId, current + 1);
			}
		}
	}

	// Kahn's: queue nodes with in-degree 0
	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	let processed = 0;
	while (queue.length > 0) {
		const node = queue.shift();
		if (node === undefined) break;
		processed++;
		for (const neighbor of adj.get(node) ?? []) {
			const deg = (inDegree.get(neighbor) ?? 0) - 1;
			inDegree.set(neighbor, deg);
			if (deg === 0) queue.push(neighbor);
		}
	}

	if (processed < group.units.length) {
		errors.push(`${prefix} dependency cycle detected among units`);
	}
}
