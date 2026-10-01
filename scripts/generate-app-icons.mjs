#!/usr/bin/env node
/**
 * Generate PNG home-screen icons from public/favicon.svg.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();
const svgPath = join(ROOT, "public/favicon.svg");
const svg = readFileSync(svgPath);

const outputs = [
  { file: "public/apple-touch-icon.png", size: 180 },
  { file: "public/icon-192.png", size: 192 },
  { file: "public/icon-512.png", size: 512 },
  { file: "src/app/apple-icon.png", size: 180 },
];

for (const { file, size } of outputs) {
  const buffer = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  writeFileSync(join(ROOT, file), buffer);
  console.log(`Wrote ${file} (${size}x${size})`);
}
