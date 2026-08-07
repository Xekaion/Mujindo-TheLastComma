import { getChatGPTUser } from "../chatgpt-auth";
import MarketBoard from "./MarketBoard";
import "./market.css";

export const dynamic = "force-dynamic";

export default async function MarketPage() {
  const user = await getChatGPTUser();

  return <MarketBoard suggestedName={user?.displayName ?? null} />;
}
