import GameEntryFlow from "./GameEntryFlow";
import RoomDoorShowcase from "./RoomDoorShowcase";
import WorldAnnouncementBanner from "./WorldAnnouncementBanner";
import { getChatGPTUser } from "./chatgpt-auth";
import { headers } from "next/headers";
import { resolveRoomDoorShowcaseRequest } from "./room-door-showcase";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps = {}) {
  const query = searchParams ? await searchParams : {};
  if (typeof query.roomDoorShowcase === "string") {
    const requestHeaders = await headers();
    const showcase = resolveRoomDoorShowcaseRequest(
      query,
      requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
    );
    if (showcase) return <RoomDoorShowcase {...showcase} />;
  }

  const user = await getChatGPTUser();
  const localVfxShowcaseRequested =
    query.enemyVfxShowcase !== undefined || query.lootVfxShowcase !== undefined ||
    query.plazaMotionShowcase !== undefined;
  return (
    <>
      <WorldAnnouncementBanner suggestedName={user?.displayName ?? null} />
      <GameEntryFlow
        accountName={user?.displayName ?? null}
        returnToTown={query.town === "1"}
        localVfxShowcaseRequested={localVfxShowcaseRequested}
      />
    </>
  );
}
