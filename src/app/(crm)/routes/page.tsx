import { RoutesView } from "@/app/(crm)/routes/routes-view";
import { listProviders } from "@/server/services/providers";
import { listRoutes } from "@/server/services/routes";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [routes, providers] = await Promise.all([listRoutes(), listProviders()]);
  return <RoutesView routes={routes} providers={providers} />;
}
