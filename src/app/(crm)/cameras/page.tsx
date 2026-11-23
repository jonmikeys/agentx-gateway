import { CamerasView } from "@/app/(crm)/cameras/cameras-view";
import { listCameras, toCameraView } from "@/server/services/cameras";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <CamerasView cameras={(await listCameras()).map(toCameraView)} />;
}
