import { describe, expect, it } from "vitest";
import { checkPublicUrl, isPublicAddress, PublicFetchError } from "@/server/net/public-fetch";
import {
  extractHtml,
  normalizeText,
  pageWindow,
  READ_PAGE_MAX_CHARS,
} from "@/server/tools/builtin/read-web-page";

describe("public address policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "[::1]",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.215.14", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    ["ftp://example.com/", "invalid_url"],
    ["https://user:pass@example.com/", "invalid_url"],
    ["http://127.0.0.1:3000/", "blocked_address"],
    ["http://[::1]/", "blocked_address"],
    ["http://localhost:8080/", "blocked_address"],
    ["http://api.localhost/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data", "blocked_address"],
    ["not a url", "invalid_url"],
  ])("rejects %s", (url, code) => {
    try {
      checkPublicUrl(url);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PublicFetchError);
      expect((error as PublicFetchError).code).toBe(code);
    }
  });

  it("accepts public http(s) names", () => {
    expect(checkPublicUrl("https://example.com/a?b=1").hostname).toBe("example.com");
  });
});

describe("page text", () => {
  it("keeps paragraphs and collapses whitespace", () => {
    expect(normalizeText("  one\n two  \n\n\n three\r\n\r\nfour ")).toBe(
      "one two\n\nthree\n\nfour",
    );
  });

  it("windows long text on whitespace and reports the next offset", () => {
    const text = Array.from({ length: 3000 }, (_, index) => `word${index}`).join(" ");
    const first = pageWindow(text, 0);
    expect(first.content.length).toBeLessThanOrEqual(READ_PAGE_MAX_CHARS);
    expect(first.nextOffset).not.toBeNull();
    expect(text[first.nextOffset as number]).toBe(" ");
    const second = pageWindow(text, first.nextOffset as number);
    expect(second.content.startsWith("word")).toBe(true);
    expect(pageWindow("short", 0)).toEqual({ content: "short", nextOffset: null });
    expect(pageWindow("short", 10)).toEqual({ content: "", nextOffset: null });
  });

  it("extracts the article with Readability", () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, index) =>
        `<p>Red pandas paragraph ${index} talks about bamboo, trees, and the eastern Himalayas in detail.</p>`,
    ).join("");
    const html = `<html><head><title>Red pandas</title></head><body>
      <nav>Home | About | Contact</nav>
      <article><h1>All about red pandas</h1>${paragraphs}</article>
      <footer>Copyright</footer><script>alert("x")</script></body></html>`;
    const { title, text } = extractHtml(
      Buffer.from(html),
      "text/html; charset=utf-8",
      "https://example.org/red-pandas",
    );
    expect(title).toBe("Red pandas");
    expect(text).toContain("Red pandas paragraph 0");
    expect(text).toContain("paragraph 7");
    expect(text).not.toContain("alert");
  });

  it("returns little text for a JavaScript-only page", () => {
    const html =
      '<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>';
    const { text } = extractHtml(Buffer.from(html), "text/html", "https://app.example/");
    expect(text).toBe("");
  });

  it("decodes the declared charset", () => {
    const html = Buffer.concat([
      Buffer.from('<html><head><meta charset="iso-8859-1"><title>Caf'),
      Buffer.from([0xe9]),
      Buffer.from("</title></head><body><p>x</p></body></html>"),
    ]);
    expect(extractHtml(html, "text/html", "https://example.org/").title).toBe("Café");
  });
});
