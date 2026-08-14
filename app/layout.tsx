import type { Metadata } from "next";
import { headers } from "next/headers";
import GameAudioProvider from "./GameAudioProvider";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3003";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "무진도: 마지막 쉼표";
  const description =
    "끝없이 이어지는 방에서 50종 증강을 각각 20단계까지 쌓고 접사·전설 장비를 조합하는 2D 탑다운 액션 RPG.";

  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: {
      icon: "/favicon.png",
      shortcut: "/favicon.png",
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [
        {
          url: new URL("/og.png", origin).toString(),
          width: 1680,
          height: 941,
          alt: "무진도의 끝없는 지도와 균열을 마주한 하린",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [new URL("/og.png", origin).toString()],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="game-viewport" data-game-aspect="16:9">
        <GameAudioProvider>{children}</GameAudioProvider>
      </body>
    </html>
  );
}
