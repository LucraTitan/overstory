/**
 * Type definitions for the ingest normalized-plan JSON and ingestion manifest.
 * Schema version 1, per 2026-06-09-ingest-contract.md.
 */

// --- Source span (traceability) ---

export interface SourceSpan {
	start: number;
	end: number;
}

// --- Confidence ---

export type Confidence = "high" | "low";

// --- Unit (child of a plan group) ---

export interface NormalizedUnit {
	logicalId: string;
	title: string;
	type: "task" | "bug" | "feature" | "epic";
	priority: 0 | 1 | 2 | 3 | 4;
	description: string;
	acceptance: string[];
	dependsOn: string[]; // logical ids of OTHER units in the same plan
	sourceSpan: SourceSpan;
	confidence: Confidence;
}

// --- Group (top-level item) ---

export interface StandaloneGroup {
	kind: "standalone";
	logicalId: string;
	title: string;
	type: "task" | "bug" | "feature" | "epic";
	priority: 0 | 1 | 2 | 3 | 4;
	description: string;
	acceptance: string[];
	sourceSpan: SourceSpan;
	confidence: Confidence;
}

export interface PlanGroup {
	kind: "plan";
	logicalId: string;
	title: string;
	type: "task" | "bug" | "feature" | "epic";
	priority: 0 | 1 | 2 | 3 | 4;
	description: string; // becomes sd sections.context; MUST be >= 50 chars
	acceptance: string[];
	template: "feature"; // v1: feature ONLY (bug/refactor require reproduction+root_cause which can't be synthesized)
	approach?: string; // → sd sections.approach; if absent/empty, renderer synthesizes fallback
	sourceSpan: SourceSpan;
	confidence: Confidence;
	units: NormalizedUnit[]; // min 2 required
}

export type NormalizedGroup = StandaloneGroup | PlanGroup;

// --- Ambiguity ---

export interface Ambiguity {
	logicalId: string;
	issue: string;
}

// --- Top-level normalized plan (skill → engine) ---

export interface NormalizedPlan {
	schemaVersion: 1;
	source: {
		path: string; // repo-relative path of the ingested doc
		contentHash: string; // sha256:<hex>
	};
	groups: NormalizedGroup[];
	ambiguities: Ambiguity[];
}

// --- Manifest types ---

export interface ManifestStandaloneEntry {
	logicalId: string;
	kind: "standalone";
	seedId: string;
}

export interface ManifestPlanEntry {
	logicalId: string;
	kind: "plan";
	seedId: string; // parent seed id
	/**
	 * Present once sd plan submit has succeeded. Absent (pending) when the parent seed was
	 * created but plan submit failed mid-apply — the partial manifest records the seedId so a
	 * re-run can ADOPT the existing parent and retry the submit (no duplicate orphan parent).
	 */
	planId?: string;
	/** logicalId → seedId map. Empty / absent on a pending entry (plan submit not yet done). */
	units: Record<string, string>; // logicalId → seedId
}

export type ManifestGroupEntry = ManifestStandaloneEntry | ManifestPlanEntry;

export interface ManifestSourceEntry {
	contentHash: string;
	ingestedAt: string; // ISO8601
	groups: ManifestGroupEntry[];
	/** Set when a prior apply failed mid-way; forces the next run to reconcile. */
	partial?: true;
}

export interface IngestionManifest {
	schemaVersion: 1;
	sources: Record<string, ManifestSourceEntry>; // source path → entry
}
