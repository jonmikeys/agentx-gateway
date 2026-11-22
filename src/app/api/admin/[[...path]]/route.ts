import { handle } from "hono/vercel";
import { adminApp } from "@/server/api/admin-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = handle(adminApp);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
