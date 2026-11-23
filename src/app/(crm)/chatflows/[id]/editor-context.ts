"use client";

import { createContext, useContext } from "react";
import type { ValidationProblem } from "@/lib/agents/validate";

export interface EditorUiContext {
  problems: Map<string, ValidationProblem[]>;
  /** Node currently executing in the test drawer. */
  runningNodeId?: string;
  /** Node picked in the trace tab. */
  traceNodeId?: string;
  /** Small notices shown on a node card, e.g. a newer pinned subflow version. */
  nodeBadges?: Map<string, string>;
  onRename: (nodeId: string, title: string) => void;
}

export const EditorUi = createContext<EditorUiContext>({
  problems: new Map(),
  onRename: () => {},
});

export function useEditorUi(): EditorUiContext {
  return useContext(EditorUi);
}
