import { ChatflowsView } from "@/app/(crm)/chatflows/chatflows-view";
import { listFlows } from "@/server/services/agents";

export const dynamic = "force-dynamic";

export default async function Page() {
  const flows = await listFlows();
  return <ChatflowsView flows={flows} />;
}
