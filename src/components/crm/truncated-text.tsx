import { cn } from "cn";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Single-line text that truncates with an ellipsis and shows the full value in a tooltip.
 * Use it for user-supplied strings (names, URLs, model names) inside table cells and badges so a
 * long value never widens the page or pushes row actions out of view.
 */
export function TruncatedText({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("block min-w-0 truncate", className)}>{children ?? text}</span>
      </TooltipTrigger>
      <TooltipContent className="break-all">{text}</TooltipContent>
    </Tooltip>
  );
}
