import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { z } from "zod";
import { PublicFetchError, publicFetch, readCapped } from "@/server/net/public-fetch";
import { type BuiltinTool, needsSearch } from "@/server/tools/builtin/types";

export const READ_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const READ_PAGE_TIMEOUT_MS = 10_000;
export const READ_PAGE_MAX_CHARS = 8000;
/** Below this many characters a page counts as thin (probably needs JavaScript). */
const THIN_PAGE_CHARS = 200;

export const WEB_USER_AGENT = "Mozilla/5.0 (compatible; AGENTX-Gateway/0.1; +web-search)";

const argsSchema = z.object({
  url: z
    .string()
    .trim()
    .refine((value) => /^https?:\/\//i.test(value), "url must start with http:// or https://"),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ReadWebPageArgs = z.infer<typeof argsSchema>;

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "application/json", "text/csv"]);

/** Keeps paragraph breaks, collapses other whitespace. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 0)
    .join("\n\n");
}

/** Readable text of an HTML document: Readability first, the whole body as a fallback. */
export function extractHtml(
  bytes: Buffer,
  contentType: string,
  url: string,
): { title: string; text: string } {
  const virtualConsole = new VirtualConsole();
  // Scripts never run and no subresources load (jsdom defaults); the console stays silent.
  const dom = new JSDOM(bytes, { url, contentType, virtualConsole });
  try {
    const document = dom.window.document;
    const pageTitle = document.title.trim();
    const article = new Readability(document.cloneNode(true) as Document).parse();
    const articleText = normalizeText(article?.textContent ?? "");
    if (articleText.length >= THIN_PAGE_CHARS) {
      return { title: article?.title?.trim() || pageTitle, text: articleText };
    }
    for (const node of document.querySelectorAll("script, style, noscript, template")) {
      node.remove();
    }
    const bodyText = normalizeText(document.body?.textContent ?? "");
    return {
      title: pageTitle,
      text: bodyText.length > articleText.length ? bodyText : articleText,
    };
  } finally {
    dom.window.close();
  }
}

/** One window of `text` starting at `offset`, ending on whitespace when possible. */
export function pageWindow(
  text: string,
  offset: number,
  maxChars = READ_PAGE_MAX_CHARS,
): { content: string; nextOffset: number | null } {
  if (offset >= text.length) return { content: "", nextOffset: null };
  let end = Math.min(offset + maxChars, text.length);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    const paragraph = text.lastIndexOf("\n", end);
    const cut = Math.max(space, paragraph);
    if (cut > offset + maxChars * 0.8) end = cut;
  }
  return {
    content: text.slice(offset, end).trim(),
    nextOffset: end < text.length ? end : null,
  };
}

export const readWebPageTool: BuiltinTool<ReadWebPageArgs> = {
  name: "read_web_page",
  description:
    `Read the main text of a web page (for example a web_search result). Returns at most ` +
    `${READ_PAGE_MAX_CHARS} characters; when next_offset is not null, call again with ` +
    `offset=next_offset to continue. Does not run JavaScript, so app-like pages may return ` +
    `little or no text.`,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) address of the page." },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Character offset to continue from (next_offset of the previous call).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  args: argsSchema,
  availability: needsSearch,
  async execute(args, context) {
    const timeout = AbortSignal.timeout(READ_PAGE_TIMEOUT_MS);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    let fetched: Awaited<ReturnType<typeof publicFetch>>;
    let body: { bytes: Buffer; truncated: boolean };
    try {
      fetched = await publicFetch(args.url, {
        signal,
        headers: {
          "User-Agent": WEB_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      if (!fetched.response.ok) {
        await fetched.response.body?.cancel();
        return {
          text: `Error: the page answered HTTP ${fetched.response.status}.`,
          isError: true,
        };
      }
      body = await readCapped(fetched.response, READ_PAGE_MAX_BYTES);
    } catch (error) {
      if (error instanceof PublicFetchError)
        return { text: `Error: ${error.message}`, isError: true };
      if (timeout.aborted)
        return { text: "Error: The site did not answer in time.", isError: true };
      throw error;
    }

    const contentType = fetched.response.headers.get("content-type") ?? "text/html";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    let title = "";
    let text: string;
    if (HTML_TYPES.has(mime)) {
      ({ title, text } = extractHtml(body.bytes, contentType, fetched.url));
    } else if (TEXT_TYPES.has(mime) || mime.startsWith("text/")) {
      text = normalizeText(body.bytes.toString("utf8"));
    } else {
      return {
        text: `Error: the address is a ${mime || "binary"} file, not a web page read_web_page can read.`,
        isError: true,
      };
    }

    const window = pageWindow(text, args.offset);
    const result: Record<string, unknown> = {
      url: fetched.url,
      title,
      offset: args.offset,
      next_offset: window.nextOffset,
      total_chars: text.length,
      content: window.content,
    };
    if (text.length < THIN_PAGE_CHARS) {
      result.note =
        "The page returned little or no text. It probably needs JavaScript, which read_web_page does not run.";
    } else if (body.truncated) {
      result.note = "The page is larger than 2 MB; only the first 2 MB were read.";
    } else if (args.offset >= text.length) {
      result.note = "The offset is past the end of the page.";
    }
    return { text: JSON.stringify(result), isError: false };
  },
};
