import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { StoredEvent } from "@/lib/ws";
import { EventRow } from "@/routes/agent/EventRow";

export type PendingStatus = "pending" | "stalled";

interface PendingBubbleProps {
	clientToken: string;
	workEvents: StoredEvent[];
	status: PendingStatus;
}

const HEADER_PENDING = "Coordinator is working…";
const HEADER_STALLED = "Stalled";

export function PendingBubble({ workEvents, status }: PendingBubbleProps) {
	const defaultCollapsed = workEvents.length >= 5;
	const [open, setOpen] = useState(!defaultCollapsed);

	const stalled = status === "stalled";
	const now = useTickWhile(stalled, 10_000);
	const startedAt = workEvents[0]?.createdAt;
	const elapsedLabel = stalled && startedAt ? formatElapsed(now - Date.parse(startedAt)) : null;
	const lastTool = lastToolName(workEvents);
	const lastPreview = lastEventPreview(workEvents);
	const eventCount = workEvents.length;

	return (
		<Card className="py-3 gap-2 max-w-[85%] mr-auto border-dashed border-border">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CardHeader className="px-4 pb-0 pt-0">
					<div className="flex items-center gap-2">
						<Spinner stalled={stalled} />
						<span className="text-xs text-muted-foreground font-medium">
							{stalled ? HEADER_STALLED : HEADER_PENDING}
						</span>
						{stalled && (elapsedLabel || lastTool) && (
							<span className="text-xs text-muted-foreground/80 font-mono truncate">
								{[elapsedLabel, lastTool ? `last: ${lastTool}` : null].filter(Boolean).join(" · ")}
							</span>
						)}
						{eventCount > 0 && (
							<CollapsibleTrigger className="ml-auto self-start">
								{open ? "Hide" : `${eventCount} ${eventCount === 1 ? "event" : "events"}`}
							</CollapsibleTrigger>
						)}
					</div>
				</CardHeader>
				{eventCount > 0 && !open && lastPreview && (
					<CardContent className="px-4 pt-0">
						<span className="block text-xs text-muted-foreground/80 font-mono truncate">
							↳ {lastPreview}
						</span>
					</CardContent>
				)}
				{eventCount > 0 && (
					<CollapsibleContent>
						<CardContent className="px-4 pt-0 flex flex-col gap-2">
							{workEvents.map((event) => (
								<EventRow key={event.id} event={event} />
							))}
						</CardContent>
					</CollapsibleContent>
				)}
			</Collapsible>
		</Card>
	);
}

function Spinner({ stalled }: { stalled: boolean }) {
	const color = stalled ? "border-muted-foreground" : "border-primary";
	return (
		<span
			aria-hidden="true"
			className={`inline-block align-middle size-3 rounded-full border-2 ${color} border-t-transparent animate-spin motion-reduce:animate-none`}
		/>
	);
}

function useTickWhile(active: boolean, intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [active, intervalMs]);
	return now;
}

function formatElapsed(ms: number): string | null {
	if (!Number.isFinite(ms) || ms < 0) return null;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMin = minutes % 60;
	return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function lastToolName(events: StoredEvent[]): string | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev?.eventType === "tool_start" && ev.toolName) return ev.toolName;
	}
	return null;
}

function lastEventPreview(events: StoredEvent[]): string | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (!ev) continue;
		if (ev.eventType === "tool_start") {
			const summary = parseSummaryFromArgs(ev.toolArgs);
			return summary ?? ev.toolName ?? "tool";
		}
		if (ev.eventType === "tool_end") {
			const ms = ev.toolDurationMs != null ? ` (${ev.toolDurationMs}ms)` : "";
			return `${ev.toolName ?? "tool"} done${ms}`;
		}
	}
	return null;
}

function parseSummaryFromArgs(toolArgs: string | null): string | null {
	if (!toolArgs) return null;
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
	return null;
}
