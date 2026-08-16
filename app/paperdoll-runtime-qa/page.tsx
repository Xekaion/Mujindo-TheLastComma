import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  isLocalPaperdollRuntimeQaHost,
  resolvePaperdollRuntimeQaAutorun,
  resolvePaperdollRuntimeQaCompositeInitialIndex,
  resolvePaperdollRuntimeQaInitialIndex,
  resolvePaperdollRuntimeQaMode,
} from "../paperdoll-runtime-qa";
import PaperdollRuntimeQa from "./PaperdollRuntimeQa";

export const dynamic = "force-dynamic";

type PaperdollRuntimeQaPageProps = Readonly<{
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>;

export default async function PaperdollRuntimeQaPage({
  searchParams,
}: PaperdollRuntimeQaPageProps = {}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (!isLocalPaperdollRuntimeQaHost(host)) notFound();

  const query = searchParams ? await searchParams : {};
  const mode = resolvePaperdollRuntimeQaMode(query);
  return (
    <PaperdollRuntimeQa
      initialIndex={
        mode === "composite"
          ? resolvePaperdollRuntimeQaCompositeInitialIndex(query)
          : resolvePaperdollRuntimeQaInitialIndex(query)
      }
      initialAutorun={resolvePaperdollRuntimeQaAutorun(query)}
      mode={mode}
    />
  );
}
