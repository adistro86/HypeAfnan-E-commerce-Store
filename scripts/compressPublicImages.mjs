// Compress oversized public/ images in place (same filenames — no code changes needed).
// Phase 2 PR: the site shipped 2.2 MB PNGs rendered at 48px (~17 MB of egress per first visit).
// Targets sized for 3x retina of the largest display size found in the components.
// Re-runnable: skips files already under their target weight.
//
// Usage: node scripts/compressPublicImages.mjs [--dry-run]

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'public');
const DRY = process.argv.includes('--dry-run');

// [file, maxWidth (px), format-specific target weight check]
const PNG_TARGETS = [
  // Social rail logos (WhatsAppButton.tsx 48px; linkbio renders at 120px effective) → 144px
  ['images/WhatsappNewlogo.png', 144],
  ['images/FacebookNewlogo.png', 144],
  ['images/InstagramlogoNew.png', 144],
  // Old-gen logos (linkbio page 48px) → 144px
  ['images/WhatsappLogo.png', 144],
  ['images/FacebookLogo.png', 144],
  ['images/InstagramLogo.png', 144],
  // Linkbio icons → 144px
  ['images/GmailLogo.png', 144],
  ['images/HandshakeMerchant.png', 144],
  // Circular brand logo (used site-wide at 28–96px, preloaded in layout) → 256px generous
  ['images/hypeafnancircularlogopic.png', 256],
];
const JPEG_TARGETS = [
  // Hero + OG image (OG requires >= 1200x630) → max 1600w
  ['images/afnanpicnewcroped.jpeg', 1600],
  // Promo card background → 1000w is plenty for card rendering
  ['images/Firstproductbg.jpeg', 1000],
];

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
let totalBefore = 0, totalAfter = 0;

async function processFile(rel, maxWidth, pipeline) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${rel}`); return; }
  const before = fs.statSync(file).size;
  // Read fully into memory first — sharp holding the read handle caused
  // EUNKNOWN on writeFileSync back to the same path on Windows
  const input = fs.readFileSync(file);
  const buf = await sharp(input)
    .resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true })
    [pipeline]({ quality: 90, compressionLevel: 9, palette: true, mozjpeg: true, effort: 7 })
    .toBuffer();
  const after = buf.length;
  totalBefore += before; totalAfter += after;
  const status = after < before ? `${kb(before)} -> ${kb(after)}` : `already optimal (${kb(before)})`;
  console.log(`${rel}: ${status}`);
  if (!DRY && after < before) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
}

for (const [rel, w] of PNG_TARGETS) await processFile(rel, w, 'png');
for (const [rel, w] of JPEG_TARGETS) await processFile(rel, w, 'jpeg');

console.log(`\nTOTAL: ${kb(totalBefore)} -> ${kb(totalAfter)} (${((1 - totalAfter / totalBefore) * 100).toFixed(0)}% reduction)`);
if (DRY) console.log('(dry run — no files written)');
