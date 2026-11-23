import { MediaLibrary } from "@/app/(crm)/media/media-library";
import { listMedia, listMediaTags, toMediaView } from "@/server/services/media";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [rows, tags] = await Promise.all([listMedia(), listMediaTags()]);
  return <MediaLibrary items={rows.map(toMediaView)} tags={tags} />;
}
