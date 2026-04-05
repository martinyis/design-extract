# design-extract

**Give Claude eyes.** Extract key frames from screen recordings so Claude Code can see, understand, and build from real designs.

Record your screen. Point Claude at the video. It extracts the important frames, analyzes every visual detail, and uses them as context to write code that matches the original design — pixel by pixel.

---

## The Problem

Claude Code can't watch videos. When you want it to replicate a design, diagnose a visual bug, or understand an existing UI, you're stuck describing things in words or manually screenshotting every state.

**design-extract** bridges that gap. It turns any screen recording into a set of intelligently-selected key frames that Claude can read and reason about — no manual screenshots, no copy-pasting, no lost context.

## How It Works

The extraction pipeline processes videos through four stages:

```
Screen Recording
      |
      v
Scene Detection ---- FFmpeg analyzes frame-to-frame pixel changes,
      |               extracting only the moments where the screen
      |               actually changes (not thousands of near-identical frames)
      v
Dedup (aHash) ------ Perceptual hashing compares visual similarity
      |               between frames, removing near-duplicates that
      |               scene detection missed (hamming distance threshold)
      v
Smart Sampling ----- If still over the frame limit, evenly samples
      |               across the timeline to preserve full coverage
      v
Optimization ------- Resizes to 1280px wide, JPEG q80
      |               Balances quality with Claude's processing speed
      v
  .design-extract/
  frame-001.jpg
  frame-002.jpg
  ...
```

The perceptual hash (aHash) is implemented from scratch using `sharp` — an 8x8 grayscale downscale, mean threshold, and 64-bit binary hash compared via hamming distance. This replaced `sharp-phash` which had Node.js compatibility issues.

## Three Modes

### Copy a design

Record any website or app, then tell Claude to reproduce it:

```
Extract the design from ./recording.mp4 and build the homepage
```

Claude analyzes every detail — fonts, colors, spacing, border radii, shadows, layout patterns — and writes code that matches the original. The analysis covers typography, full color palette with hex values, spacing rhythm, component styles, and page structure.

### Extract a design system

```
Extract the design system from ./recording.mp4
```

Produces a design reference document covering typography, color palette, spacing scale, component patterns, and visual style. Useful when building new pages that need to feel consistent with an existing design.

### Diagnose a bug

```
Extract the bug from ./recording.mp4 and fix it
```

Record the bug happening. Claude steps through frames in temporal order, identifies exactly where things went wrong, determines the likely root cause (CSS issue, state bug, race condition, etc.), and suggests specific fixes.

## Quick Start

```bash
npx design-extract init
```

This writes the MCP server config to `.mcp.json` and adds `.design-extract/` to `.gitignore`. Restart Claude Code, and you're done.

FFmpeg is bundled — zero system dependencies beyond Node.js.

## Architecture

```
src/
  index.ts      MCP server — tool registration, parameter validation (Zod),
                response formatting. Stdio transport.

  extract.ts    Pipeline orchestrator — resolves paths, probes video, runs
                scene detection → dedup → cap → resize → save. Writes
                analysis instructions based on purpose mode.

  ffmpeg.ts     FFmpeg/FFprobe wrapper — video probing (resolution, duration,
                fps) and scene-change frame extraction with configurable
                threshold.

  dedup.ts      Perceptual deduplication — aHash implementation using sharp,
                hamming distance comparison, sequential dedup with
                first/last frame preservation.

  cli.ts        CLI entry point — `init` command (writes .mcp.json,
                updates .gitignore) and --server flag to start MCP server.
```

Built with:
- **[Model Context Protocol SDK](https://modelcontextprotocol.io)** — the open standard for connecting AI tools
- **FFmpeg** (bundled via `ffmpeg-static`) — scene detection and frame extraction
- **sharp** — image processing, resizing, and perceptual hashing
- **Zod** — runtime parameter validation
- **tsup** — bundling

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `videoPath` | required | Path to the video file (mp4, mov, webm, mkv, avi) |
| `purpose` | — | `"copy"` for pixel-accurate reproduction, `"design"` for design system overview, `"bug"` for bug diagnosis |
| `sensitivity` | `"medium"` | Scene detection sensitivity: `"low"`, `"medium"`, or `"high"` |
| `maxFrames` | `12` | Maximum number of frames to extract |

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## License

MIT
