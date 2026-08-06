export const SPENT_SHELTER_MESSAGE =
  "이미 기억을 남긴 쉼터입니다 · 체력 회복과 기억 고정은 다시 일어나지 않습니다.";

/**
 * The visited-coordinate ledger is already persisted in every save, including
 * legacy ones, so it is also the canonical one-use shelter ledger.
 */
export function isFirstShelterRest(
  roomKind: string,
  alreadyVisited: boolean,
): boolean {
  return roomKind === "shelter" && !alreadyVisited;
}
