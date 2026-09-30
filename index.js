/**
 * dsh-plugin-fc-emulator — host half (Node).
 *
 * Registers HTTP routes under the /dsh-plugin-fc prefix on the DSH web server
 * (same pattern as dsh-plugin-stock-x):
 *
 *   GET    /core-fce/fceumm.js     fceumm libretro core — emscripten glue (UMD)
 *   GET    /core-fce/fceumm.wasm   fceumm libretro core — wasm binary
 *   GET    /roms              ROM list (bundled/ + uploaded/)
 *   GET    /roms/:name        ROM bytes (iNES header validated on upload)
 *   POST   /roms?name=...     upload a ROM (<= 20 MiB, .nes only)
 *   DELETE /roms/:name        delete an uploaded ROM
 *   GET    /savestates/:name  full-machine save state
 *                             (envelope: {core:"fceumm",data:<b64>} 或旧
 *                              jsnes 格式 {savedAt,state:{cpu,mmap,...}})
 *   PUT    /savestates/:name  store a save state（两种格式都接受）
 *   DELETE /savestates/:name
 *   GET    /srm/:name         battery-backed SRAM（0..0x2000 字节，按游戏实际大小）
 *   PUT    /srm/:name         store battery SRAM
 *   DELETE /srm/:name
 *
 * Writable data lives under $DSH_HOME/data/dsh-plugin-fc/{roms,savestates,srm};
 * the bundled roms/ directory next to this file is read-only through the API
 * (manage those files on disk).
 *
 * The plugin ships no copyrighted ROMs. Users provide their own game files.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const DATA_DIR = path.join(DSH_HOME, "data", "dsh-plugin-fc");
const ROM_SOURCES = [
  { dir: path.join(MODULE_DIR, "roms"), source: "bundled", writable: false },
  { dir: path.join(DATA_DIR, "roms"), source: "uploaded", writable: true }
];
const SAVE_DIR = path.join(DATA_DIR, "savestates");
const SRM_DIR = path.join(DATA_DIR, "srm");
const FCE_CORE_DIR = path.join(MODULE_DIR, "core-fce");
const FCE_CORE_FILES = {
  "fceumm.js": "application/javascript; charset=utf-8",
  "fceumm.wasm": "application/wasm"
};

const MAX_ROM_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_SAVE_BYTES = 2 * 1024 * 1024; // 64 KiB machine memory as JSON needs < 1 MiB
const SRM_SIZE = 0x2000;
const PREFIX = "/dsh-plugin-fc";

function ensureDataDirs() {
  for (const d of [DATA_DIR, ROM_SOURCES[1].dir, SAVE_DIR, SRM_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * Sanitize a user-supplied ROM/file name: basename only, no separators,
 * no dot entries, bounded length.
 * @param {unknown} name - raw name.
 * @returns {string|null} sanitized name, or null when invalid.
 */
function safeName(name) {
  if (typeof name !== "string") return null;
  const n = path.basename(name).trim();
  if (!n || n === "." || n === ".." || n.length > 100) return null;
  if (n.includes("/") || n.includes("\\")) return null;
  return n;
}

function cors(res) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...cors(res) });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { ...cors(res) });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType, ...cors(res) });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Route handler for the /dsh-plugin-fc prefix.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(res));
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    res.writeHead(400, { ...cors(res) });
    res.end("bad request");
    return;
  }

  let sub = url.pathname;
  if (sub.startsWith(PREFIX)) sub = sub.slice(PREFIX.length) || "/";
  let subPath;
  try {
    subPath = decodeURIComponent(sub);
  } catch {
    res.writeHead(400, { ...cors(res) });
    res.end("bad path");
    return;
  }
  const parts = subPath.split("/").filter(Boolean);

  try {
    // ── 1. fceumm libretro core (wasm) ──────────────────────────────────
    if (parts.length === 2 && parts[0] === "core-fce" && req.method === "GET") {
      const type = FCE_CORE_FILES[parts[1]];
      if (!type) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      sendFile(res, path.join(FCE_CORE_DIR, parts[1]), type);
      return;
    }

    // ── 2. ROM library ──────────────────────────────────────────────────
    if (parts.length === 1 && parts[0] === "roms") {
      if (req.method === "GET") {
        const roms = [];
        for (const src of ROM_SOURCES) {
          if (!fs.existsSync(src.dir)) continue;
          for (const entry of fs.readdirSync(src.dir, { withFileTypes: true })) {
            if (!entry.isFile() || !/\.nes$/i.test(entry.name)) continue;
            const st = fs.statSync(path.join(src.dir, entry.name));
            roms.push({ name: entry.name, size: st.size, mtime: st.mtimeMs, source: src.source });
          }
        }
        roms.sort((a, b) => a.name.localeCompare(b.name, "zh"));
        sendJson(res, 200, { data: roms });
        return;
      }
      if (req.method === "POST") {
        const name = safeName(url.searchParams.get("name") || "");
        if (!name) {
          sendJson(res, 400, { error: "valid ?name=xxx.nes required" });
          return;
        }
        const finalName = /\.nes$/i.test(name) ? name : name + ".nes";
        const dest = path.join(ROM_SOURCES[1].dir, finalName);
        if (fs.existsSync(dest)) {
          sendJson(res, 409, { error: "a ROM with this name already exists" });
          return;
        }
        const buf = await readBody(req, MAX_ROM_BYTES);
        if (buf.length < 4 || buf[0] !== 0x4e || buf[1] !== 0x45 || buf[2] !== 0x53 || buf[3] !== 0x1a) {
          sendJson(res, 400, { error: "not a valid NES ROM (missing NES\\x1a header)" });
          return;
        }
        fs.writeFileSync(dest, buf);
        sendJson(res, 200, { status: "success", name: finalName, size: buf.length });
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (parts.length === 2 && parts[0] === "roms") {
      const name = safeName(parts[1]);
      if (!name) {
        sendJson(res, 400, { error: "invalid ROM name" });
        return;
      }
      const file = ROM_SOURCES.map((s) => path.join(s.dir, name)).find((p) => fs.existsSync(p));
      if (!file) {
        sendJson(res, 404, { error: "ROM not found" });
        return;
      }
      if (req.method === "GET") {
        sendFile(res, file, "application/octet-stream");
        return;
      }
      if (req.method === "DELETE") {
        const src = ROM_SOURCES.find((s) => file.startsWith(s.dir + path.sep));
        if (!src || !src.writable) {
          sendJson(res, 403, { error: "bundled ROMs are read-only; remove the file on disk instead" });
          return;
        }
        fs.unlinkSync(file);
        sendJson(res, 200, { status: "success" });
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // ── 3. save states (full machine snapshots) ─────────────────────────
    if (parts.length === 2 && parts[0] === "savestates") {
      const name = safeName(parts[1]);
      if (!name) {
        sendJson(res, 400, { error: "invalid name" });
        return;
      }
      const file = path.join(SAVE_DIR, name + ".json");
      if (req.method === "GET") {
        if (!fs.existsSync(file)) {
          sendJson(res, 404, { error: "no save state" });
          return;
        }
        sendJson(res, 200, { data: JSON.parse(fs.readFileSync(file, "utf-8")) });
        return;
      }
      if (req.method === "PUT" || req.method === "POST") {
        const buf = await readBody(req, MAX_SAVE_BYTES);
        const obj = JSON.parse(buf.toString("utf-8")); // throws → 500 below, loud
        let envelope = null;
        if (obj && typeof obj === "object" && obj.core === "fceumm" && typeof obj.data === "string") {
          // fceumm 整局快照：二进制经 base64
          envelope = { core: "fceumm", savedAt: Date.now(), data: obj.data };
        } else if (obj && typeof obj === "object" && obj.cpu && obj.mmap && obj.ppu && obj.papu) {
          // 旧 jsnes 格式（nes.toJSON）：原样保留，便于回滚
          envelope = { core: "jsnes", savedAt: Date.now(), state: obj };
        } else {
          sendJson(res, 400, { error: "unrecognized save state format" });
          return;
        }
        fs.writeFileSync(file, JSON.stringify(envelope));
        sendJson(res, 200, { status: "success" });
        return;
      }
      if (req.method === "DELETE") {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        sendJson(res, 200, { status: "success" });
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // ── 4. battery SRAM (in-game saves) ─────────────────────────────────
    if (parts.length === 2 && parts[0] === "srm") {
      const name = safeName(parts[1]);
      if (!name) {
        sendJson(res, 400, { error: "invalid name" });
        return;
      }
      const file = path.join(SRM_DIR, name + ".srm");
      if (req.method === "GET") {
        if (!fs.existsSync(file)) {
          sendJson(res, 404, { error: "no SRAM" });
          return;
        }
        sendFile(res, file, "application/octet-stream");
        return;
      }
      if (req.method === "PUT" || req.method === "POST") {
        // 按游戏实际 SRAM 大小存（0..0x2000）；旧 jsnes 客户端写满 0x2000 也兼容
        const buf = await readBody(req, SRM_SIZE);
        if (buf.length === 0) {
          sendJson(res, 400, { error: "empty SRAM body" });
          return;
        }
        fs.writeFileSync(file, buf);
        sendJson(res, 200, { status: "success" });
        return;
      }
      if (req.method === "DELETE") {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        sendJson(res, 200, { status: "success" });
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

export const name = "dsh-plugin-fc-emulator";

export function apply(ctx) {
  const logger = ctx.logger || console;
  logger.info?.(`[dsh-plugin-fc-emulator] 初始化，数据目录: ${DATA_DIR}`);

  ctx.inject(["webServer"], (hostCtx) => {
    hostCtx.effect(() => {
      ensureDataDirs();
      const dispose = hostCtx.webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: handleRequest
      });
      return () => {
        dispose?.();
      };
    }, "dsh-plugin-fc-emulator: routes");
  });
}

export default {
  name,
  apply
};
