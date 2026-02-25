# design-extract

An MCP tool for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that extracts key frames from screen recordings so Claude can see and reference your designs.

Record your screen, point Claude at the video, and it will extract the important frames — then use them as visual context to build, copy, or debug UI.

## Setup

```bash
npx design-extract init
```

This configures the MCP server for your project. Restart Claude Code afterward.

That's it. FFmpeg is bundled — no system dependencies to install.

## Usage

Once set up, just tell Claude what you need. The tool has three modes:

### Copy a design

Record a screen capture of any website or app, then:

```
Extract the design from ./recording.mp4 and build the homepage
```

Claude will extract frames, analyze every visual detail (fonts, colors, spacing, components), and write pixel-accurate code that matches the original.

### Extract a design system

```
Extract the design system from ./recording.mp4
```

Claude produces a design reference covering typography, color palette, spacing, components, and visual style — useful when you want to build new pages that feel consistent with an existing design.

### Diagnose a bug

```
Extract the bug from ./recording.mp4 and fix it
```

Record the bug happening, and Claude will step through the frames to identify what went wrong, pinpoint the likely cause, and suggest fixes.

## How it works

1. **Scene detection** — FFmpeg identifies moments where the screen changes significantly, so you get one frame per distinct view instead of thousands of duplicate frames.
2. **Deduplication** — Perceptual hashing removes near-identical frames that scene detection missed.
3. **Smart sampling** — If there are still too many frames, it evenly samples across the recording to stay under the limit (default: 12 frames).
4. **Optimization** — Frames are resized to 1280px wide and saved as optimized JPEGs.

Frames are saved to `.design-extract/` in your project directory (automatically gitignored).

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `videoPath` | — | Path to the video file (mp4, mov, webm, mkv, avi) |
| `purpose` | — | `"copy"` for pixel-accurate reproduction, `"design"` for design system overview, `"bug"` for bug diagnosis |
| `sensitivity` | `"medium"` | Scene detection sensitivity: `"low"`, `"medium"`, or `"high"` |
| `maxFrames` | `12` | Maximum number of frames to extract |

## Requirements

- Node.js 18+
- Claude Code

## License

MIT
