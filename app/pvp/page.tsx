import WorldAnnouncementBanner from "../WorldAnnouncementBanner";
import { getChatGPTUser } from "../chatgpt-auth";
import PvpArena from "./PvpArena";

export const dynamic = "force-dynamic";

export default async function PvpPage() {
  const user = await getChatGPTUser();
  return (
    <>
      <WorldAnnouncementBanner suggestedName={user?.displayName ?? null} />
      <PvpArena suggestedName={user?.displayName ?? null} />
    </>
  );
}
