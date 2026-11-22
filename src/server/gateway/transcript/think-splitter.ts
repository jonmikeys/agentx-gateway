const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

export interface SplitResult {
  text: string;
  reasoning: string;
}

/** Length of the longest suffix of `value` that is a proper prefix of `tag`. */
function partialTagSuffix(value: string, tag: string): number {
  const max = Math.min(value.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (tag.startsWith(value.slice(value.length - length))) return length;
  }
  return 0;
}

/**
 * Splits streamed assistant content into visible text and `<think>...</think>` reasoning.
 * Tags may be split across chunks; a possible partial tag is held back until it is resolved.
 */
export class ThinkTagSplitter {
  private buffer = "";
  private inThink = false;

  push(chunk: string): SplitResult {
    this.buffer += chunk;
    const out: SplitResult = { text: "", reasoning: "" };
    for (;;) {
      const tag = this.inThink ? CLOSE_TAG : OPEN_TAG;
      const index = this.buffer.indexOf(tag);
      if (index >= 0) {
        this.emit(out, this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      const hold = partialTagSuffix(this.buffer, tag);
      this.emit(out, this.buffer.slice(0, this.buffer.length - hold));
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      return out;
    }
  }

  /** Emits whatever is still buffered (an unterminated tag is plain content). */
  flush(): SplitResult {
    const out: SplitResult = { text: "", reasoning: "" };
    this.emit(out, this.buffer);
    this.buffer = "";
    return out;
  }

  private emit(out: SplitResult, value: string): void {
    if (this.inThink) out.reasoning += value;
    else out.text += value;
  }
}

/** One-shot split for complete (non-streamed) content. */
export function splitThinkTags(content: string): SplitResult {
  const splitter = new ThinkTagSplitter();
  const first = splitter.push(content);
  const rest = splitter.flush();
  return { text: first.text + rest.text, reasoning: first.reasoning + rest.reasoning };
}
