"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { invalidReferences, type VariableSuggestion } from "@/lib/agents/templates";
import { cn } from "@/lib/utils";

interface TemplateFieldProps {
  value: string;
  onChange: (value: string) => void;
  variables: VariableSuggestion[];
  knownNodeIds: string[];
  placeholder?: string;
  rows?: number;
  label?: string;
  multiline?: boolean;
  className?: string;
}

/**
 * Text field with `{{…}}` autocomplete and invalid-reference feedback. Insertion only ever
 * appends a dotted path, never executes anything (templates are interpolated server-side).
 */
export function TemplateField({
  value,
  onChange,
  variables,
  knownNodeIds,
  placeholder,
  rows = 4,
  label,
  multiline = true,
  className,
}: TemplateFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const element = () => (multiline ? textareaRef.current : inputRef.current);

  const query = useMemo(() => {
    const before = value.slice(0, caret);
    const open = before.lastIndexOf("{{");
    const closed = before.lastIndexOf("}}");
    if (open < 0 || open < closed) return null;
    return before.slice(open + 2).trim();
  }, [value, caret]);

  const suggestions = useMemo(() => {
    if (query === null) return [];
    return variables
      .filter((suggestion) => suggestion.path.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8);
  }, [query, variables]);

  const invalid = useMemo(() => invalidReferences(value, knownNodeIds), [value, knownNodeIds]);

  function choose(path: string) {
    const node = element();
    const before = value.slice(0, caret);
    const open = before.lastIndexOf("{{");
    if (open < 0) return;
    const after = value.slice(caret);
    const suffix = after.startsWith("}}") ? after.slice(2) : `}}${after}`;
    const next = `${value.slice(0, open + 2)}${path}${suffix}`;
    onChange(next);
    const position = open + 2 + path.length + 2;
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  const shared = {
    value,
    placeholder,
    "aria-label": label ?? placeholder,
    "aria-invalid": invalid.length > 0,
    "aria-describedby": invalid.length > 0 ? `${listId}-invalid` : undefined,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(event.target.value);
      setCaret(event.target.selectionStart ?? event.target.value.length);
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCaret(event.currentTarget.selectionStart ?? 0),
    onClick: (event: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setCaret(event.currentTarget.selectionStart ?? 0),
    className: cn("font-mono text-xs", className),
  };

  return (
    <div className="relative grid gap-1.5">
      {label && <span className="text-xs font-medium text-muted-foreground">{label}</span>}
      {multiline ? (
        <Textarea ref={textareaRef} rows={rows} {...shared} />
      ) : (
        <Input ref={inputRef} {...shared} />
      )}
      {focused && suggestions.length > 0 && (
        <ul
          id={listId}
          aria-label="Template variables"
          className="absolute top-full z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((suggestion) => (
            <li key={suggestion.path}>
              <button
                type="button"
                className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none"
                aria-label={`Insert ${suggestion.path}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(suggestion.path);
                }}
              >
                <span className="font-mono">{suggestion.label}</span>
                <span className="text-muted-foreground">{suggestion.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {invalid.length > 0 && (
        <p id={`${listId}-invalid`} className="text-xs text-destructive">
          Unknown reference{invalid.length > 1 ? "s" : ""}: {invalid.join(", ")}
        </p>
      )}
    </div>
  );
}
