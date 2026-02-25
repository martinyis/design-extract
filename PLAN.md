# Implementation Plan: design-extract

## Summary

A local MCP tool server for Claude Code that extracts design context frames from short screen recordings. The user drops a video into their project, asks Claude to extract the design, and behind the scenes FFmpeg pulls out key frames via scene detection, deduplicates them with perceptual hashing, resizes them, and saves them to a `.design-extract/` folder in the project. The tool returns the file paths as text, and Claude then reads the images using its built-in Read tool. One tool, sensible defaults, zero configuration, works within the default 25K MCP token limit.

## Context & Problem

When using Claude Code to build UI, the user currently has to manually screenshot reference designs and paste or describe them. This is tedious for multi-screen flows, long scrolling pages, and animated transitions. A short screen recording captures all of this naturally, but Claude Code cannot process video. This tool bridges that gap: video in, design frames saved to disk, Claude reads them and sees the designs.

## Chosen Approach

A single-tool stdio MCP server built with the official `@modelcontextprotocol/sdk` TypeScript SDK. The tool accepts a video path, shells out to the system-installed FFmpeg for scene-change frame extraction, uses `sharp` + `sharp-phash` for dedup/resize, saves the final frames as JPEG files to `.design-extract/` in the project directory, and returns a text response listing the file paths. Claude then uses its built-in Read tool to view the images (Claude Code's Read tool natively supports reading image files and presenting them visually).

Distributed via npm (invoked with `npx`), with a companion `init` CLI command that writes a `.mcp.json` into the user's project.

### Why disk-based instead of base64 in the MCP response

The original approach returned base64-encoded images directly in the MCP tool result. This hit a hard wall: Claude Code's `MAX_MCP_OUTPUT_TOKENS` defaults to 25,000, and base64 image data is counted as raw text tokens (not image tokens). A single 1280px JPEG screenshot produces ~250KB of base64 text, which alone exceeds the default limit.

The disk-based approach eliminates this constraint entirely:
- The MCP tool response is pure text (a few hundred tokens at most)
- Works with the default 25K token limit -- no configuration required
- No `MAX_MCP_OUTPUT_TOKENS` adjustment needed
- Frame quality and count are no longer constrained by token budgets
- Claude's Read tool handles image display natively

The tradeoff is an extra step (Claude reads the files after extraction), but Claude does this automatically when told the files exist.

### Why this approach over other alternatives

- **stdio transport** (not HTTP/SSE): simplest for local tools, no port management, no auth, Claude Code spawns the process directly
- **System FFmpeg** (not `ffmpeg-static`): avoids bundling ~70MB, most devs have it or can install trivially
- **sharp for image processing** (not canvas/jimp): fastest Node.js image lib by far, native bindings, handles resize + buffer + format conversion in one pipeline
- **sharp-phash for dedup** (not custom or heavier libs): built on sharp (already a dependency), returns 64-bit perceptual hash, simple hamming distance comparison
- **Single tool** (not a toolkit): keeps the MCP server lean, one clear purpose, minimal tool-description token cost

## Project Structure

```
design-extract/
  src/
    index.ts              # MCP server entry point (stdio transport, tool registration)
    extract.ts            # Core extraction pipeline (orchestrates FFmpeg -> dedup -> resize -> save)
    ffmpeg.ts             # FFmpeg operations (probe video, extract scene-change frames)
    dedup.ts              # Perceptual hash deduplication
    cli.ts                # CLI entry point (init command, --server flag, help)
  tsconfig.json
  tsup.config.ts          # Build config (bundles to dist/)
  package.json
  .mcp.json               # Example/template for project-scope MCP config
  README.md
```

Two entry points, one bin command:
- `src/index.ts` -> `dist/index.js` -> the MCP server (invoked by Claude Code via stdio)
- `src/cli.ts` -> `dist/cli.js` -> the `design-extract` CLI (init command, or `--server` to start MCP server)

The `bin` field in package.json points to `dist/cli.js`. When `.mcp.json` invokes `design-extract --server`, it delegates to the MCP server entry. When the user runs `design-extract init`, it runs the CLI directly.

## package.json

```json
{
  "name": "design-extract",
  "version": "0.1.0",
  "description": "MCP tool for Claude Code: extract design context frames from screen recordings",
  "type": "module",
  "bin": {
    "design-extract": "./dist/cli.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0",
    "sharp": "^0.33.0",
    "sharp-phash": "^0.2.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.6.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

## tsup Build Config

```ts
// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",  // MCP server
    cli: "src/cli.ts",      // CLI
  },
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  banner: {
    // cli.js needs the shebang for npx/bin execution
    js: "",
  },
});
```

The CLI entry (`dist/cli.js`) needs a `#!/usr/bin/env node` shebang prepended. Handle this either in tsup's banner config (apply only to cli entry) or as a simple post-build step. The MCP server entry does NOT need a shebang since Claude Code invokes it as `node dist/index.js`.

## Detailed Implementation Steps

### Step 1: Project scaffolding

Create the directory structure, `package.json`, `tsconfig.json`, and `tsup.config.ts`.

**tsconfig.json** should target ES2022, moduleResolution "bundler", strict mode. Since tsup handles bundling, TypeScript is only used for type checking (`tsc --noEmit`).

Install dependencies: `npm install`.

### Step 2: FFmpeg module (`src/ffmpeg.ts`)

This module handles all FFmpeg/ffprobe interactions. Two functions:

**`probeVideo(videoPath: string): Promise<VideoInfo>`**

Runs `ffprobe` to get video metadata:
```
ffprobe -v quiet -print_format json -show_format -show_streams <videoPath>
```

Returns: `{ duration: number, width: number, height: number, fps: number }`.

Used to:
- Validate the file is actually a video (fail early if not)
- Know the duration (used to sanity-check frame count)
- Know dimensions (inform resize decisions)

**`extractSceneFrames(videoPath: string, outputDir: string, threshold: number): Promise<string[]>`**

The core FFmpeg command:
```
ffmpeg -i <videoPath> \
  -vf "select=gt(scene\,<threshold>)" \
  -vsync vfr \
  -q:v 2 \
  <outputDir>/frame_%04d.png
```

Key details:
- `select=gt(scene\,T)` -- FFmpeg's built-in scene change detector. Each frame gets a `scene` score (0.0 to 1.0) representing how different it is from the previous frame. We keep frames where the score exceeds the threshold.
- `-vsync vfr` -- variable frame rate output. Without this, FFmpeg duplicates frames to fill gaps, which is the opposite of what we want. VFR outputs only the selected frames.
- `-q:v 2` -- high-quality PNG output (1 is best, 31 is worst; 2 is a good balance)
- Output pattern `frame_%04d.png` -- sequential numbered files: frame_0001.png, frame_0002.png, etc.
- Threshold default: **0.3**. This is the sweet spot for UI recordings. Lower (0.1-0.2) catches too many minor scroll positions and hover states. Higher (0.5+) misses subtle screen transitions. 0.3 catches distinct screens, modals, and significant scroll jumps while ignoring minor animations.

Also always extract the **first frame** (frame at t=0) regardless of scene score, because the starting screen is always relevant context. Do this as a separate FFmpeg call:
```
ffmpeg -i <videoPath> -frames:v 1 -q:v 2 <outputDir>/frame_0000.png
```

Returns the list of extracted frame file paths, sorted by filename (which preserves temporal order).

**Error handling:**
- If `ffmpeg` or `ffprobe` is not found in PATH, throw a descriptive error: "FFmpeg is required but not found. Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)"
- If the command exits non-zero, capture stderr and throw with the FFmpeg error message
- Use `child_process.execFile` (not `exec`) to avoid shell injection from filenames with special characters

### Step 3: Deduplication module (`src/dedup.ts`)

**`deduplicateFrames(framePaths: string[], threshold?: number): Promise<string[]>`**

Screen recordings, especially of scrolling, produce many near-identical frames even after scene detection. This module eliminates them.

Algorithm:
1. For each frame, compute a perceptual hash using `sharp-phash`:
   ```ts
   import phash from "sharp-phash";
   import sharp from "sharp";
   const hash = await phash(sharp(framePath));
   ```
   This returns a 64-character binary string (64-bit hash).

2. Compute hamming distance between consecutive frame hashes. The hamming distance is the number of differing bits -- for 64-bit hashes, it ranges from 0 (identical) to 64 (maximally different).

3. Walk the frames in order. Keep a frame if its hamming distance from the **last kept frame** is above the dedup threshold. Default threshold: **5** (meaning fewer than 5 differing bits = near-duplicate, drop it).

   ```
   kept = [frames[0]]
   lastHash = hashes[0]
   for each subsequent frame:
     if hammingDistance(lastHash, currentHash) > 5:
       kept.push(frame)
       lastHash = currentHash
   ```

4. Always keep the first frame and the last frame (last frame often shows the final state of the flow).

**Why hamming distance 5:**
- 0-3: virtually identical images (same screen, maybe a cursor moved)
- 4-7: very similar (minor scroll, hover state change)
- 8+: meaningfully different content
- 5 is the established threshold in the sharp-phash ecosystem for "near-duplicate" detection

**Implementing hamming distance** (no library needed, it's trivial):
```ts
function hammingDistance(a: string, b: string): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}
```

### Step 4: Core extraction pipeline (`src/extract.ts`)

**`extractDesign(videoPath: string, outputDir: string, options?: ExtractOptions): Promise<ExtractResult>`**

This is the orchestrator. It chains: validate -> extract -> dedup -> cap -> resize -> save to disk.

```ts
interface ExtractOptions {
  maxFrames?: number;      // default: 12
  sceneThreshold?: number; // default: 0.3
  dedupThreshold?: number; // default: 5
  maxWidth?: number;       // default: 1280
  quality?: number;        // default: 80
}

interface ExtractResult {
  frames: FrameInfo[];     // info about each saved frame
  outputDir: string;       // absolute path to .design-extract/ folder
  videoInfo: VideoInfo;    // metadata from the source video
}

interface FrameInfo {
  path: string;            // absolute path to the saved JPEG file
  relativePath: string;    // relative path from project root (e.g., ".design-extract/frame-001.jpg")
  index: number;           // frame order (0-based)
  width: number;           // actual width after resize
  height: number;          // actual height after resize
  sizeKB: number;          // file size in KB
}
```

Pipeline steps:

1. **Resolve and validate the video path.** Convert relative paths to absolute (relative to cwd). Check the file exists. Run `probeVideo()` to confirm it's a valid video.

2. **Prepare the output directory.** The output directory is `.design-extract/` inside the project root (determined by `process.cwd()`). If it already exists, **clear it** (remove all files inside it) to prevent stale frames from previous extractions from confusing Claude. Then ensure the directory exists.

   ```ts
   const outputDir = path.join(process.cwd(), ".design-extract");
   if (existsSync(outputDir)) {
     // Remove all files in the directory
     const files = readdirSync(outputDir);
     for (const file of files) {
       unlinkSync(path.join(outputDir, file));
     }
   } else {
     mkdirSync(outputDir, { recursive: true });
   }
   ```

3. **Create a temp directory for raw extraction.** Use `fs.mkdtemp(path.join(os.tmpdir(), 'design-extract-'))` for the initial FFmpeg output. This is separate from the final output directory because we need to process frames (dedup, resize) before saving the final versions. The temp directory gets cleaned up at the end.

4. **Extract scene-change frames to temp dir.** Call `extractSceneFrames()`. Also extract frame 0 separately.

5. **Deduplicate.** Call `deduplicateFrames()` on the extracted frame paths.

6. **Cap frame count.** If deduped frames exceed `maxFrames`, select a representative subset. Strategy: always keep first and last, then evenly sample from the middle. This preserves the start and end of the flow while distributing coverage across the recording.

   ```
   if frames.length > maxFrames:
     keep first, keep last
     remaining = maxFrames - 2
     stride = (frames.length - 2) / (remaining + 1)
     sample at intervals of stride from the middle frames
   ```

7. **Resize and save to output directory.** For each kept frame, use sharp to resize and save as JPEG:

   ```ts
   const outputPath = path.join(outputDir, `frame-${String(i + 1).padStart(3, "0")}.jpg`);
   await sharp(framePath)
     .resize({ width: maxWidth, withoutEnlargement: true })
     .jpeg({ quality })
     .toFile(outputPath);
   ```

   **Why JPEG:** UI screenshots as JPEG at quality 80 are 3-5x smaller than PNG while being visually indistinguishable for Claude's analysis purposes. Smaller files mean faster Read tool operations.

   **Why quality 80 (not 70 as in the previous plan):** Since we are no longer constrained by MCP token limits, we can afford better quality. Quality 80 JPEG is effectively lossless for UI content. There is no reason to compromise fidelity now.

   **Why `withoutEnlargement: true`:** If the video is already smaller than 1280px wide (e.g., a mobile recording), don't upscale it.

   **File naming:** `frame-001.jpg`, `frame-002.jpg`, etc. Zero-padded to 3 digits. This sorts correctly in file listings and is easy to reference. The numbering reflects temporal order in the video.

8. **Clean up temp directory.** Remove all raw extracted frame files and the temp dir.

9. **Return the `ExtractResult` with frame info.**

### Step 5: MCP server (`src/index.ts`)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractDesign } from "./extract.js";

const server = new McpServer({
  name: "design-extract",
  version: "0.1.0",
});

server.tool(
  "extract_design",
  "Extract key design frames from a screen recording video. Saves frames to .design-extract/ in the project directory. After extraction, read the frame images to see the designs. Accepts common video formats (mp4, mov, webm, mkv, avi).",
  {
    videoPath: z.string().describe(
      "Path to the video file (absolute or relative to the current working directory)"
    ),
    maxFrames: z.number().optional().default(12).describe(
      "Maximum number of frames to extract (default: 12)"
    ),
    sensitivity: z.enum(["low", "medium", "high"]).optional().default("medium").describe(
      "Scene detection sensitivity. 'low' captures only major screen changes. 'medium' (default) is good for most recordings. 'high' captures subtle transitions."
    ),
  },
  async ({ videoPath, maxFrames, sensitivity }) => {
    try {
      const sceneThreshold = { low: 0.5, medium: 0.3, high: 0.15 }[sensitivity];

      const result = await extractDesign(videoPath, process.cwd(), {
        maxFrames,
        sceneThreshold,
      });

      const frameList = result.frames
        .map((f) => `  ${f.relativePath} (${f.width}x${f.height}, ${f.sizeKB}KB)`)
        .join("\n");

      const text = [
        `Extracted ${result.frames.length} design frames from the video.`,
        `Source: ${videoPath} (${result.videoInfo.width}x${result.videoInfo.height}, ${Math.round(result.videoInfo.duration)}s)`,
        ``,
        `Frames saved to .design-extract/:`,
        frameList,
        ``,
        `Read the frame images to see the designs. They are in temporal order (frame-001 is the first screen, frame-${String(result.frames.length).padStart(3, "0")} is the last).`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error extracting design: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Key design decisions:

- **Tool name: `extract_design`** -- clear, discoverable. When the user says "extract the design from X," Claude will naturally reach for this tool.
- **Tool description explicitly says "read the frame images to see the designs."** This is critical. The description guides Claude's behavior after calling the tool. By telling it to read the files, Claude will use its built-in Read tool to view the images without the user needing to ask.
- **`sensitivity` as low/medium/high** instead of a raw scene threshold number. Users (and Claude) shouldn't need to know FFmpeg internals.
- **`maxFrames` default raised to 12** (was 8 in the token-constrained plan). Since frames are on disk, not in the MCP response, we can afford more frames without penalty. 12 is generous enough for multi-screen flows.
- **Response is pure text.** Frame paths, dimensions, sizes, and a clear instruction to read them. This is a few hundred tokens at most -- well within the default 25K limit.
- **Frame metadata in the response** (dimensions, file sizes) gives Claude useful context even before reading the images. It can see at a glance whether this is a mobile or desktop recording, how many distinct screens were captured, etc.

### Step 6: CLI entry point (`src/cli.ts`)

The CLI has one meaningful command: `init`. It writes a `.mcp.json` file and updates `.gitignore`.

```ts
#!/usr/bin/env node

import { writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);

if (args.includes("--server")) {
  // Start the MCP server (invoked by Claude Code via .mcp.json)
  await import("./index.js");
} else if (args[0] === "init") {
  init();
} else {
  printHelp();
}

function init() {
  const cwd = process.cwd();

  // 1. Write or update .mcp.json
  writeMcpConfig(cwd);

  // 2. Add .design-extract/ to .gitignore
  updateGitignore(cwd);

  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code (or start a new conversation)");
  console.log("  2. Record a screen capture of the design you want to reference");
  console.log('  3. Tell Claude: "extract the design from ./recording.mp4 and build the homepage"');
}

function writeMcpConfig(cwd: string) {
  const mcpPath = join(cwd, ".mcp.json");

  const serverConfig = {
    command: "npx",
    args: ["-y", "design-extract@latest", "--server"],
  };

  if (existsSync(mcpPath)) {
    const existing = JSON.parse(readFileSync(mcpPath, "utf-8"));
    existing.mcpServers = existing.mcpServers || {};
    if (existing.mcpServers["design-extract"]) {
      console.log("design-extract is already configured in .mcp.json");
      return;
    }
    existing.mcpServers["design-extract"] = serverConfig;
    writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
    console.log("Added design-extract to existing .mcp.json");
  } else {
    const config = { mcpServers: { "design-extract": serverConfig } };
    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    console.log("Created .mcp.json with design-extract configured");
  }
}

function updateGitignore(cwd: string) {
  const gitignorePath = join(cwd, ".gitignore");
  const entry = ".design-extract/";

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(entry)) {
      // Already in .gitignore, nothing to do
      return;
    }
    // Append with a newline before if the file doesn't end with one
    const prefix = content.endsWith("\n") ? "" : "\n";
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
    console.log("Added .design-extract/ to .gitignore");
  } else {
    writeFileSync(gitignorePath, `${entry}\n`);
    console.log("Created .gitignore with .design-extract/");
  }
}

function printHelp() {
  console.log("design-extract - Extract design context from screen recordings for Claude Code");
  console.log("");
  console.log("Usage:");
  console.log("  design-extract init    Configure design-extract for this project");
  console.log("  design-extract help    Show this help message");
}
```

The `init` command does two things:
1. **Writes `.mcp.json`** (or merges into existing) with the design-extract server config
2. **Adds `.design-extract/` to `.gitignore`** (extracted frames are build artifacts, not source code)

When invoked as `npx -y design-extract@latest --server` (by Claude Code via `.mcp.json`), the `--server` flag is detected and the MCP server starts instead of the CLI.

### Step 7: Output directory management

The `.design-extract/` folder in the project root holds extracted frames. Key behaviors:

**Cleared on each extraction.** Every time `extract_design` is called, the folder is emptied first. This prevents stale frames from previous extractions from confusing Claude. If the user extracts from video A, then later extracts from video B, only video B's frames should be present.

**Created automatically.** The extraction pipeline creates `.design-extract/` if it doesn't exist.

**Gitignored.** The `init` command adds `.design-extract/` to `.gitignore`. Extracted frames are ephemeral artifacts -- they shouldn't be committed.

**Not a temp directory.** Unlike the previous plan that used `os.tmpdir()`, frames persist in the project so Claude can read them after the MCP tool call completes. The MCP tool runs, saves frames, and exits. Later (potentially seconds later), Claude uses the Read tool to view the frames. They must still be on disk at that point.

**Location relative to project root.** The MCP server uses `process.cwd()` to determine where `.design-extract/` goes. When Claude Code spawns the MCP server, the working directory should be the project root. This is the same directory where video files referenced as `./recording.mp4` would be resolved.

### Step 8: Error handling

Errors are returned as MCP tool results (not thrown), so Claude sees them and can communicate the problem to the user.

| Error | Detection | Message |
|-------|-----------|---------|
| FFmpeg not installed | `execFile` throws ENOENT | "FFmpeg is required but not found. Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)" |
| File not found | `fs.access` check before processing | "Video file not found: {resolved_path}. Check the path and try again." |
| Not a video file | `ffprobe` returns no video stream | "The file does not appear to be a video: {path}" |
| FFmpeg extraction fails | Non-zero exit code from ffmpeg | "FFmpeg failed to process the video: {stderr}" |
| No frames extracted | Empty frame list after scene detection | "No scene changes detected in the video. Try setting sensitivity to 'high', or the video may be too short/static." |
| Video too long | Duration > 120s from probe | Warning in response text, then truncate with `-t 120` flag. Do NOT fail. |
| File too large | `fs.stat` > 500MB | Warning in response text. Do NOT fail. |
| Output dir not writable | EACCES on mkdir/write | "Cannot write to .design-extract/ in the project directory. Check permissions." |

For the video-too-long case, include the warning in the successful response:
```
Note: Video is 185s long. Processing the first 120 seconds only. For best results, keep recordings under 2 minutes.
```

### Step 9: Testing infrastructure

Create a `scripts/test-extract.ts` script that runs the extraction pipeline directly (without the MCP layer) on a sample video:

```ts
// scripts/test-extract.ts
// Run with: npx tsx scripts/test-extract.ts ./sample.mp4
import { extractDesign } from "../src/extract.js";
import { resolve } from "path";

const videoPath = process.argv[2];
if (!videoPath) {
  console.error("Usage: npx tsx scripts/test-extract.ts <video-path>");
  process.exit(1);
}

const result = await extractDesign(resolve(videoPath), process.cwd());
console.log(`Extracted ${result.frames.length} frames from ${videoPath}`);
console.log(`Video: ${result.videoInfo.width}x${result.videoInfo.height}, ${Math.round(result.videoInfo.duration)}s`);
console.log(`Output: ${result.outputDir}`);
console.log("");
for (const frame of result.frames) {
  console.log(`  ${frame.relativePath}  ${frame.width}x${frame.height}  ${frame.sizeKB}KB`);
}
```

This lets you iterate on thresholds, quality, and dedup parameters without restarting the MCP server or starting new Claude Code conversations.

## Local Development and Testing Workflow

### Setup

1. Build the project:
   ```bash
   cd /Users/martinbabak/Desktop/projects/design-extract
   npm install
   npm run build
   ```

2. Test the extraction pipeline directly (no MCP):
   ```bash
   npx tsx scripts/test-extract.ts /path/to/sample-video.mp4
   ```
   Inspect the frames in `.design-extract/` to verify quality, dedup, and count.

### Testing with Claude Code

**Method 1: Direct .mcp.json (recommended)**

Create or edit `.mcp.json` in the project where you want to TEST (any project where you have a video file):
```json
{
  "mcpServers": {
    "design-extract": {
      "command": "node",
      "args": ["/Users/martinbabak/Desktop/projects/design-extract/dist/index.js"]
    }
  }
}
```

No `MAX_MCP_OUTPUT_TOKENS` setting needed. The default 25K works fine since we only return text.

**Method 2: claude mcp add (alternative)**

```bash
claude mcp add --scope local design-extract -- node /Users/martinbabak/Desktop/projects/design-extract/dist/index.js
```

**Verification:**

1. Start (or restart) Claude Code in the test project directory
2. Run `/mcp` -- should see `design-extract` with the `extract_design` tool
3. Tell Claude: "extract the design from ./recording.mp4"
4. Claude calls the tool, gets back file paths, then reads the images
5. Ask Claude to describe what it sees to verify it received the images

### Dev loop

1. Make changes to source files
2. `npm run build` (or `npm run dev` for watch mode)
3. Start a **new** Claude Code conversation (MCP servers spawn fresh per conversation)
4. Test with `/mcp` and then a real extraction

For fast pipeline iteration (no MCP layer needed):
```bash
npx tsx scripts/test-extract.ts ./sample-video.mp4
# Then inspect .design-extract/ folder
```

### MCP Inspector (optional, for debugging protocol issues)

```bash
npx @modelcontextprotocol/inspector node /Users/martinbabak/Desktop/projects/design-extract/dist/index.js
```
Opens a web UI for testing MCP tools interactively. Useful for debugging protocol-level issues but overkill for normal development.

## Files Affected

All new files (greenfield project):

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server entry point, tool registration, stdio transport |
| `src/extract.ts` | Core extraction pipeline orchestrator |
| `src/ffmpeg.ts` | FFmpeg/ffprobe operations (probe, scene extract) |
| `src/dedup.ts` | Perceptual hash deduplication (sharp-phash, hamming distance) |
| `src/cli.ts` | CLI entry point (init, --server, help) |
| `scripts/test-extract.ts` | Manual test script for pipeline iteration |
| `package.json` | Package manifest, dependencies, scripts |
| `tsconfig.json` | TypeScript config (strict, ES2022, bundler resolution) |
| `tsup.config.ts` | Build config (dual entry, ESM, node18 target) |
| `.mcp.json` | Example MCP config (for reference/docs) |
| `README.md` | Usage docs, install instructions, requirements |

Generated at runtime (not committed):
| Path | Purpose |
|------|---------|
| `.design-extract/frame-001.jpg` ... | Extracted design frames (gitignored) |

## Data Flow

```
User says: "extract the design from ./recording.mp4 and build the homepage"
         |
         v
Claude Code recognizes extract_design tool, calls it via MCP (stdio JSON-RPC)
         |
         v
MCP server receives { videoPath: "./recording.mp4", maxFrames: 12, sensitivity: "medium" }
         |
         v
extract.ts: resolves path to absolute, validates file exists
         |
         v
ffmpeg.ts: ffprobe -> validates it's a video, gets metadata (duration, dimensions)
         |
         v
extract.ts: clears .design-extract/ folder (removes stale frames from previous runs)
         |
         v
ffmpeg.ts: ffmpeg -vf "select=gt(scene,0.3)" -> extracts scene-change frames to temp dir
ffmpeg.ts: ffmpeg -frames:v 1 -> also extracts first frame to temp dir
         |
         v
dedup.ts: computes perceptual hash for each frame (sharp-phash)
          walks frames in order, drops frames with hamming distance <= 5 from last kept
         |
         v
extract.ts: if still > maxFrames, evenly sample (keep first + last + evenly spaced middle)
         |
         v
extract.ts: for each kept frame:
            sharp(framePath).resize(1280, withoutEnlargement).jpeg(80).toFile(.design-extract/frame-NNN.jpg)
         |
         v
extract.ts: clean up temp directory
         |
         v
MCP server returns: { content: [{ type: "text", text: "Extracted 6 frames... Read the frame images..." }] }
         |
         v
Claude Code receives text response (few hundred tokens, well within 25K default limit)
         |
         v
Claude uses its built-in Read tool to view .design-extract/frame-001.jpg, frame-002.jpg, etc.
Claude sees the designs as images (Read tool supports visual display of image files)
         |
         v
Claude uses the visual context to build the UI as requested
```

## Edge Cases & Error Handling

### Video edge cases
- **Very short video (< 1 second):** Scene detection may find 0 changes. Fallback: extract first frame only, return it with a note that only one frame was found.
- **Very long video (> 120 seconds):** Warn in the response, then process only the first 120 seconds. Add `-t 120` to the FFmpeg command. Do not fail.
- **Static video (no scene changes):** Scene detection returns 0 frames beyond the first. Fallback: extract frames at regular intervals (every 5 seconds) instead of relying on scene changes. This handles recordings of static dashboards, loading states, etc.
- **High FPS screen recording (60fps):** Scene detection still works fine. FFmpeg evaluates each frame's scene score regardless of framerate.
- **Non-standard formats (webm, mkv, avi, gif):** FFmpeg handles all of these natively. No special handling needed.
- **Portrait/mobile recordings:** `withoutEnlargement: true` and width-based resize handle this correctly. A 390px-wide mobile recording stays at 390px.

### Filesystem edge cases
- **Path with spaces:** Use `execFile` (not `exec`) to avoid shell escaping issues. Pass args as array, not string.
- **Relative path resolution:** The MCP tool receives a path that may be relative. Resolve against `process.cwd()`, which should be the project root when spawned by Claude Code.
- **Symlinks:** `fs.realpath` before processing to resolve symlinks.
- **Permission denied:** Catch EACCES from fs operations, return clear error.

### Output directory edge cases
- **`.design-extract/` already exists with files from previous run:** Cleared at the start of each extraction. All existing files removed before new frames are written.
- **`.design-extract/` has non-frame files (user put something there manually):** The clear step removes ALL files in the directory. This is intentional -- the directory is owned by the tool. Document this in the README.
- **Concurrent invocations:** Unlikely (one user, one Claude Code session), but if it happens, the second invocation would clear frames from the first while it's still running. This is a race condition. Mitigation: not worth engineering for v0.1. If it comes up, add file locking later.

### Temp directory management
- **Temp directory cleanup:** Use a try/finally block to ensure the temp dir (in `os.tmpdir()`) is always cleaned up, even on error. The temp dir holds raw FFmpeg output before processing. It should never persist.
- **Disk space:** Scene extraction of a 2-minute 1080p video produces ~50-200 PNG files at ~500KB-2MB each = potentially 100-400MB temp space. This is briefly needed and cleaned up after processing. To reduce peak temp usage, consider extracting as JPEG directly from FFmpeg (change output to `.jpg` and add `-q:v 5`).

## Testing Considerations

### Manual test matrix

Test with these types of recordings:
1. **Simple screen scroll** -- website scroll-through, should produce 3-5 distinct frames after dedup
2. **Multi-page flow** -- clicking through several pages, should produce one frame per page
3. **Modal/overlay interaction** -- opening and closing modals over a page
4. **Mobile recording** -- narrow portrait video, verify resize handles it
5. **Figma prototype** -- clickthrough of a Figma prototype recording
6. **Short recording (2-3 seconds)** -- verify at least 1 frame is returned
7. **Long recording (2+ minutes)** -- verify truncation warning and frame cap
8. **Static screen** -- recording where nothing changes, verify fallback to interval extraction

### Acceptance criteria
- Tool appears in `/mcp` output when configured
- Claude calls the tool, receives file paths, then reads the images via Read tool
- Claude can describe the designs after reading the frame images
- 10-second recording of a website scroll produces 3-8 frames
- 30-second multi-page flow produces 5-12 frames
- No duplicate/near-identical frames in output
- MCP response is pure text, fits within default 25K token limit
- `.design-extract/` folder is created in the project root
- Previous frames are cleared on each new extraction
- `design-extract init` adds both `.mcp.json` config and `.gitignore` entry
- Temp files (in os.tmpdir) are cleaned up after every invocation (success or failure)
- Clear error message when FFmpeg is not installed
- Clear error message for non-video files

## Migration / Breaking Changes

Not applicable (greenfield project).

## Open Questions

1. **`process.cwd()` in MCP context.** When Claude Code spawns the MCP server via stdio, what is the working directory? It should be the project root (same as Claude Code's cwd), but this needs verification during local development. Both relative video path resolution AND the `.design-extract/` output directory location depend on this. If the MCP server's cwd differs from the project root, both features break. Test this first.

2. **Claude's Read tool behavior with multiple images.** Claude Code's Read tool reads one file at a time. After extraction, Claude will need to make multiple Read calls (one per frame). With 12 frames, that's 12 tool calls. Verify that Claude handles this naturally -- it should, since the tool response explicitly tells it to read the frame images. But if Claude only reads a few and stops, the tool description or response text may need to be more explicit (e.g., "Read ALL frame images before proceeding").

3. **First-frame extraction overlap.** The first-frame extraction (`frame_0000.png`) and the scene-detection extraction (`frame_0001.png` onward) write to the same temp directory. If the first detected scene change IS the first frame, we'll have a near-duplicate. The dedup step handles this, but it's worth being aware of.

4. **Publishing to npm.** The `sharp` package includes native binaries and can be tricky with npm publishing (platform-specific optional dependencies). Test with `npx` on a clean machine to verify the full install-and-run flow before announcing the tool.

5. **Output directory ownership.** The tool clears ALL files in `.design-extract/` on each run. If a user manually places files there, they'll be deleted. This is by design (the tool owns the directory), but should be documented clearly in the README.
