import { describe, expect, it } from "vitest";
import { allPages, findPageLocation, navGroups } from "@/components/app-shell/nav";

describe("nav definition", () => {
  it("has the six groups in order", () => {
    expect(navGroups.map((group) => group.title)).toEqual([
      "Overview",
      "Conversations",
      "Agents",
      "Media Content",
      "Models & Integrations",
      "Administration",
    ]);
  });

  it("lists the expected pages and hrefs", () => {
    expect(allPages.map((page) => [page.title, page.href])).toEqual([
      ["Dashboard", "/"],
      ["Sessions", "/sessions"],
      ["Chatflows", "/chatflows"],
      ["Media", "/media"],
      ["Cameras", "/cameras"],
      ["Providers", "/providers"],
      ["Model Routes", "/routes"],
      ["MCP Servers", "/mcp"],
      ["API Keys", "/api-keys"],
      ["Settings", "/settings"],
    ]);
  });

  it("has unique ids and hrefs, absolute paths, and no clash with API routes", () => {
    const groupIds = navGroups.map((group) => group.id);
    expect(new Set(groupIds).size).toBe(groupIds.length);
    const hrefs = allPages.map((page) => page.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(href.startsWith("/")).toBe(true);
      expect(href).not.toMatch(/^\/(v1|agents|health|api\/admin)(\/|$)/);
    }
  });

  it("gives every page a description and a delivery stage", () => {
    for (const page of allPages) {
      expect(page.description.length).toBeGreaterThan(10);
      expect(page.stage).toMatch(/^G\d/);
    }
  });

  it("resolves locations for exact and nested paths", () => {
    expect(findPageLocation("/")?.page.title).toBe("Dashboard");
    expect(findPageLocation("/sessions")?.group.title).toBe("Conversations");
    expect(findPageLocation("/sessions/abc")?.page.title).toBe("Sessions");
    expect(findPageLocation("/providers/")?.page.title).toBe("Providers");
    expect(findPageLocation("/nope")).toBeUndefined();
  });
});
