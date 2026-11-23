/**
 * Incremental Server-Sent Events parser. Handles chunk boundaries inside lines,
 * `\r\n` / `\r` / `\n` line endings, comment lines (`:`) and multi-line `data:` fields.
 */
export interface SseEvent {
  event?: string;
  data: string;
}

export const SSE_DONE = "[DONE]";

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private skipLeadingLf = false;

  /** Feeds decoded text and returns the events it completed. */
  push(text: string): SseEvent[] {
    let input = text;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (input.startsWith("\n")) input = input.slice(1);
    }
    this.buffer += input;
    const events: SseEvent[] = [];
    let start = 0;
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char !== "\n" && char !== "\r") continue;
      const line = this.buffer.slice(start, index);
      if (char === "\r") {
        if (this.buffer[index + 1] === "\n") index += 1;
        else if (index + 1 === this.buffer.length) this.skipLeadingLf = true;
      }
      start = index + 1;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /** Flushes a trailing event that was not terminated by a blank line. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.processLine(this.buffer);
      this.buffer = "";
      if (event) events.push(event);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      return undefined;
    }
    const event: SseEvent = { data: this.dataLines.join("\n"), event: this.eventName };
    this.dataLines = [];
    this.eventName = undefined;
    return event;
  }
}

/** Serializes one SSE data event; multi-line payloads become multiple `data:` lines. */
export function formatSse(data: string): string {
  const lines = data.split("\n").map((line) => `data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** Serializes a named SSE event (`event:` line plus one `data:` line per payload line). */
export function formatSseEvent(event: string, data: string): string {
  return `event: ${event}\n${formatSse(data)}`;
}
