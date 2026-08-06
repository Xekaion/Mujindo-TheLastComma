import GameCanvas from "./GameCanvas";
import WorldAnnouncementBanner from "./WorldAnnouncementBanner";
import { getChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return (
    <>
      <WorldAnnouncementBanner suggestedName={user?.displayName ?? null} />
      <GameCanvas />
    </>
  );
}
