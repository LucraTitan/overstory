import { ChevronDown } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useId,
	useMemo,
	useState,
} from "react";

import { cn } from "@/lib/utils";

interface CollapsibleContextValue {
	open: boolean;
	setOpen: (next: boolean) => void;
	contentId: string;
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

function useCollapsible(): CollapsibleContextValue {
	const ctx = useContext(CollapsibleContext);
	if (ctx === null) {
		throw new Error("Collapsible subcomponents must be used inside <Collapsible>");
	}
	return ctx;
}

interface CollapsibleProps {
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
	children?: ReactNode;
}

function Collapsible({
	open: controlledOpen,
	defaultOpen = false,
	onOpenChange,
	className,
	children,
}: CollapsibleProps) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
	const isControlled = controlledOpen !== undefined;
	const open = isControlled ? controlledOpen : uncontrolledOpen;
	const contentId = useId();

	const setOpen = useCallback(
		(next: boolean) => {
			if (!isControlled) setUncontrolledOpen(next);
			onOpenChange?.(next);
		},
		[isControlled, onOpenChange],
	);

	const value = useMemo<CollapsibleContextValue>(
		() => ({ open, setOpen, contentId }),
		[open, setOpen, contentId],
	);

	return (
		<CollapsibleContext.Provider value={value}>
			<div data-slot="collapsible" data-state={open ? "open" : "closed"} className={className}>
				{children}
			</div>
		</CollapsibleContext.Provider>
	);
}

interface CollapsibleTriggerProps extends React.ComponentProps<"button"> {
	showChevron?: boolean;
}

function CollapsibleTrigger({
	className,
	children,
	showChevron = true,
	onClick,
	...props
}: CollapsibleTriggerProps) {
	const { open, setOpen, contentId } = useCollapsible();
	const state = open ? "open" : "closed";

	return (
		<button
			type="button"
			data-slot="collapsible-trigger"
			data-state={state}
			aria-expanded={open}
			aria-controls={contentId}
			onClick={(e) => {
				onClick?.(e);
				if (!e.defaultPrevented) setOpen(!open);
			}}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				className,
			)}
			{...props}
		>
			{children}
			{showChevron && (
				<ChevronDown
					data-state={state}
					className="size-3.5 transition-transform data-[state=open]:rotate-180"
				/>
			)}
		</button>
	);
}

function CollapsibleContent({ className, children, ...props }: React.ComponentProps<"div">) {
	const { open, contentId } = useCollapsible();
	if (!open) return null;
	return (
		<div
			id={contentId}
			data-slot="collapsible-content"
			data-state="open"
			className={className}
			{...props}
		>
			{children}
		</div>
	);
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsible };
