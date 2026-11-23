import { ProvidersView } from "@/app/(crm)/providers/providers-view";
import { listProviders } from "@/server/services/providers";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <ProvidersView providers={await listProviders()} />;
}
