// ============================================================
// Upload all Dispatch* media (104 MP4s ~754 MB + JPG covers) from
// public/ to Cloudflare R2, moving them off Vercel's egress meter.
//
// PREREQUISITES (one-time, in Cloudflare dashboard):
//   1. R2 -> Create bucket: "hypeafnan-videos" (free tier: 10 GB, zero egress fees)
//   2. R2 -> Manage API Tokens -> create token with "Object Read & Write"
//      for that bucket -> put the token in .env.local as CLOUDFLARE_API_TOKEN
//   3. .env.local: R2_BUCKET=hypeafnan-videos
//
// USAGE:  node scripts/uploadDispatchVideosToR2.mjs [--dry-run]
//   Re-runnable: skips files already uploaded (checkpoint in app/data/r2_upload_checkpoint.json)
//   Uses `npx wrangler r2 object put` (official Cloudflare tooling, S3 signing handled for us).
//   Keys preserve the exact folder names ("Dispatched Part 4/xxx.mp4") so the
//   Worker's /videos/* route can map paths verbatim.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const DRY = process.argv.includes("--dry-run");
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");

// --- Load env from .env.local (same pattern as the repo's B2 scripts) ---
const ENV_FILE = path.join(ROOT, ".env.local");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf-8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = process.env.R2_BUCKET || "hypeafnan-videos";
if (!API_TOKEN && !DRY) {
  console.error("Missing CLOUDFLARE_API_TOKEN (set it in .env.local — see header of this script)");
  process.exit(1);
}

const CHECKPOINT_FILE = path.join(ROOT, "app", "data", "r2_upload_checkpoint.json");
const CONCURRENCY = 3;

// --- Collect files ---
const folders = fs.readdirSync(PUBLIC).filter((d) => /^Dispatched/.test(d));
const files = [];
for (const folder of folders) {
  const dir = path.join(PUBLIC, folder);
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile()) files.push({ folder, file: f, full });
  }
}
const totalBytes = files.reduce((n, f) => n + fs.statSync(f.full).size, 0);
console.log(`Found ${files.length} files across ${folders.length} folders (${(totalBytes / 1e6).toFixed(0)} MB)`);

// --- Checkpoint ---
let done = new Set();
if (fs.existsSync(CHECKPOINT_FILE)) {
  done = new Set(JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8")));
  console.log(`Checkpoint: ${done.size} already uploaded`);
}

const pending = files.filter((f) => !done.has(`${f.folder}/${f.file}`));
if (DRY) {
  for (const f of pending.slice(0, 10)) console.log(`[dry] would upload: ${f.folder}/${f.file}`);
  console.log(`[dry] ${pending.length} files to upload`);
  process.exit(0);
}

const contentTypeFor = (name) =>
  name.toLowerCase().endsWith(".mp4") ? "video/mp4" : name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "application/octet-stream";

const saveCheckpoint = () => fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify([...done], null, 1));

let uploaded = 0;
let failed = 0;
const queue = [...pending];

async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const key = `${f.folder}/${f.file}`;
    try {
      await execFileAsync("npx", [
        "wrangler", "r2", "object", "put", `${BUCKET}/${key}`,
        "--file", f.full,
        "--content-type", contentTypeFor(f.file),
        "--remote",
      ], {
        env: { ...process.env, CLOUDFLARE_API_TOKEN: API_TOKEN },
        maxBuffer: 10 * 1024 * 1024,
        shell: process.platform === "win32", // npx on Windows needs a shell
      });
      done.add(key);
      uploaded++;
      process.stdout.write(`\r✓ ${uploaded}/${pending.length}  ${key}`.slice(0, 100) + " ".repeat(10) + "\n");
      if (uploaded % 10 === 0) saveCheckpoint();
    } catch (e) {
      failed++;
      console.error(`\n✗ FAILED: ${key} — ${String(e.message).split("\n")[0]}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
saveCheckpoint();
console.log(`\nDone. Uploaded: ${uploaded}, failed: ${failed}, skipped (checkpoint): ${files.length - pending.length}`);
if (failed > 0) { console.error("Re-run the script — the checkpoint resumes where it left off."); process.exit(1); }
console.log("\nNEXT STEPS:");
console.log("  1. Deploy the updated Worker (scripts/cloudflare-worker.js) with an R2 binding:");
console.log('     Workers -> hypeafnan-cdn -> Settings -> Bindings -> Add R2 bucket "hypeafnan-videos" as VIDEOS');
console.log("  2. Test: https://hypeafnan-cdn.afnanimran61.workers.dev/videos/<folder>/<file> (URL-encode spaces)");
console.log("  3. When playback is verified, set VIDEO_CDN_BASE=https://hypeafnan-cdn.afnanimran61.workers.dev/videos in Vercel env");
