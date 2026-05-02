import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { EventType, StoredEvent } from "@/lib/ws";

// ── Category discrimination ─────────────────────────────────────────────────

type EventCategory = "error" | "tool_use" | "tool_result" | "assistant_message" | "generic";

const TEXT_TYPES: EventType[] = ["turn_start", "turn_end", "progress", "result"];

function getCategory(event: StoredEvent): EventCategory {
	if (event.level === "error" || event.eventType === "error") return "error";
	if (event.eventType === "tool_start") return "tool_use";
	if (event.eventType === "tool_end") return "tool_result";
	if (TEXT_TYPES.includes(event.eventType)) return "assistant_message";
	if (event.data) {
		try {
			const parsed = JSON.parse(event.data) as unknown;
			if (parsed && typeof parsed === "object" && "delta" in parsed) return "assistant_message";
		} catch {
			// not JSON — fall through to generic
		}
	}
	return "generic";
}

// ── Text extraction helper ──────────────────────────────────────────────────

function extractText(event: StoredEvent): string {
	if (!event.data) return "";
	try {
		const parsed = JSON.parse(event.data) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			"delta" in parsed &&
			typeof (parsed as { delta: unknown }).delta === "string"
		) {
			return (parsed as { delta: string }).delta;
		}
	} catch {
		// plain text
	}
	return event.data;
}

// ── Tool-args summary parser ────────────────────────────────────────────────

function parseSummary(toolArgs: string | null, toolName: string | null): string {
	if (toolArgs) {
		try {
			const parsed = JSON.parse(toolArgs) as unknown;
			if (
				parsed &&
				typeof parsed === "object" &&
				"summary" in parsed &&
				typeof (parsed as { summary: unknown }).summary === "string"
			) {
				return (parsed as { summary: string }).summary;
			}
		} catch {
			// fall through
		}
	}
	return toolName ?? "tool";
}

// ── Timestamp helper ────────────────────────────────────────────────────────

function formatTs(iso: string): string {
	try {
		return new Date(iso).toLocaleTimeString();
	} catch {
		return iso;
	}
}

// ── Sub-renderers ───────────────────────────────────────────────────────────

function ToolUseRow({ event }: { event: StoredEvent }) {
	const summary = parseSummary(event.toolArgs, event.toolName);
	return (
		<Card className="py-3 gap-2">
			<CardHeader className="px-4 pb-0 pt-0">
				<div className="flex items-center gap-2">
					<Badge variant="secondary">tool</Badge>
					<CardTitle className="text-xs font-mono font-normal truncate">{summary}</CardTitle>
					<span className="ml-auto text-xs text-muted-foreground shrink-0">
						{formatTs(event.createdAt)}
					</span>
				</div>
			</CardHeader>
		</Card>
	);
}

function ToolResultRow({ event }: { event: StoredEvent }) {
	const label = `${event.toolName ?? "tool"} OK${event.toolDurationMs != null ? ` ${event.toolDurationMs}ms` : ""}`;

	return (
		<Collapsible>
			<Card className="py-3 gap-2">
				<CardHeader className="px-4 pb-0 pt-0">
					<div className="flex items-center gap-2">
						<Badge variant="outline">result</Badge>
						<span className="text-xs text-muted-foreground font-mono">{label}</span>
						<CollapsibleTrigger className="ml-auto" />
					</div>
				</CardHeader>
				{event.data && (
					<CollapsibleContent>
						<CardContent className="px-4 pt-2">
							<CodeBlock variant="block">{event.data}</CodeBlock>
						</CardContent>
					</CollapsibleContent>
				)}
			</Card>
		</Collapsible>
	);
}

function AssistantMessageRow({ event }: { event: StoredEvent }) {
	const text = extractText(event);
	if (!text) return null;
	return (
		<Card className="py-3 gap-2">
			<CardHeader className="px-4 pb-0 pt-0">
				<div className="flex items-center gap-2">
					<Badge variant="outline">msg</Badge>
					<span className="ml-auto text-xs text-muted-foreground shrink-0">
						{formatTs(event.createdAt)}
					</span>
				</div>
			</CardHeader>
			<CardContent className="px-4 pt-1">
				<p className="text-sm whitespace-pre-wrap">{text}</p>
			</CardContent>
		</Card>
	);
}

function ErrorRow({ event }: { event: StoredEvent }) {
	const body = event.data ?? `${event.level} / ${event.eventType}`;
	return (
		<Card className="py-3 gap-2 border-destructive/60">
			<CardHeader className="px-4 pb-0 pt-0">
				<div className="flex items-center gap-2">
					<Badge variant="destructive">error</Badge>
					<span className="ml-auto text-xs text-muted-foreground shrink-0">
						{formatTs(event.createdAt)}
					</span>
				</div>
			</CardHeader>
			<CardContent className="px-4 pt-1">
				<p className="text-sm text-destructive whitespace-pre-wrap">{body}</p>
			</CardContent>
		</Card>
	);
}

function GenericRow({ event }: { event: StoredEvent }) {
	return (
		<Card className="py-3 gap-2">
			<CardHeader className="px-4 pb-0 pt-0">
				<div className="flex items-center gap-2">
					<Badge variant="outline">{event.eventType}</Badge>
					<Badge variant="secondary" className="text-xs">
						{event.level}
					</Badge>
					<span className="ml-auto text-xs text-muted-foreground shrink-0">
						{formatTs(event.createdAt)}
					</span>
				</div>
			</CardHeader>
		</Card>
	);
}

// ── Public component ────────────────────────────────────────────────────────

export function EventRow({ event }: { event: StoredEvent }) {
	const category = getCategory(event);
	switch (category) {
		case "error":
			return <ErrorRow event={event} />;
		case "tool_use":
			return <ToolUseRow event={event} />;
		case "tool_result":
			return <ToolResultRow event={event} />;
		case "assistant_message":
			return <AssistantMessageRow event={event} />;
		default:
			return <GenericRow event={event} />;
	}
}
