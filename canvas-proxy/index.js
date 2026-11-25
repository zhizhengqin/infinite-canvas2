#!/usr/bin/env node
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { DreamMakerSession, isDreamMakerApiTarget } from "./dreammaker-auth.js";

const pkg = createRequire(import.meta.url)("./package.json");

const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
};

/** Headers that describe the hop to this proxy rather than the upstream request. */
const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "x-canvas-dreammaker-session"]);
/** fetch() already decoded and re-framed the body, so the upstream framing headers no longer apply. */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function readArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function readTarget(url) {
    const raw = url.slice(1);
    // decodeURI undoes the escaping browsers apply to the path while keeping intentional encodeURIComponent escapes.
    let target = raw;
    try {
        target = decodeURI(raw);
    } catch {
        // Malformed escape sequence: forward the raw form instead of failing.
    }
    // Some clients collapse the "//" in the embedded target URL, so restore it before parsing.
    target = target.replace(/^(https?:)\/*/i, "$1//");
    return /^https?:\/\/[^/]/i.test(target) ? target : "";
}

function requestHeaders(req) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key) || value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function responseHeaders(upstream) {
    const headers = { ...CORS_HEADERS };
    upstream.headers.forEach((value, key) => {
        if (SKIP_RESPONSE_HEADERS.has(key) || key.startsWith("access-control-")) return;
        headers[key] = value;
    });
    return headers;
}

function sendJson(res, status, payload) {
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function logForward(method, target, outcome, startedAt, authorization) {
    const authHash = createHash("sha256").update(authorization || "").digest("hex").slice(0, 12);
    console.log(`${new Date().toLocaleTimeString()} ${method} ${target} -> ${outcome} ${((Date.now() - startedAt) / 1000).toFixed(1)}s auth=${authHash}`);
}

async function forward(req, res, target, accountToken) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers = requestHeaders(req);
    if (accountToken) headers.authorization = `Bearer ${accountToken}`;
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: "follow" });
    // Logged as soon as the status line arrives, so a long SSE stream still shows up immediately.
    res.writeHead(upstream.status, responseHeaders(upstream));
    if (!upstream.body) {
        res.end();
        return upstream.status;
    }
    // Streamed so that SSE responses (text generation) reach the browser chunk by chunk.
    const stream = Readable.fromWeb(upstream.body);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return upstream.status;
}

export function createProxyServer() {
    const dreamMaker = new DreamMakerSession();
    const accountOrigins = new Set(["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:23210", "http://127.0.0.1:23210"]);
    return createServer(async (req, res) => {
        if (req.method === "OPTIONS") {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }
        if (req.method === "GET" && req.url === "/dreammaker/settings") {
            const html = await readFile(new URL("./dreammaker-settings.html", import.meta.url));
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
            res.end(html);
            return;
        }
        const accountRoute = (req.url || "").startsWith("/dreammaker/auth/");
        let useAccount = req.headers["x-canvas-dreammaker-session"] === "default";
        const sameOriginStatus = !req.headers.origin && req.method === "GET" && req.url === "/dreammaker/auth/status" && req.headers["sec-fetch-site"] === "same-origin" && ["localhost:23210", "127.0.0.1:23210"].includes(req.headers.host);
        if ((accountRoute || useAccount) && !accountOrigins.has(req.headers.origin) && !sameOriginStatus) {
            sendJson(res, 403, { error: "DreamMaker账号仅允许本机画布来源访问" });
            return;
        }
        if (accountRoute) {
            const action = req.url.slice("/dreammaker/auth/".length);
            try {
                if (action === "status" && req.method === "GET") sendJson(res, 200, await dreamMaker.status());
                else if (action === "login" && req.method === "POST") sendJson(res, 200, await dreamMaker.login());
                else if (action === "refresh" && req.method === "POST") { await dreamMaker.accessToken(true); sendJson(res, 200, await dreamMaker.status()); }
                else if (action === "disconnect" && req.method === "POST") { await dreamMaker.clear(); sendJson(res, 200, await dreamMaker.status()); }
                else sendJson(res, 404, { error: "未知账号操作" });
            } catch (error) { sendJson(res, 401, { error: error instanceof Error ? error.message : "账号操作失败" }); }
            return;
        }
        const target = readTarget(req.url || "/");
        if (!target) {
            sendJson(res, 200, { app: "infinite-canvas", proxy: pkg.name, version: pkg.version, usage: "/<full-target-url>" });
            return;
        }
        // Existing configured credentials identify the account only; managed authorization stays in this local process.
        if (!useAccount && accountOrigins.has(req.headers.origin) && isDreamMakerApiTarget(target)) {
            try { useAccount = await dreamMaker.matchesAuthorization(req.headers.authorization); }
            catch { sendJson(res, 401, { error: "本机DreamMaker会话无法读取，请重新登录" }); return; }
        }
        if (useAccount && !isDreamMakerApiTarget(target)) {
            sendJson(res, 400, { error: "账号会话仅用于DreamMaker官方API" });
            return;
        }
        let accountToken;
        if (useAccount) {
            try { accountToken = await dreamMaker.accessToken(); }
            catch (error) { sendJson(res, 401, { error: error instanceof Error ? error.message : "请重新登录DreamMaker" }); return; }
        }
        const startedAt = Date.now();
        const method = req.method || "GET";
        forward(req, res, target, accountToken)
            .then((status) => logForward(method, target, status, startedAt, req.headers.authorization))
            .catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                console.error(JSON.stringify({ event: "upstream-fetch-error", host: new URL(target).host, path: new URL(target).pathname, code: error?.cause?.code, message: error?.cause?.message, errors: error?.cause?.errors?.map((item) => ({ code: item.code, address: item.address, port: item.port })) }));
                logForward(method, target, `failed (${reason})`, startedAt);
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                sendJson(res, 502, { error: reason });
            });
    });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
    console.log(`${pkg.name} v${pkg.version}\n\nUsage: npx ${pkg.name}@latest [--port 23210] [--host 127.0.0.1]\n\nForwards http://<host>:<port>/<full-target-url> to <full-target-url> with permissive CORS headers.`);
    process.exit(0);
}

const port = Number(readArg(args, "port", process.env.PORT || 23210));
const host = readArg(args, "host", process.env.HOST || "127.0.0.1");

createProxyServer().listen(port, host, () => {
    console.log(`${pkg.name} v${pkg.version} listening on http://${host}:${port}`);
    console.log(`Fill this address into Infinite Canvas → 配置 → 本地代理: http://${host}:${port}`);
});
