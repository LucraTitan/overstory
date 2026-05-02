import { cva, type VariantProps } from "class-variance-authority";
import { Check, Copy } from "lucide-react";
import { type HTMLAttributes, isValidElement, type ReactNode, useState } from "react";

import { cn } from "@/lib/utils";

const codeBlockVariants = cva("font-mono", {
	variants: {
		variant: {
			inline: "inline rounded bg-muted px-1.5 py-0.5 text-xs leading-relaxed",
			block:
				"relative block rounded-md bg-muted p-3 text-[13px] leading-relaxed max-h-80 overflow-auto whitespace-pre-wrap break-all group",
		},
	},
	defaultVariants: {
		variant: "inline",
	},
});

function flattenChildren(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(flattenChildren).join("");
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode };
		return flattenChildren(props.children);
	}
	return "";
}

type CodeBlockProps = Omit<HTMLAttributes<HTMLElement>, "children"> &
	VariantProps<typeof codeBlockVariants> & { children?: ReactNode };

function CodeBlock({ className, variant, children, ...props }: CodeBlockProps) {
	const resolvedVariant = variant ?? "inline";

	if (resolvedVariant === "inline") {
		return (
			<code
				data-slot="code-block"
				data-variant="inline"
				className={cn(codeBlockVariants({ variant: "inline" }), className)}
				{...props}
			>
				{children}
			</code>
		);
	}

	return (
		<pre
			data-slot="code-block"
			data-variant="block"
			className={cn(codeBlockVariants({ variant: "block" }), className)}
			{...props}
		>
			{children}
			<CopyButton getText={() => flattenChildren(children)} />
		</pre>
	);
}

function CopyButton({ getText }: { getText: () => string }) {
	const [copied, setCopied] = useState(false);

	const handleClick = () => {
		const text = getText();
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<button
			type="button"
			aria-label={copied ? "Copied" : "Copy to clipboard"}
			onClick={handleClick}
			className="absolute top-2 right-2 inline-flex items-center justify-center rounded-md p-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
		</button>
	);
}

export { CodeBlock, codeBlockVariants };
