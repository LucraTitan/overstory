import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { StoredEvent } from "@/lib/ws";

import { PendingBubble } from "./PendingBubble";

export type TurnKind = "operator" | "coordinator" | "system";

export interface ChatTurn {
	kind: TurnKind;
	id: string;
	subject: string;
	body: string;
	createdAt: string;
	threadId: string | null;
	pending?: {
		clientToken: string;
		workEvents: StoredEvent[];
		status: "pending" | "stalled";
	};
}

interface ThreadProps {
	turns: ChatTurn[];
}

const PIN_THRESHOLD_PX = 50;

export function Thread({ turns }: ThreadProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const isAtBottomRef = useRef(true);
	const lastTurnCountRef = useRef(turns.length);
	const [unseenCount, setUnseenCount] = useState(0);
	const [pinned, setPinned] = useState(true);

	const getViewport = useCallback((): HTMLElement | null => {
		return (
			containerRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null
		);
	}, []);

	const scrollToBottom = useCallback(() => {
		const viewport = getViewport();
		if (!viewport) return;
		viewport.scrollTop = viewport.scrollHeight;
		isAtBottomRef.current = true;
		setPinned(true);
		setUnseenCount(0);
	}, [getViewport]);

	useEffect(() => {
		const viewport = getViewport();
		if (!viewport) return;
		const onScroll = () => {
			const { scrollHeight, scrollTop, clientHeight } = viewport;
			const atBottom = scrollHeight - scrollTop - clientHeight < PIN_THRESHOLD_PX;
			isAtBottomRef.current = atBottom;
			setPinned(atBottom);
			if (atBottom) setUnseenCount(0);
		};
		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => viewport.removeEventListener("scroll", onScroll);
	}, [getViewport]);

	useEffect(() => {
		const prevCount = lastTurnCountRef.current;
		lastTurnCountRef.current = turns.length;
		if (turns.length === 0) return;
		if (isAtBottomRef.current) {
			const viewport = getViewport();
			if (viewport) viewport.scrollTop = viewport.scrollHeight;
			return;
		}
		const added = turns.length - prevCount;
		if (added > 0) setUnseenCount((n) => n + added);
	}, [turns, getViewport]);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "End") return;
			const target = e.target as HTMLElement | null;
			// Allow End to behave normally inside text inputs.
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
				if (!(e.metaKey || e.ctrlKey)) return;
			}
			if (e.metaKey || e.ctrlKey || target?.tagName !== "INPUT") {
				e.preventDefault();
				scrollToBottom();
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [scrollToBottom]);

	return (
		<div ref={containerRef} className="flex-1 min-h-0 relative">
			<ScrollArea className="h-full">
				<div className="px-6 py-5 flex flex-col gap-4 max-w-4xl mx-auto">
					{turns.map((turn) => (
						<TurnBubble key={turn.pending?.clientToken ?? turn.id} turn={turn} />
					))}
				</div>
			</ScrollArea>
			{!pinned && unseenCount > 0 && (
				<button
					type="button"
					onClick={scrollToBottom}
					aria-label={`Scroll to ${unseenCount} new ${unseenCount === 1 ? "message" : "messages"}`}
					className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 rounded-full border border-border bg-popover text-popover-foreground px-3 py-1.5 text-xs font-medium shadow-md hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ArrowDown aria-hidden="true" className="size-3.5" />
					<span>
						{unseenCount} new {unseenCount === 1 ? "message" : "messages"}
					</span>
				</button>
			)}
		</div>
	);
}

function TurnBubble({ turn }: { turn: ChatTurn }) {
	if (turn.pending !== undefined && turn.kind === "coordinator") {
		return (
			<PendingBubble
				clientToken={turn.pending.clientToken}
				workEvents={turn.pending.workEvents}
				status={turn.pending.status}
			/>
		);
	}

	const align =
		turn.kind === "operator" ? "ml-auto" : turn.kind === "system" ? "mx-auto" : "mr-auto";
	const bubbleClasses =
		turn.kind === "operator"
			? "bg-primary text-primary-foreground shadow-sm"
			: turn.kind === "system"
				? "bg-muted/60 text-muted-foreground border border-dashed border-border"
				: "bg-card border border-border shadow-sm";

	const ts = new Date(turn.createdAt);
	const tsAbsolute = ts.toLocaleString();
	const tsRelative = ts.toLocaleTimeString();

	return (
		<div className={`max-w-[85%] ${align} flex flex-col gap-1`}>
			{turn.subject !== "" && turn.kind !== "system" && (
				<span className="text-xs text-muted-foreground px-1 font-medium">{turn.subject}</span>
			)}
			<div className={`rounded-xl px-4 py-3 ${bubbleClasses}`}>
				<pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{turn.body}</pre>
			</div>
			<time
				dateTime={turn.createdAt}
				title={tsAbsolute}
				className="text-xs text-muted-foreground px-1"
			>
				{tsRelative}
			</time>
		</div>
	);
}
