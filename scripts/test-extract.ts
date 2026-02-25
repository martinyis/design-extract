import { extractDesign } from "../src/extract.js";
import { resolve } from "node:path";

const videoPath = process.argv[2];
if (!videoPath) {
  console.error("Usage: npx tsx scripts/test-extract.ts <video-path>");
  process.exit(1);
}

console.log(`Extracting design frames from: ${videoPath}`);
console.log("");

const result = await extractDesign(resolve(videoPath), process.cwd());

console.log(
  `Video: ${result.videoInfo.width}x${result.videoInfo.height}, ${Math.round(result.videoInfo.duration)}s`
);
console.log(`Extracted ${result.frames.length} frames`);
console.log(`Output: ${result.outputDir}`);

if (result.warnings.length > 0) {
  console.log("");
  console.log("Warnings:");
  for (const w of result.warnings) {
    console.log(`  - ${w}`);
  }
}

console.log("");
for (const frame of result.frames) {
  console.log(
    `  ${frame.relativePath}  ${frame.width}x${frame.height}  ${frame.sizeKB}KB`
  );
}
