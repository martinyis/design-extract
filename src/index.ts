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
  "Extract key frames from a screen recording video. Saves frames as images to .design-extract/ in the project directory. After calling this tool, read the frame images to see the designs and use them as visual context. Accepts common video formats (mp4, mov, webm, mkv, avi). Use the 'purpose' parameter to get tailored analysis instructions: 'design' for design system overview, 'copy' for pixel-accurate reproduction, 'bug' for bug diagnosis. Omit purpose for raw frames only.",
  {
    videoPath: z
      .string()
      .describe(
        "Path to the video file (absolute or relative to the current working directory)"
      ),
    maxFrames: z
      .number()
      .optional()
      .default(12)
      .describe("Maximum number of frames to extract (default: 12)"),
    sensitivity: z
      .enum(["low", "medium", "high"])
      .optional()
      .default("medium")
      .describe(
        "Scene detection sensitivity. 'low' captures only major screen changes. 'medium' (default) is good for most recordings. 'high' captures subtle transitions."
      ),
    purpose: z
      .enum(["design", "copy", "bug"])
      .optional()
      .describe(
        "Analysis purpose. 'design' for design system overview (colors, fonts, spacing, components). 'copy' for pixel-accurate UI reproduction. 'bug' for bug diagnosis from a screen recording. Omit for raw frame extraction only."
      ),
  },
  async ({ videoPath, maxFrames, sensitivity, purpose }) => {
    try {
      const sceneThreshold = { low: 0.5, medium: 0.3, high: 0.15 }[
        sensitivity
      ];

      const result = await extractDesign(videoPath, process.cwd(), {
        maxFrames,
        sceneThreshold,
        purpose,
      });

      const frameList = result.frames
        .map(
          (f) =>
            `  ${f.relativePath} (${f.width}x${f.height}, ${f.sizeKB}KB)`
        )
        .join("\n");

      const warningText =
        result.warnings.length > 0
          ? "\n\nNotes:\n" +
            result.warnings.map((w) => `- ${w}`).join("\n") +
            "\n"
          : "";

      const instructionSteps = purpose
        ? [
            `Now do the following:`,
            `1. Read .design-extract/ANALYSIS_INSTRUCTIONS.md for detailed analysis instructions.`,
            `2. Read ALL frame images listed above using the Read tool.`,
            `3. Follow the instructions to produce a thorough analysis before writing any code.`,
          ]
        : [`Now read ALL frame images listed above using the Read tool to see the content.`];

      const text = [
        `Extracted ${result.frames.length} frames from the video.`,
        `Source: ${videoPath} (${result.videoInfo.width}x${result.videoInfo.height}, ${Math.round(result.videoInfo.duration)}s)`,
        ``,
        `Frames saved to .design-extract/:`,
        frameList,
        warningText,
        ``,
        ...instructionSteps,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error extracting design: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
