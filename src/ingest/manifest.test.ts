/**
 * Tests for the manifest module.
 * Tests: classifySource (new/unchanged/changed), hashContent determinism.
 * File I/O is thin and separable from pure functions.
 */

import { describe, expect, test } from "bun:test";
import { classifySource, hashContent } from "./manifest.ts";
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
});
