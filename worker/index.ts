/// <reference types="@cloudflare/workers-types" />

/** Cloudflare Worker entry point for Mujindo's Vinext app and realtime arena. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  authorizeRealtimeEconomyRequest,
  handleEconomyRequest,
  type EconomyD1Env,
} from "./economy-d1";
import { handleRealtimeRequest } from "./realtime-d1";

interface Env extends EconomyD1Env {
  ASSETS: Fetcher;
  DB?: D1Database;
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
    const headers = new Headers(request.headers);
    const rawDevUser = headers.get("x-mujindo-dev-user");

    // Never let callers supply an internal identity or a realtime display name.
    // Platform identity headers remain edge-owned; our synthesized headers are
    // deleted first and then reconstructed from those trusted inputs only.
    headers.delete("x-mujindo-player-name");
    headers.delete("x-mujindo-dev-user");
    headers.delete("x-mujindo-internal-dev-user");
    headers.delete("x-mujindo-platform-player-name");
    headers.delete("x-mujindo-account-id");

    const localHost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    const origin = request.headers.get("origin");
    const localSameOrigin =
      localHost &&
      ((origin !== null && (() => {
        try { return new URL(origin).origin === url.origin; } catch { return false; }
      })()) || request.headers.get("sec-fetch-site") === "same-origin");
    if (localSameOrigin && (rawDevUser === "A" || rawDevUser === "B")) {
      headers.set("x-mujindo-internal-dev-user", rawDevUser);
    }

    // Economy identity never comes from caller-visible hosting headers. Remote
    // users must establish a server-verified Steam session; local A/B demo
    // identity is reconstructed above only for a same-origin localhost request.
    let trustedName: string | null = null;

    const sanitizedRequest = new Request(request, { headers });

    if (url.pathname.startsWith("/api/economy/")) {
      return handleEconomyRequest(sanitizedRequest, env);
    }

    if (url.pathname.startsWith("/api/realtime/")) {
      const isRealtimeHealth = url.pathname.replace(/\/+$/, "") === "/api/realtime/health";
      const realtimeIdentity = isRealtimeHealth
        ? null
        : await authorizeRealtimeEconomyRequest(sanitizedRequest, env);
      if (realtimeIdentity instanceof Response) return realtimeIdentity;
      if (realtimeIdentity) {
        headers.set("x-mujindo-account-id", realtimeIdentity.accountId);
        trustedName = realtimeIdentity.displayName;
      }
      if (url.pathname === "/api/realtime/session") {
        if (trustedName) headers.set("x-mujindo-player-name", trustedName);
      }
      const realtimeRequest = new Request(sanitizedRequest, { headers });
      return handleRealtimeRequest(realtimeRequest, env);
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
