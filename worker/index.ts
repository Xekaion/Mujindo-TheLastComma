/// <reference types="@cloudflare/workers-types" />

/** Cloudflare Worker entry point for Mujindo's Vinext app and realtime arena. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  authorizeHubEconomyRequest,
  authorizeRealtimeEconomyRequest,
  handleEconomyRequest,
  type EconomyD1Env,
} from "./economy-d1";
import { handleHubRequest } from "./hub-d1";
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
    headers.delete("x-mujindo-hub-auth-mode");

    const localHost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]";
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
    const sanitizedRequest = new Request(request, { headers });

    if (url.pathname.startsWith("/api/economy/")) {
      return handleEconomyRequest(sanitizedRequest, env);
    }

    if (url.pathname.startsWith("/api/realtime/")) {
      const realtimeRoute = url.pathname.replace(/\/+$/, "");
      const isRealtimeHealth = realtimeRoute === "/api/realtime/health";
      const isRealtimeSession = realtimeRoute === "/api/realtime/session";
      let realtimeIdentity = isRealtimeHealth
        ? null
        : await authorizeRealtimeEconomyRequest(sanitizedRequest, env);
      // When strict PVP account auth is disabled, resolve an optional signed-in
      // account only while issuing the bearer session. Repeating this D1-backed
      // authentication on every 50 ms sync would add needless hot-path load.
      if (isRealtimeSession && realtimeIdentity === null) {
        realtimeIdentity = await authorizeHubEconomyRequest(sanitizedRequest, env);
      }
      if (realtimeIdentity instanceof Response) return realtimeIdentity;
      if (realtimeIdentity) {
        headers.set("x-mujindo-account-id", realtimeIdentity.accountId);
      }
      const realtimeRequest = new Request(sanitizedRequest, { headers });
      return handleRealtimeRequest(realtimeRequest, env);
    }

    if (url.pathname.startsWith("/api/hub/")) {
      const isHubHealth = url.pathname.replace(/\/+$/, "") === "/api/hub/health";
      if (isHubHealth) return handleHubRequest(sanitizedRequest, env);
      const hubIdentity = await authorizeHubEconomyRequest(sanitizedRequest, env);
      if (hubIdentity instanceof Response) return hubIdentity;
      if (hubIdentity) {
        headers.set("x-mujindo-account-id", hubIdentity.accountId);
        headers.set("x-mujindo-hub-auth-mode", "account");
      } else {
        // Closed-beta/local worlds still receive a server-issued opaque guest
        // identity. The client never gets to nominate an account id.
        headers.set("x-mujindo-hub-auth-mode", "guest");
      }
      const hubRequest = new Request(sanitizedRequest, { headers });
      return handleHubRequest(hubRequest, env);
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
