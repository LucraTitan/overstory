/**
 * Manifest read/write and pure classification functions.
 *
 * Pure functions (classifySource, hashContent) are separated from
 * file I/O so unit tests don't touch the filesystem.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentError } from "../errors.ts";
import type { IngestionManifest } from "./schema.ts";

export type SourceClassification = "new" | "unchanged" | "changed";

/**
 * Compute sha256:<hex> hash of bytes.
 * Pure — no I/O.
 */
export function hashContent(bytes: Buffer): string {
	const hex = createHash("sha256").update(bytes).digest("hex");
	return `sha256:${hex}`;
}

/**
 * Classify a source path relative to the manifest.
 * Pure — no I/O.
 *
 * If the existing entry has `partial:true` (a prior apply failed mid-way), always return
 * "changed" so the caller takes the reconcile path — regardless of whether the hash matches.
 */
export function classifySource(
	manifest: IngestionManifest,
	path: string,
	contentHash: string,
): SourceClassification {
	const entry = manifest.sources[path];
	if (entry === undefined) return "new";
	// Partial entry: force reconcile so missing groups are created on re-run (never no-op).
	if (entry.partial === true) return "changed";
	return entry.contentHash === contentHash ? "unchanged" : "changed";
}

/**
 * Load manifest from disk. Returns an empty manifest if the file doesn't exist.
 * B7: wraps JSON parse failure in an AgentError with a clear message.
 */
export async function loadManifest(manifestPath: string): Promise<IngestionManifest> {
	let raw: string;
	try {
		raw = await readFile(manifestPath, "utf8");
	} catch (err: unknown) {
		// ENOENT → fresh manifest
		if (
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return { schemaVersion: 1, sources: {} };
		}
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		// B7: corrupt manifest — throw a clear AgentError instead of a raw SyntaxError stack trace
		const detail = err instanceof SyntaxError ? err.message : String(err);
		throw new AgentError(
			`Manifest at '${manifestPath}' is corrupt (JSON parse failed): ${detail}. ` +
				"Delete or repair the manifest file before re-running.",
		);
	}

	// FIX 3: shape validation — valid JSON but wrong shape crashes later at manifest.sources[path].
	// Validate required fields; throw AgentError with a clear message instead of a late TypeError.
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("schemaVersion" in (parsed as object)) ||
		typeof (parsed as Record<string, unknown>).sources !== "object" ||
		(parsed as Record<string, unknown>).sources === null ||
		Array.isArray((parsed as Record<string, unknown>).sources)
	) {
		throw new AgentError(
			`Manifest at '${manifestPath}' has an invalid shape (expected {schemaVersion, sources: {...}}). ` +
				"Delete or repair the manifest file before re-running.",
		);
	}

	return parsed as IngestionManifest;
}

/**
 * Write manifest to disk, creating parent dirs as needed.
 */
export async function saveManifest(
	manifestPath: string,
	manifest: IngestionManifest,
): Promise<void> {
	await mkdir(dirname(manifestPath), { recursive: true });
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}
