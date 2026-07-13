/**
 * NVIDIA API Key Rotator - Global sequential rotation for OpenCode.
 * Every incoming request gets the next key in the pool, regardless of session.
 */

import { readFileSync, createWriteStream, readFileSync as readFile, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const DIR = dirname(fileURLToPath(import.meta.url));
const LOG = join(DIR, "..", "rotator.log");
const MAX_LOG_LINES = 100;

// ── Logging ────────────────────────────────────────────────
function trimLogFile() {
    try {
        const content = readFile(LOG, "utf-8");
        const lines = content.split("\n").filter(line => line.trim() !== "");
        if (lines.length > MAX_LOG_LINES) {
            const trimmed = lines.slice(lines.length - MAX_LOG_LINES).join("\n") + "\n";
            writeFileSync(LOG, trimmed, "utf-8");
        }
    } catch (e) {
        // Log file doesn't exist yet or can't be read — ignore
    }
}

let logStream = createWriteStream(LOG, { flags: "a" });

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (logStream) {
        logStream.write(line + "\n", (err) => {
            if (err) console.error("[rotator] Log write failed:", err.message);
        });
    }
    // Autoclean on every rotation log entry
    trimLogFile();
}

// ── Config loading ─────────────────────────────────────────
let config;
try {
    config = JSON.parse(readFileSync(join(DIR, "config.json"), "utf-8"));
} catch (e) {
    console.error("[rotator] Failed to load config.json:", e.message);
    config = { providerId: "nvidia" };
}

const providerId = config.providerId || "nvidia";

// ── Keys ───────────────────────────────────────────────────
let keys = [];
try {
    const keysData = JSON.parse(readFileSync(join(DIR, "keys.json"), "utf-8"));
    keys = [...new Set((keysData.keys || []).map(k => k.trim()).filter(Boolean))];
} catch (e) {
    console.error("[rotator] Failed to load keys.json:", e.message);
}

log(`=== PLUGIN STARTED v12 (global sequential rotation) ===`);
log(`Loaded ${keys.length} keys`);
if (keys.length === 0) log("WARNING: No API keys configured!");

// ── Global key index (shared across all sessions/agents) ───
let globalKeyIndex = 0;

function rotateGlobalIndex() {
    const old = globalKeyIndex;
    globalKeyIndex = (globalKeyIndex + 1) % keys.length;
    return old;
}

// ── Provider check ────────────────────────────────────────
function isNvidia(input) {
    if (!input.provider || !input.provider.info || !input.provider.info.id) {
        return true; // backward-compat: assume NVIDIA if not specified
    }
    return input.provider.info.id === providerId;
}

// ── Export ────────────────────────────────────────────────
export default async () => ({
    "chat.headers": async (input, output) => {
        const sessionID = input.sessionID || "global";

        log(`Session ${sessionID} | chat.headers called`);

        // Provider filtering
        if (!isNvidia(input)) {
            log(`Session ${sessionID} | Skipping non-NVIDIA provider: ${input.provider?.info?.id || "unknown"}`);
            return;
        }

        // Guard
        if (keys.length === 0) {
            log("WARNING: No API keys configured. Authorization header not injected.");
            return;
        }

        // Use current key and bump global index for the next request
        const idx = rotateGlobalIndex();
        output.headers = output.headers || {};
        output.headers["Authorization"] = `Bearer ${keys[idx]}`;
        log(`Session ${sessionID} | Injected key ${idx + 1}/${keys.length} into Authorization header`);
    },

    event: async ({ event }) => {
        // Intentionally no-op: error logging handled in chat.headers rotation logic
    }
});
