import { McpView } from "@/app/(crm)/mcp/mcp-view";
import { listMcpServers, listMcpTools } from "@/server/services/mcp";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [servers, tools] = await Promise.all([listMcpServers(), listMcpTools()]);
  return <McpView servers={servers} tools={tools} />;
}
