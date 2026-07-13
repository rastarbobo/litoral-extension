/**
 * NVIDIA API Key Rotator - Global sequential rotation for OpenCode.
 * Every incoming request gets the next key in the pool, regardless of session.
 */

import { readFileSync, createWriteStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const DIR = dirname(fileURLToPath(import.meta.url));
const LOG = join(DIR, "..", "rotator.log");
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB

// ── Logging ────────────────────────────────────────────────
let logStream;
function openLogStream() {
    if (logStream) {
        try { logStream.end(); } catch (e) {}
    }
    try {
        logStream = createWriteStream(LOG, { flags: "a" });
    } catch (e) {
        console.error("[rotator] Failed to open log stream:", e.message);
    }
}
openLogStream();

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (logStream) {
        logStream.write(line + "\n", (err) => {
            if (err) console.error("[rotator] Log write failed:", err.message);
        });
    }
}

// ── Config loading ─────────────────────────────────────────
let config;
try {
    config = JSON.parse(readFileSync(join(DIR, "config.json"), "utf-8"));
} catch (e) {
    console.error("[rotator] Failed to load config.json:", e.message);
    config = { providerId: "nvidia", triggerErrors: [429] };
}

const triggerErrors = new Set((config.triggerErrors || [429]).map(Number));
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
        const sessionID = event.sessionID || "global";

        // Detect trigger errors
        const status = extractStatusCode(event);
        // Skip noisy non-error events to keep the log lean
        const isNoisy = !status && (event.type === "message.part.delta" || event.type === "message.part.updated");
        if (!isNoisy) {
            log(`Session ${sessionID} | Event received: type=${event.type}, status=${status}`);
        }
        if (status && triggerErrors.has(status)) {
            log(`Session ${sessionID} | Error ${status} detected. Next request will use the next key in sequence.`);
        }
    }
});

/**
 * Extract HTTP status code from any event shape OpenCode may emit.
 */
function extractStatusCode(event) {
    if (!event) return null;
    if (event.error) {
        if (event.error.status) return Number(event.error.status);
        if (event.error.statusCode) return Number(event.error.statusCode);
        if (event.error.code && typeof event.error.code === "number") return event.error.code;
        if (event.error.details && event.error.details.status) return Number(event.error.details.status);
    }
    if (event.response && event.response.status) return Number(event.response.status);
    if (event.status && typeof event.status === "number") return Number(event.status);
    if (event.statusCode && typeof event.statusCode === "number") return Number(event.statusCode);
    const text = event.message || event.errorMessage || (event.error && event.error.message) || "";
    const match = String(text).match(/\b(\d{3})\b/);
    if (match) return Number(match[1]);
    return null;
}
