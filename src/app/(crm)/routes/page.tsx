import { RoutesView } from "@/app/(crm)/routes/routes-view";
import { listAllowedMcpTools } from "@/server/services/mcp";
import { listProviders } from "@/server/services/providers";
import { listRoutes } from "@/server/services/routes";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [routes, providers, mcpTools] = await Promise.all([
    listRoutes(),
    listProviders(),
    listAllowedMcpTools(),
  ]);
  return <RoutesView routes={routes} providers={providers} mcpTools={mcpTools} />;
}
