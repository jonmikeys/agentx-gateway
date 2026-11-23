"use client";

import { X } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { TruncatedText } from "@/components/crm/truncated-text";
import { Badge } from "@/components/ui/badge";
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "@/lib/media-schemas";

/**
 * Chip input for tags. Enter, comma or Tab (with text) adds a tag; Backspace on an empty field
 * removes the last one. `suggestions` populate a native datalist.
 */
export function TagsInput({
  id,
  value,
  onChange,
  suggestions = [],
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();

  function commit(text: string) {
    const added = normalizeTags(text.split(","));
    if (added.length > 0) onChange(normalizeTags([...value, ...added]).slice(0, MAX_TAGS));
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Tab" && draft.trim()) {
      commit(draft);
    } else if (event.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex min-h-8 w-full min-w-0 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="max-w-full gap-1 pr-1">
          <TruncatedText text={tag} className="max-w-full" />
          <button
            type="button"
            className="rounded-full p-0.5 hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(value.filter((existing) => existing !== tag))}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        id={id}
        aria-label={ariaLabel}
        className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        value={draft}
        maxLength={MAX_TAG_LENGTH}
        list={listId}
        placeholder={value.length === 0 ? "Type a tag, press Enter" : ""}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && commit(draft)}
      />
      <datalist id={listId}>
        {suggestions
          .filter((tag) => !value.includes(tag))
          .map((tag) => (
            <option key={tag} value={tag} />
          ))}
      </datalist>
    </div>
  );
}
