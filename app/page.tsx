import GameEntryFlow from "./GameEntryFlow";
import WorldAnnouncementBanner from "./WorldAnnouncementBanner";
import { getChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps = {}) {
  const user = await getChatGPTUser();
  const query = searchParams ? await searchParams : {};
  const localVfxShowcaseRequested =
    query.enemyVfxShowcase !== undefined || query.lootVfxShowcase !== undefined;
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
