import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { guardAdminRequest } from "@/server/auth/admin-auth";
import { EnvValidationError } from "@/server/env";

/**
 * Guards every CRM page and `/api/admin/*` with AdminAuth (HTTP Basic in G1).
 * The client API (`/v1`, `/agents`) and `/health` are excluded by the matcher below;
 * they have their own authentication. Runs on the Node.js runtime.
 */
export async function proxy(request: NextRequest) {
  try {
    const result = await guardAdminRequest(request);
    if ("response" in result) return result.response;
    return NextResponse.next();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return new Response("Gateway is misconfigured. Check the server logs.", { status: 500 });
    }
    throw error;
  }
}

export const config = {
  matcher: [
    "/((?!v1(?:/|$)|agents(?:/|$)|health(?:/|$)|_next/|favicon\\.ico$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)",
  ],
};
