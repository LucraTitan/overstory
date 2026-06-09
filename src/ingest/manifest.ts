/**
 * Manifest read/write and pure classification functions.
 *
 * Pure functions (classifySource, hashContent) are separated from
 * file I/O so unit tests don't touch the filesystem.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
 */
export function classifySource(
	manifest: IngestionManifest,
	path: string,
	contentHash: string,
): SourceClassification {
	const entry = manifest.sources[path];
	if (entry === undefined) return "new";
	return entry.contentHash === contentHash ? "unchanged" : "changed";
}

/**
 * Load manifest from disk. Returns an empty manifest if the file doesn't exist.
 */
export async function loadManifest(manifestPath: string): Promise<IngestionManifest> {
	try {
		const raw = await readFile(manifestPath, "utf8");
		return JSON.parse(raw) as IngestionManifest;
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
