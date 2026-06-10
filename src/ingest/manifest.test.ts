/**
 * Tests for the manifest module.
 * Tests: classifySource (new/unchanged/changed), hashContent determinism, B7 corrupt manifest.
 * File I/O is thin and separable from pure functions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySource, hashContent, loadManifest } from "./manifest.ts";
import type { IngestionManifest } from "./schema.ts";

// --- hashContent ---

describe("hashContent", () => {
	test("returns sha256:<hex> format", () => {
		const hash = hashContent(Buffer.from("hello world"));
		expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("deterministic: same bytes → same hash", () => {
		const bytes = Buffer.from("test content");
		expect(hashContent(bytes)).toBe(hashContent(bytes));
	});

	test("different bytes → different hash", () => {
		const h1 = hashContent(Buffer.from("content A"));
		const h2 = hashContent(Buffer.from("content B"));
		expect(h1).not.toBe(h2);
	});

	test("empty bytes produce a valid hash", () => {
		const hash = hashContent(Buffer.from(""));
		expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

// --- classifySource ---

describe("classifySource", () => {
	const emptyManifest: IngestionManifest = {
		schemaVersion: 1,
		sources: {},
	};

	const populatedManifest: IngestionManifest = {
		schemaVersion: 1,
		sources: {
			"docs/prd.md": {
				contentHash: "sha256:abc123",
				ingestedAt: "2026-06-09T12:00:00Z",
				groups: [],
			},
		},
	};

	test("path not in manifest → 'new'", () => {
		const result = classifySource(emptyManifest, "docs/prd.md", "sha256:abc123");
		expect(result).toBe("new");
	});

	test("path in manifest, same hash → 'unchanged'", () => {
		const result = classifySource(populatedManifest, "docs/prd.md", "sha256:abc123");
		expect(result).toBe("unchanged");
	});

	test("path in manifest, different hash → 'changed'", () => {
		const result = classifySource(populatedManifest, "docs/prd.md", "sha256:different");
		expect(result).toBe("changed");
	});

	test("path in manifest but different path key → 'new'", () => {
		const result = classifySource(populatedManifest, "docs/other.md", "sha256:abc123");
		expect(result).toBe("new");
	});

	test("entry with partial:true and MATCHING hash → 'changed' (not 'unchanged')", () => {
		// This is the core regression guard: a partial entry with the same hash must NOT no-op.
		const partialManifest: IngestionManifest = {
			schemaVersion: 1,
			sources: {
				"docs/prd.md": {
					contentHash: "sha256:abc123",
					ingestedAt: "2026-06-09T12:00:00Z",
					groups: [],
					partial: true,
				},
			},
		};
		const result = classifySource(partialManifest, "docs/prd.md", "sha256:abc123");
		expect(result).toBe("changed");
	});

	test("entry with partial:true and DIFFERENT hash → 'changed'", () => {
		const partialManifest: IngestionManifest = {
			schemaVersion: 1,
			sources: {
				"docs/prd.md": {
					contentHash: "sha256:abc123",
					ingestedAt: "2026-06-09T12:00:00Z",
					groups: [],
					partial: true,
				},
			},
		};
		const result = classifySource(partialManifest, "docs/prd.md", "sha256:different");
		expect(result).toBe("changed");
	});
});

// --- B7: corrupt manifest → clear AgentError ---

describe("loadManifest — B7: corrupt JSON throws AgentError with clear message", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-manifest-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("corrupt manifest file throws AgentError (not raw SyntaxError)", async () => {
		const corruptPath = join(tempDir, "corrupt-manifest.json");
		await writeFile(corruptPath, "{ this is not valid json }", "utf8");

		let thrownError: unknown;
		try {
			await loadManifest(corruptPath);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		// Must be an AgentError with a clear message, not a raw SyntaxError
		const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
		expect(msg).toContain("corrupt");
		expect(msg).toContain("JSON parse");
	});

	test("non-existent manifest returns empty manifest (not an error)", async () => {
		const missingPath = join(tempDir, "no-such-manifest.json");
		const result = await loadManifest(missingPath);
		expect(result.schemaVersion).toBe(1);
		expect(result.sources).toEqual({});
	});
});
