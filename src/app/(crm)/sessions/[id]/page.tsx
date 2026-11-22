import { notFound } from "next/navigation";
import { SessionDetailView } from "@/app/(crm)/sessions/[id]/session-detail-view";
import { findSessionDetail } from "@/server/services/session-queries";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await findSessionDetail(id);
  if (!session) notFound();
  return <SessionDetailView initial={session} />;
}
