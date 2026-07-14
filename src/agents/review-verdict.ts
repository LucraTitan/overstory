/**
 * Parse a reviewer's terminal mail for its PASS/FAIL verdict.
 *
 * Reviewers send a terminal mail with the verdict embedded literally in the
 * subject line, e.g. `"Worker done: <task-id> — PASS"` /
 * `"Worker done: <task-id> — FAIL"`, or (this repo's actual deployed
 * `.overstory/agent-defs/reviewer.md` template) `"Review: <topic> - PASS"` /
 * `"- FAIL"`. The subject is the primary, structured signal; a `body`
 * fallback is accepted (finding A) for a template that puts the verdict
 * token in the body instead.
 */
export type ReviewVerdict = "pass" | "fail" | "unknown";

/**
 * An em dash or hyphen, optional whitespace, then EXACTLY the token "PASS" or
 * "FAIL" and nothing else before the end of the (trimmed) string.
 * Case-insensitive. Deliberately NO `m` flag: `$` matches only the true end
 * of the string, never at an internal line ending. This is the finding-1 fix
 * — a multi-line body like `"- PASS\nFinal verdict — FAIL"` must resolve to
 * the LAST verdict (FAIL), not the first line that happens to end in a
 * verdict token. Callers must `.trim()` the subject/body before matching (see
 * `parseReviewVerdict`) so a trailing newline doesn't shift the true end.
 *
 * Deliberately NOT a substring match (HIGH-4 fix): `.includes("PASS")`
 * previously matched "BYPASS" and "PASSING" as false positives, which could
 * authorize a merge off text that never actually asserted a clean pass.
 * Anchoring the token to the end of the string (`$`) rejects both —
 * "BYPASS" doesn't start with "PASS" at the matched position, and "PASSING"
 * has trailing characters after "PASS" that the `$` anchor disallows.
 */
const VERDICT_TOKEN_PATTERN = /(?:—|-)\s*(PASS|FAIL)\s*$/i;

/**
 * Extract the verdict from a reviewer's terminal mail.
 *
 * Requires an exact, end-anchored "PASS" or "FAIL" token at the true end of
 * the (trimmed) subject or body — a bare substring anywhere in the text is
 * never sufficient, and an earlier verdict-shaped line before the real final
 * line is never sufficient either (finding 1). Checks `subject` first; if it
 * has no matching token, falls back to `body` when provided (finding A — some
 * reviewer templates put the verdict there instead). No match in either is
 * `"unknown"`; callers must treat `"unknown"` as inconclusive (never a
 * default pass) — a drive loop that can't unambiguously confirm a pass must
 * not merge.
 */
export function parseReviewVerdict(subject: string, body?: string): ReviewVerdict {
	const subjectMatch = subject.trim().match(VERDICT_TOKEN_PATTERN);
	if (subjectMatch?.[1]) {
		return subjectMatch[1].toUpperCase() === "FAIL" ? "fail" : "pass";
	}
	if (body !== undefined) {
		const bodyMatch = body.trim().match(VERDICT_TOKEN_PATTERN);
		if (bodyMatch?.[1]) {
			return bodyMatch[1].toUpperCase() === "FAIL" ? "fail" : "pass";
		}
	}
	return "unknown";
}
