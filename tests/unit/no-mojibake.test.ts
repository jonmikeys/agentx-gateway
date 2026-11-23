import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the Shift-JIS mojibake that shell redirection introduced once: the UTF-8
 * middle dot was saved as halfwidth-katakana bytes and the section sign likewise. Fails if any
 * source, test or doc file contains the replacement character or those byte sequences.
 */
const BAD = [
  { char: String.fromCodePoint(0xfffd), label: "replacement character U+FFFD" },
  { char: String.fromCodePoint(0xff82), label: "halfwidth katakana U+FF82 (mojibake lead byte)" },
  { char: String.fromCodePoint(0xff77), label: "halfwidth katakana U+FF77 (mojibake tail)" },
  { char: String.fromCodePoint(0xff67), label: "halfwidth katakana U+FF67 (mojibake tail)" },
];
const TEXT_FILE = /\.(ts|tsx|mts|cts|js|mjs|md|json|css|sql|yml|yaml)$/;
const ROOTS = ["src", "tests", "e2e", "docs"];

function walk(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "screenshots" || entry === "node_modules") continue;
      walk(full, files);
      continue;
    }
    if (TEXT_FILE.test(entry)) files.push(full);
  }
}

describe("source text encoding", () => {
  it("contains no mojibake or replacement characters", () => {
    const textFiles: string[] = [];
    for (const root of ROOTS) walk(root, textFiles);
    textFiles.push("README.md", "AGENTS.md");

    const offenders: string[] = [];
    for (const file of textFiles) {
      const text = readFileSync(file, "utf8");
      for (const { char, label } of BAD) {
        let index = text.indexOf(char);
        while (index >= 0) {
          const line = text.slice(0, index).split(/\r?\n/).length;
          offenders.push(`${file}:${line} ${label}`);
          index = text.indexOf(char, index + 1);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
