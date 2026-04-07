import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrotliCompress, createGzip, constants as zlibConstants } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, "..", "dist");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "3000");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE_CONTENT_TYPES = [
  "text/",
  "application/javascript",
  "application/json",
  "image/svg+xml",
];
const COMPRESSION_MIN_BYTES = 1024;

function isCompressibleContentType(contentType) {
  return COMPRESSIBLE_CONTENT_TYPES.some((prefix) => contentType.startsWith(prefix));
}

function pickContentEncoding(req, contentType, fileSize) {
  const acceptEncoding = String(req.headers["accept-encoding"] || "").toLowerCase();
  if (fileSize < COMPRESSION_MIN_BYTES || !isCompressibleContentType(contentType)) {
    return null;
  }
  if (acceptEncoding.includes("br")) return "br";
  if (acceptEncoding.includes("gzip")) return "gzip";
  return null;
}

function safeJoin(baseDir, requestPath) {
  const normalized = requestPath.split("?")[0].split("#")[0];
  const cleanPath = path.normalize(normalized).replace(/^(\.\.[/\\])+/, "");
  return path.join(baseDir, cleanPath);
}

async function resolveFilePath(urlPath) {
  const candidate = safeJoin(distDir, urlPath);

  try {
    const fileStat = await stat(candidate);
    if (fileStat.isDirectory()) {
      return path.join(candidate, "index.html");
    }
    return candidate;
  } catch {
    return path.join(distDir, "index.html");
  }
}

async function ensureDistExists() {
  try {
    await access(path.join(distDir, "index.html"));
  } catch {
    throw new Error("Build não encontrado. Rode `npm run build` antes de iniciar o servidor.");
  }
}

await ensureDistExists();

const server = createServer(async (req, res) => {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  const urlPath = req.url && req.url !== "/" ? req.url : "/index.html";
  const filePath = await resolveFilePath(urlPath || "/index.html");
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  let fileSize = 0;
  try {
    const fileInfo = await stat(filePath);
    fileSize = Number(fileInfo.size || 0);
  } catch {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Vary", "Accept-Encoding");
  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (filePath.endsWith("index.html")) {
    res.setHeader("Cache-Control", "no-store");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }

  if (method === "HEAD") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const encoding = pickContentEncoding(req, contentType, fileSize);
  const source = createReadStream(filePath).on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    res.destroy();
  });

  if (encoding === "br") {
    res.setHeader("Content-Encoding", "br");
    source.pipe(createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    })).pipe(res);
    return;
  }

  if (encoding === "gzip") {
    res.setHeader("Content-Encoding", "gzip");
    source.pipe(createGzip({ level: 6 })).pipe(res);
    return;
  }

  source.pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend em producao ouvindo em http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Falha ao iniciar frontend em ${HOST}:${PORT}: ${message}`);
  process.exit(1);
});
