"use client";

import { type NodeProps, NodeResizer } from "@xyflow/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEditorUi } from "@/app/(crm)/chatflows/[id]/editor-context";
import type { EditorNode } from "@/app/(crm)/chatflows/[id]/flow-editor-utils";
import type { NoteColor, NoteNodeData } from "@/lib/agents/graph";
import { cn } from "@/lib/utils";

const tone: Record<NoteColor, string> = {
  yellow: "bg-note-yellow border-note-yellow-border",
  blue: "bg-note-blue border-note-blue-border",
  green: "bg-note-green border-note-green-border",
  pink: "bg-note-pink border-note-pink-border",
  grey: "bg-note-grey border-note-grey-border",
};

/** Canvas-only sticky note: safe Markdown, resizable, edited by double-clicking the canvas node. */
export function NoteNode({ id, data, selected }: NodeProps<EditorNode>) {
  const note = data as NoteNodeData;
  const { onUpdateNodeData, editingNoteId, onEditNote } = useEditorUi();
  const editing = editingNoteId === id;

  return (
    <div
      data-testid={`flow-note-${id}`}
      data-node-type="note"
      className={cn(
        "h-full w-full rounded-md border text-foreground shadow-sm",
        tone[note.color],
        selected && "ring-2 ring-ring",
      )}
    >
      <NodeResizer
        minWidth={160}
        minHeight={110}
        isVisible={selected}
        lineClassName="border-ring"
        handleClassName="bg-ring"
      />
      <div className="flex h-full w-full flex-col gap-1 overflow-hidden p-2">
        <input
          aria-label="Note title"
          className="nodrag nopan w-full rounded-sm bg-transparent text-xs font-semibold outline-none focus:bg-background/40"
          value={note.title}
          onChange={(event) => onUpdateNodeData(id, { title: event.target.value })}
        />
        {editing ? (
          <textarea
            aria-label="Note text"
            // biome-ignore lint/a11y/noAutofocus: opening the note editor is an explicit double-click.
            autoFocus
            className="nodrag nopan nowheel min-h-16 flex-1 resize-none rounded-sm bg-background/40 p-1 text-xs outline-none"
            placeholder="Write Markdown…"
            value={note.markdown}
            onChange={(event) => onUpdateNodeData(id, { markdown: event.target.value })}
            onBlur={() => onEditNote(undefined)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onEditNote(undefined);
            }}
          />
        ) : (
          <div className="nodrag nowheel min-h-0 flex-1 overflow-auto break-words text-xs [&_code]:font-mono [&_h1]:text-sm [&_h1]:font-semibold [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
            {note.markdown.trim() ? (
              <Markdown remarkPlugins={[remarkGfm]}>{note.markdown}</Markdown>
            ) : (
              <span className="text-muted-foreground">Double-click to edit</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
