import { describe, expect, it } from "vitest";
import { selectRoute } from "@/server/services/routes";

describe("selectRoute", () => {
  it("uses the default route when model is absent, empty or 'default'", () => {
    for (const model of [undefined, null, "", "   ", "default", "DEFAULT", 42]) {
      expect(selectRoute(model)).toEqual({ kind: "default" });
    }
  });

  it("selects a route by slug", () => {
    expect(selectRoute("avatar-default")).toEqual({ kind: "slug", slug: "avatar-default" });
    expect(selectRoute(" fast ")).toEqual({ kind: "slug", slug: "fast" });
  });
});
