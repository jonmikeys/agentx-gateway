import { SessionsView } from "@/app/(crm)/sessions/sessions-view";
import { listApiKeys } from "@/server/services/api-keys";
import { listRoutes } from "@/server/services/routes";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [apiKeys, routes] = await Promise.all([listApiKeys(), listRoutes()]);
  return (
    <SessionsView
      apiKeys={apiKeys.map((key) => ({ id: key.id, label: key.label }))}
      routes={routes.map((route) => route.slug)}
    />
  );
}
