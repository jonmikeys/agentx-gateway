import { DashboardView } from "@/app/(crm)/dashboard-view";
import { getDashboardStats } from "@/server/services/dashboard";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <DashboardView stats={await getDashboardStats()} />;
}
