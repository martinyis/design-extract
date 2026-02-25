import sharp from "sharp";

/**
 * Compute a perceptual hash for an image using average hashing (aHash).
 * Resizes to 8x8 grayscale, computes the mean pixel value,
 * then generates a 64-bit hash based on whether each pixel is above the mean.
 */
async function perceptualHash(imagePath: string): Promise<string> {
  const { data } = await sharp(imagePath)
    .resize(8, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Compute mean pixel value
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  const mean = sum / data.length;

  // Generate binary hash string: 1 if pixel >= mean, 0 otherwise
  let hash = "";
  for (let i = 0; i < data.length; i++) {
    hash += data[i] >= mean ? "1" : "0";
  }

  return hash;
}

function hammingDistance(a: string, b: string): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

/**
 * Deduplicate frames by perceptual hash similarity.
 * Walks frames in order, drops any frame whose hamming distance
 * from the last kept frame is <= threshold (default 5).
 * Always keeps the first and last frame.
 */
export async function deduplicateFrames(
  framePaths: string[],
  threshold: number = 5
): Promise<string[]> {
  if (framePaths.length <= 2) return framePaths;

  // Compute hashes for all frames
  const hashes = await Promise.all(framePaths.map((p) => perceptualHash(p)));

  const kept: string[] = [framePaths[0]];
  let lastKeptHash = hashes[0];

  for (let i = 1; i < framePaths.length - 1; i++) {
    if (hammingDistance(lastKeptHash, hashes[i]) > threshold) {
      kept.push(framePaths[i]);
      lastKeptHash = hashes[i];
    }
  }

  // Always keep last frame
  const lastIndex = framePaths.length - 1;
  if (hammingDistance(lastKeptHash, hashes[lastIndex]) > threshold) {
    kept.push(framePaths[lastIndex]);
  } else if (kept[kept.length - 1] !== framePaths[lastIndex]) {
    // Replace the last kept frame with the actual last frame
    // to ensure the final state is always represented
    kept.push(framePaths[lastIndex]);
  }

  return kept;
}
