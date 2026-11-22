import { Hono } from "hono";
import { getDashboardStats } from "@/server/services/dashboard";

export function createDashboardApp(): Hono {
  const app = new Hono();
  app.get("/", async (c) => c.json(await getDashboardStats()));
  return app;
}
