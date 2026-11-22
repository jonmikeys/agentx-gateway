import { ApiKeysView } from "@/app/(crm)/api-keys/api-keys-view";
import { listApiKeys } from "@/server/services/api-keys";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <ApiKeysView apiKeys={await listApiKeys()} />;
}
