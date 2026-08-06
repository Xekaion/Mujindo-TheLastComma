/// <reference types="@cloudflare/workers-types" />

/** Cloudflare Worker entry point for Mujindo's Vinext app and realtime arena. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

export { RealtimeWorld } from "./realtime-world";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  REALTIME_WORLD: DurableObjectNamespace;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/realtime/")) {
      if (!env.REALTIME_WORLD) {
        return Response.json(
          { error: "realtime_unavailable", message: "실시간 결투 서버가 준비되지 않았습니다." },
          { status: 503 },
        );
      }
      const headers = new Headers(request.headers);
      if (url.pathname === "/api/realtime/session") {
        const encodedFullName = headers.get("oai-authenticated-user-full-name");
        const encoding = headers.get("oai-authenticated-user-full-name-encoding");
        const email = headers.get("oai-authenticated-user-email");
        let trustedName: string | null = null;
        if (encodedFullName && encoding === "percent-encoded-utf-8") {
          try {
            trustedName = decodeURIComponent(encodedFullName);
          } catch {
            trustedName = null;
          }
        }
        trustedName ??= email?.split("@")[0] ?? null;
        if (trustedName) headers.set("x-mujindo-player-name", trustedName);
      }
      const realtimeRequest = new Request(request, { headers });
      const realtimeId = env.REALTIME_WORLD.idFromName("mujindo-global-v1");
      return env.REALTIME_WORLD.get(realtimeId).fetch(realtimeRequest);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
