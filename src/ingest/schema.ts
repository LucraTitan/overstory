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
	description: string;
	acceptance: string[];
	template: "feature" | "bug" | "refactor";
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
	planId: string;
	units: Record<string, string>; // logicalId → seedId
}

export type ManifestGroupEntry = ManifestStandaloneEntry | ManifestPlanEntry;

export interface ManifestSourceEntry {
	contentHash: string;
	ingestedAt: string; // ISO8601
	groups: ManifestGroupEntry[];
}

export interface IngestionManifest {
	schemaVersion: 1;
	sources: Record<string, ManifestSourceEntry>; // source path → entry
}
