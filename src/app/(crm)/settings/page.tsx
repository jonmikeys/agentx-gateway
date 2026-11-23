import { SettingsView } from "@/app/(crm)/settings/settings-view";
import { getSessionSettings } from "@/server/services/session-settings";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <SettingsView initial={await getSessionSettings()} />;
}
