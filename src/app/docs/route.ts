import { OPENAPI_PATH } from "@/server/api/openapi";

/**
 * Scalar API reference for the client API. The page sits behind AdminAuth (`src/proxy.ts` guards
 * every path outside the client API), loads the bundle vendored by `scripts/vendor-scalar.mjs`
 * (no CDN) and renders the public `GET /v1/openapi.json`. Scalar's hosted services (fonts,
 * telemetry, AI agent, MCP) are switched off so nothing leaves the gateway.
 */
export const runtime = "nodejs";
export const dynamic = "force-static";

const config = {
  url: OPENAPI_PATH,
  theme: "default",
  layout: "modern",
  withDefaultFonts: false,
  telemetry: false,
  showDeveloperTools: "never",
  agent: { disabled: true },
  mcp: { disabled: true },
  documentDownloadType: "json",
  metaData: { title: "API reference | AGENTX Gateway" },
};

// Follows the CRM theme (next-themes stores "light" | "dark" | "system" under "theme").
const bootScript = `(() => {
  let theme = "system";
  try { theme = localStorage.getItem("theme") || "system"; } catch {}
  const dark = theme === "dark" ||
    (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  Scalar.createApiReference("#app", { ...${JSON.stringify(config)}, darkMode: dark });
})();`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>API reference | AGENTX Gateway</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      .scalar-app { --scalar-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        --scalar-font-code: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script src="/vendor/scalar/standalone.js"></script>
    <script>${bootScript}</script>
  </body>
</html>
`;

export function GET(): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
