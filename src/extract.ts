import { access, mkdir, readdir, unlink, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { probeVideo, extractSceneFrames, type VideoInfo } from "./ffmpeg.js";
import { deduplicateFrames } from "./dedup.js";

export interface ExtractOptions {
  maxFrames?: number;
  sceneThreshold?: number;
  dedupThreshold?: number;
  maxWidth?: number;
  quality?: number;
  purpose?: "design" | "copy" | "bug";
}

export interface FrameInfo {
  path: string;
  relativePath: string;
  index: number;
  width: number;
  height: number;
  sizeKB: number;
}

export interface ExtractResult {
  frames: FrameInfo[];
  outputDir: string;
  videoInfo: VideoInfo;
  warnings: string[];
}

const DEFAULTS = {
  maxFrames: 12,
  sceneThreshold: 0.3,
  dedupThreshold: 5,
  maxWidth: 1280,
  quality: 80,
};

function capFrames(frames: string[], maxFrames: number): string[] {
  if (frames.length <= maxFrames) return frames;

  const result: string[] = [frames[0]];
  const remaining = maxFrames - 2;
  const stride = (frames.length - 2) / (remaining + 1);

  for (let i = 1; i <= remaining; i++) {
    const idx = Math.round(i * stride);
    result.push(frames[idx]);
  }

  result.push(frames[frames.length - 1]);
  return result;
}

export async function extractDesign(
  videoPath: string,
  projectDir: string,
  options?: ExtractOptions
): Promise<ExtractResult> {
  const opts = { ...DEFAULTS, ...options };
  const warnings: string[] = [];

  // 1. Resolve and validate video path
  const absoluteVideoPath = resolve(projectDir, videoPath);
  try {
    await access(absoluteVideoPath);
  } catch {
    throw new Error(
      `Video file not found: ${absoluteVideoPath}. Check the path and try again.`
    );
  }

  // Check file size
  const fileStat = await stat(absoluteVideoPath);
  const sizeMB = fileStat.size / (1024 * 1024);
  if (sizeMB > 500) {
    warnings.push(
      `Video file is large (${Math.round(sizeMB)}MB). Processing may take a moment.`
    );
  }

  // 2. Probe video
  const videoInfo = await probeVideo(absoluteVideoPath);

  let maxDuration: number | undefined;
  if (videoInfo.duration > 120) {
    warnings.push(
      `Video is ${Math.round(videoInfo.duration)}s long. Processing the first 120 seconds only. For best results, keep recordings under 2 minutes.`
    );
    maxDuration = 120;
  }

  // 3. Prepare output directory (.design-extract/ in project root)
  const outputDir = join(projectDir, ".design-extract");
  try {
    const existing = await readdir(outputDir).catch(() => []);
    for (const file of existing) {
      await unlink(join(outputDir, file));
    }
  } catch {
    // Directory doesn't exist yet, that's fine
  }
  await mkdir(outputDir, { recursive: true });

  // 4. Create temp directory for raw FFmpeg output
  const tempDir = await mkdtemp(join(tmpdir(), "design-extract-"));

  try {
    // 5. Extract scene-change frames
    let framePaths = await extractSceneFrames(
      absoluteVideoPath,
      tempDir,
      opts.sceneThreshold,
      maxDuration
    );

    // 6. Handle edge case: no scene changes detected
    if (framePaths.length <= 1) {
      // Fallback: extract frames at regular intervals
      warnings.push(
        "No scene changes detected. Extracting frames at regular intervals instead."
      );
      framePaths = await extractIntervalFrames(
        absoluteVideoPath,
        tempDir,
        videoInfo.duration,
        opts.maxFrames
      );
    }

    if (framePaths.length === 0) {
      throw new Error(
        "No frames could be extracted from the video. The file may be corrupted or empty."
      );
    }

    // 7. Deduplicate
    framePaths = await deduplicateFrames(framePaths, opts.dedupThreshold);

    // 8. Cap frame count
    framePaths = capFrames(framePaths, opts.maxFrames);

    // 9. Resize and save to output directory
    const frames: FrameInfo[] = [];
    for (let i = 0; i < framePaths.length; i++) {
      const outputFilename = `frame-${String(i + 1).padStart(3, "0")}.jpg`;
      const outputPath = join(outputDir, outputFilename);

      const info = await sharp(framePaths[i])
        .resize({ width: opts.maxWidth, withoutEnlargement: true })
        .jpeg({ quality: opts.quality })
        .toFile(outputPath);

      const filestat = await stat(outputPath);

      frames.push({
        path: outputPath,
        relativePath: `.design-extract/${outputFilename}`,
        index: i,
        width: info.width,
        height: info.height,
        sizeKB: Math.round(filestat.size / 1024),
      });
    }

    // 10. Write analysis instructions file (only if purpose is specified)
    if (opts.purpose) {
      const instructions = PROMPT_TEMPLATES[opts.purpose];
      await writeFile(join(outputDir, "ANALYSIS_INSTRUCTIONS.md"), instructions);
    }

    return { frames, outputDir, videoInfo, warnings };
  } finally {
    // 10. Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractIntervalFrames(
  videoPath: string,
  outputDir: string,
  duration: number,
  maxFrames: number
): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const interval = Math.max(1, Math.floor(duration / maxFrames));
  const fps = 1 / interval;

  const ffmpegPath = (await import("ffmpeg-static")).default!;
  await execFileAsync(ffmpegPath, [
    "-y",
    "-i",
    videoPath,
    "-vf",
    `fps=${fps}`,
    "-q:v",
    "2",
    join(outputDir, "interval_%04d.png"),
  ]);

  const { readdir: readdirAsync } = await import("node:fs/promises");
  const files = await readdirAsync(outputDir);
  return files
    .filter((f) => f.startsWith("interval_") && f.endsWith(".png"))
    .sort()
    .map((f) => join(outputDir, f));
}

const DESIGN_PROMPT = `# Design Analysis Instructions

Read every frame image in this directory. Produce a design system overview covering the sections below.

## Typography
- Font families: heading font, body font (identify by letterform characteristics — serif vs sans-serif, geometric vs humanist, rounded vs sharp terminals). Name the most likely font.
- Type scale: approximate px sizes for h1, h2, h3, body, small/caption.
- Weights used (regular, medium, semibold, bold).
- Notable treatments (uppercase labels, tight letter-spacing headings, etc.).

## Color Palette
- Primary brand color(s) — hex values.
- Secondary/accent colors — hex values.
- Neutrals: background, surface, card, text, muted text, borders — hex values.
- Gradients or color patterns if present.

## Spacing & Layout
- Max content width.
- Spacing rhythm (base unit: 4px, 8px?).
- Section vertical rhythm.
- Grid patterns (column count, gutter).

## Components
- Buttons: variants, border-radius, sizing.
- Cards: shadow, radius, padding.
- Navigation: layout pattern, sticky behavior.
- Inputs: border style, radius.
- Icons: style (outlined/filled), apparent library.
- Other repeated components.

## Visual Style
- Overall aesthetic (minimal, corporate, playful, editorial, etc.).
- Border radius scale.
- Shadow style.
- Light/dark mode.
- Whitespace density (dense, balanced, spacious).
- Motion/animation patterns if visible.

---

Summarize findings as a concise design reference — something a developer could use to build new pages that feel consistent with this design system.
`;

const COPY_PROMPT = `# Design Analysis Instructions

Read every frame image in this directory. Then, before writing ANY code, produce a thorough design analysis covering everything below.

## Typography
- Identify the font family for headings (look at letter shapes: serif vs sans-serif, geometric vs humanist, rounded vs sharp terminals). Name the most likely font (e.g., "Inter", "SF Pro", "Poppins", "Helvetica Neue").
- Identify the font family for body text (may differ from headings).
- Font sizes: estimate the px sizes for h1, h2, h3, body text, captions, and any other text levels.
- Font weights used (light, regular, medium, semibold, bold).
- Line heights and letter spacing (tight, normal, relaxed).
- Text transforms (uppercase, lowercase, capitalize) where used.

## Color Palette
- Extract EVERY distinct color visible. Provide exact hex values by carefully analyzing the pixels.
- Primary brand color(s) — the dominant accent color.
- Secondary/accent colors.
- Background colors (main background, card backgrounds, section alternating backgrounds).
- Text colors (headings, body, muted/secondary text, links).
- Border/divider colors.
- Button colors (default, hover states if visible across frames).
- Gradient definitions if any gradients are used (direction, color stops).

## Layout & Spacing
- Overall page width / max-width (estimate in px).
- Grid system: how many columns, gutter width.
- Section padding (vertical spacing between major sections).
- Component internal padding.
- Spacing scale (identify the consistent spacing increments used: 4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px, etc.).
- Content alignment patterns (centered, left-aligned, mixed).

## Components & Patterns
- Navigation: layout, style, fixed/sticky behavior, mobile menu pattern.
- Buttons: border-radius, padding, sizes, variants (primary, secondary, ghost, outline).
- Cards: border-radius, shadow, border, padding.
- Input fields: style, border, border-radius, focus states.
- Icons: style (outlined, filled, duotone), size, source library if recognizable.
- Images: aspect ratios, border-radius, object-fit behavior.
- Badges/tags: style and colors.

## Visual Style & Feel
- Border radius scale (sharp/none, subtle 4-6px, rounded 8-12px, pill/full).
- Shadow style (none, subtle, elevated, layered).
- Overall aesthetic: minimal, brutalist, glassmorphic, neumorphic, corporate, playful, editorial, etc.
- Light or dark mode (or both).
- Use of whitespace (dense, balanced, spacious).
- Animation/transition style if visible across frames (subtle fades, slides, bounces).

## Page Sections (in order)
- List every distinct section visible across all frames: hero, features, testimonials, pricing, CTA, footer, etc.
- For each section: describe the layout pattern, content structure, and key visual details.

---

After completing this analysis, use it as your design spec to write pixel-accurate code that matches the original as closely as possible. Use the exact colors, closest matching Google Fonts (or system fonts), and precise spacing you identified.
`;

const BUG_PROMPT = `# Bug Analysis Instructions

Read every frame image in this directory. The frames are in temporal order — frame-001 is the earliest, the last frame is the final state. Analyze the recording as a sequence of events showing a bug or broken behavior.

## What is happening
- Describe the sequence of events shown across the frames, step by step.
- What is the user trying to do? What flow or feature is being exercised?
- What screen/page/component is involved?

## What looks wrong
- Identify the specific frame(s) where the problem is visible.
- Describe exactly what appears broken, glitched, or unexpected.
- Is it a visual bug (layout broken, element misplaced, wrong color/text), a functional bug (wrong state, missing data, incorrect behavior), or both?

## Expected vs actual behavior
- What should the UI look like or do at the point of failure?
- What is it actually showing or doing instead?
- Is the bug intermittent (visible in some frames but not others) or persistent?

## Likely cause
- Based on what you see, what is the most probable root cause?
- Is this a CSS/layout issue, a state management problem, a data issue, a race condition, a missing error handler, etc.?
- Which component(s) or code area(s) are likely involved?

## Suggested fixes
- Propose specific code changes to fix the bug.
- If multiple possible causes exist, list them in order of likelihood.
- Include any edge cases that should be tested after the fix.

---

Focus on being diagnostic and actionable. The goal is to identify the bug and fix it, not to analyze the design.
`;

const PROMPT_TEMPLATES: Record<"design" | "copy" | "bug", string> = {
  design: DESIGN_PROMPT,
  copy: COPY_PROMPT,
  bug: BUG_PROMPT,
};
