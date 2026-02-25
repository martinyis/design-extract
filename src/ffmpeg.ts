import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              `FFmpeg is required but not found. Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)`
            )
          );
          return;
        }
        reject(new Error(`FFmpeg error: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function probeVideo(videoPath: string): Promise<VideoInfo> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ]);

  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find(
    (s: { codec_type: string }) => s.codec_type === "video"
  );

  if (!videoStream) {
    throw new Error(`The file does not appear to be a video: ${videoPath}`);
  }

  const duration = parseFloat(data.format?.duration ?? videoStream.duration ?? "0");
  const width = videoStream.width ?? 0;
  const height = videoStream.height ?? 0;

  let fps = 30;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    if (den && den > 0) fps = num / den;
  }

  return { duration, width, height, fps };
}

export async function extractSceneFrames(
  videoPath: string,
  outputDir: string,
  threshold: number,
  maxDuration?: number
): Promise<string[]> {
  // Extract first frame always
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    join(outputDir, "frame_0000.png"),
  ]);

  // Extract scene-change frames
  const sceneArgs = [
    "-y",
    "-i",
    videoPath,
    ...(maxDuration ? ["-t", String(maxDuration)] : []),
    "-vf",
    `select=gt(scene\\,${threshold})`,
    "-vsync",
    "vfr",
    "-q:v",
    "2",
    join(outputDir, "frame_%04d.png"),
  ];

  await run("ffmpeg", sceneArgs);

  // Read and sort extracted frames
  const files = await readdir(outputDir);
  const framePaths = files
    .filter((f) => f.startsWith("frame_") && f.endsWith(".png"))
    .sort()
    .map((f) => join(outputDir, f));

  return framePaths;
}
