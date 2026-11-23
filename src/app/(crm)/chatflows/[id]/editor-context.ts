"use client";

import { createContext, useContext } from "react";
import type { GraphDiff } from "@/lib/agents/diff";
import type { ValidationProblem } from "@/lib/agents/validate";

export interface EditorUiContext {
  problems: Map<string, ValidationProblem[]>;
  /** Node currently executing in the test drawer. */
  runningNodeId?: string;
  /** Node picked in the trace tab. */
  traceNodeId?: string;
  /** Small notices shown on a node card, e.g. a newer pinned subflow version. */
  nodeBadges?: Map<string, string>;
  /** Toolbar toggle: hides sticky notes and node comment badges. */
  hideAnnotations: boolean;
  /** Sticky note currently open in the inline Markdown editor. */
  editingNoteId?: string;
  /** Version-vs-draft highlight; undefined when not comparing. */
  diff?: GraphDiff;
  /** Number of direct children of a visual group. */
  groupChildCount: (groupId: string) => number;
  onRename: (nodeId: string, title: string) => void;
  onUpdateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  onToggleCollapse: (groupId: string) => void;
  onEditNote: (noteId: string | undefined) => void;
  /** Extracts a group's children into a new subflow and opens its draft. */
  onConvertGroup: (groupId: string) => void;
}

export const EditorUi = createContext<EditorUiContext>({
  problems: new Map(),
  hideAnnotations: false,
  groupChildCount: () => 0,
  onRename: () => {},
  onUpdateNodeData: () => {},
  onToggleCollapse: () => {},
  onEditNote: () => {},
  onConvertGroup: () => {},
});

export function useEditorUi(): EditorUiContext {
  return useContext(EditorUi);
}
