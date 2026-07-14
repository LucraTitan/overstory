import { describe, expect, test } from "bun:test";
import { parseReviewVerdict } from "./review-verdict.ts";

describe("parseReviewVerdict", () => {
	test("recognizes a PASS verdict in the standard subject format", () => {
		expect(parseReviewVerdict("Worker done: task-1 — PASS")).toBe("pass");
	});

	test("recognizes a FAIL verdict in the standard subject format", () => {
		expect(parseReviewVerdict("Worker done: task-1 — FAIL")).toBe("fail");
	});

	test("is case-insensitive", () => {
		expect(parseReviewVerdict("worker done: task-1 - pass")).toBe("pass");
		expect(parseReviewVerdict("worker done: task-1 - fail")).toBe("fail");
	});

	test("returns unknown when neither token is present", () => {
		expect(parseReviewVerdict("Worker done: task-1")).toBe("unknown");
	});

	test("returns unknown for a subject with no terminal dash-token (not fail-closed to a substring match)", () => {
		// HIGH-4: the old substring matcher treated this as "fail" because FAIL
		// appears somewhere in the text; the fixed matcher requires an anchored
		// "— PASS"/"— FAIL" token at the END of the subject, per
		// agents/reviewer.md's actual protocol, and returns "unknown" here.
		expect(parseReviewVerdict("PASS but actually FAIL on review")).toBe("unknown");
	});

	test("rejects BYPASS as a false-positive PASS (HIGH-4)", () => {
		expect(parseReviewVerdict("Worker done: task-1 — BYPASS")).toBe("unknown");
	});

	test("rejects PASSING as a false-positive PASS (HIGH-4)", () => {
		expect(parseReviewVerdict("Worker done: task-1 — PASSING")).toBe("unknown");
	});

	test("rejects FAILURE as a false-positive FAIL (HIGH-4)", () => {
		expect(parseReviewVerdict("Worker done: task-1 — FAILURE")).toBe("unknown");
	});

	test("accepts trailing whitespace after the token", () => {
		expect(parseReviewVerdict("Worker done: task-1 — PASS  ")).toBe("pass");
	});

	test("recognizes the real deployed reviewer.md subject format ('Review: <topic> - PASS/FAIL')", () => {
		expect(parseReviewVerdict("Review: task-1 - PASS")).toBe("pass");
		expect(parseReviewVerdict("Review: task-1 - FAIL")).toBe("fail");
	});

	test("falls back to the body when the subject has no verdict token (finding A)", () => {
		expect(
			parseReviewVerdict("Worker done: task-1", "Detailed review notes.\nVerdict — PASS"),
		).toBe("pass");
		expect(
			parseReviewVerdict("Worker done: task-1", "Detailed review notes.\nVerdict — FAIL"),
		).toBe("fail");
	});

	test("prefers the subject's verdict over the body's when both are present", () => {
		expect(parseReviewVerdict("Worker done: task-1 — FAIL", "unrelated notes — PASS")).toBe("fail");
	});

	test("returns unknown when neither subject nor body carries a verdict token", () => {
		expect(parseReviewVerdict("Worker done: task-1", "no verdict here")).toBe("unknown");
	});

	test("body fallback is still rejected for a false-positive substring (BYPASS)", () => {
		expect(parseReviewVerdict("Worker done: task-1", "we should BYPASS this check")).toBe(
			"unknown",
		);
	});

	test("finding 1: a multi-line body resolves to the LAST verdict token, not the first line that happens to end in one", () => {
		// Previously the `m` flag let `$` match at every line ending, and
		// `.match()` returned the FIRST match -- an early "- PASS" line won even
		// when the true final line asserted "FAIL". The fix drops `m` and
		// anchors to the true (trimmed) end of the string, so the LAST line's
		// verdict always wins.
		expect(parseReviewVerdict("Worker done: task-1", "- PASS\nFinal verdict — FAIL")).toBe("fail");
	});

	test("finding 1: subject verdict is anchored to the true end even with trailing whitespace/newline", () => {
		expect(parseReviewVerdict("Review: task-1 - PASS\n")).toBe("pass");
	});
});
