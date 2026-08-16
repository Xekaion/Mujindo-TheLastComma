import WorldAnnouncementBanner from "../WorldAnnouncementBanner";
import { getChatGPTUser } from "../chatgpt-auth";
import { isLocalPvpShowcaseRequest } from "../pvp-showcase";
import { headers } from "next/headers";
import PvpArena from "./PvpArena";

export const dynamic = "force-dynamic";

type PvpPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function PvpPage({ searchParams }: PvpPageProps = {}) {
  const query = searchParams ? await searchParams : {};
  const requestHeaders = await headers();
  const localShowcase = isLocalPvpShowcaseRequest(
    query.pvpShowcase,
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
  );
  const user = localShowcase ? null : await getChatGPTUser();
  return (
    <>
      {!localShowcase && (
        <WorldAnnouncementBanner suggestedName={user?.displayName ?? null} />
      )}
      <PvpArena suggestedName={user?.displayName ?? null} />
    </>
  );
}
