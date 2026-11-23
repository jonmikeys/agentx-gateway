import { notFound } from "next/navigation";
import { ChatflowEditor } from "@/app/(crm)/chatflows/[id]/chatflow-editor";
import { getFlow } from "@/server/services/agents";
import { listCameras } from "@/server/services/cameras";
import { listAllowedMcpTools, listMcpServers } from "@/server/services/mcp";
import { listMedia, listMediaTags } from "@/server/services/media";
import { listRoutes } from "@/server/services/routes";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let flow: Awaited<ReturnType<typeof getFlow>>;
  try {
    flow = await getFlow(id);
  } catch {
    notFound();
  }
  const [routes, servers, tools, media, mediaTags, cameras] = await Promise.all([
    listRoutes(),
    listMcpServers(),
    listAllowedMcpTools(),
    listMedia({ enabled: true }),
    listMediaTags(),
    listCameras(),
  ]);
  return (
    <ChatflowEditor
      initialFlow={flow}
      routes={routes.map((route) => route.slug)}
      mcpServers={servers.map((server) => ({
        id: server.id,
        name: server.name,
        slug: server.slug,
        enabled: server.enabled,
      }))}
      mcpTools={tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        exposed_name: tool.exposed_name,
        server_id: tool.server_id,
        server_name: tool.server_name,
      }))}
      media={media.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        tags: item.tags,
      }))}
      mediaTags={mediaTags}
      cameras={cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        enabled: camera.enabled,
      }))}
    />
  );
}
