import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  scriptDirectory,
  "../tests/fixtures/paperdoll-visual-qa.html",
);
const rigManifestPath = path.resolve(
  scriptDirectory,
  "../app/paperdoll-rig-manifest.json",
);

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function normalizeOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http(s): ${value}`);
  }
  return url.origin;
}

const appOrigin = normalizeOrigin(
  readArgument("app", "http://localhost:4317"),
  "--app",
);
const host = readArgument("host", "127.0.0.1");
const portValue = Number(readArgument("port", "4399"));
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
  throw new Error(`--port must be an integer from 1 to 65535: ${portValue}`);
}

const [fixture, rigManifestSource] = await Promise.all([
  readFile(fixturePath, "utf8"),
  readFile(rigManifestPath, "utf8"),
]);
const rigManifest = JSON.parse(rigManifestSource);

function requestBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.protocol === "https:" ? import("node:https") : import("node:http");
    protocol.then(({ get }) => {
      get(url, (upstream) => {
        if ((upstream.statusCode ?? 500) >= 400) {
          upstream.resume();
          reject(new Error(`Upstream ${upstream.statusCode}: ${url}`));
          return;
        }
        const chunks = [];
        upstream.on("data", (chunk) => chunks.push(chunk));
        upstream.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", reject);
    }, reject);
  });
}

const serializedRigManifest = JSON.stringify(rigManifest).replaceAll("<", "\\u003c");
const page = fixture
  .replaceAll("__PAPERDOLL_APP_ORIGIN__", "")
  .replaceAll("__PAPERDOLL_RIG_MANIFEST__", serializedRigManifest);

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${portValue}`);
  const responseHeaders = {
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  if (requestUrl.pathname === "/health") {
    response.writeHead(200, {
      ...responseHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      ok: true,
      appOrigin,
      paperdollRigVersion: rigManifest.version,
    }));
    return;
  }
  if (requestUrl.pathname.startsWith("/assets/")) {
    const upstreamUrl = new URL(requestUrl.pathname, appOrigin);
    requestBuffer(upstreamUrl).then((buffer) => {
      response.writeHead(200, {
        ...responseHeaders,
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      response.end(buffer);
    }).catch((error) => {
      response.writeHead(502, {
        ...responseHeaders,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end(error instanceof Error ? error.message : "Asset proxy error");
    });
    return;
  }
  if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
    response.writeHead(404, {
      ...responseHeaders,
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    ...responseHeaders,
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${appOrigin}`,
      `img-src 'self' data: blob: ${appOrigin}`,
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${appOrigin}`,
    ].join("; "),
    "x-content-type-options": "nosniff",
  });
  response.end(page);
});

server.listen(portValue, host, () => {
  const qaUrl = `http://${host}:${portValue}/`;
  console.log(`Paperdoll visual QA: ${qaUrl}`);
  console.log(`Runtime source: ${appOrigin}`);
  console.log("Keep the game dev server running; press Ctrl+C to stop this QA server.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
