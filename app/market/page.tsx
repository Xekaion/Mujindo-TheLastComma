import { getChatGPTUser } from "../chatgpt-auth";
import WorldAnnouncementBanner from "../WorldAnnouncementBanner";
import MarketBoard from "./MarketBoard";
import "./market.css";

export const dynamic = "force-dynamic";

export default async function MarketPage() {
  const user = await getChatGPTUser();

  return (
    <>
      <WorldAnnouncementBanner suggestedName={user?.displayName ?? null} />
      <MarketBoard suggestedName={user?.displayName ?? null} />
    </>
  );
}
