const LOCAL_PVP_SHOWCASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

export function isLocalPvpShowcaseHost(host: string | null | undefined) {
  const normalized = (host ?? "").trim().toLowerCase();
  return (
    LOCAL_PVP_SHOWCASE_HOSTS.has(normalized) ||
    normalized.startsWith("localhost:") ||
    normalized.startsWith("127.0.0.1:") ||
    normalized.startsWith("[::1]:")
  );
}

export function isLocalPvpShowcaseRequest(
  mode: string | string[] | null | undefined,
  host: string | null | undefined,
) {
  return mode === "match" && isLocalPvpShowcaseHost(host);
}
