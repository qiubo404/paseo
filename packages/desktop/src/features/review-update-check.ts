import { z } from "zod";
import type { AppUpdateCheckResult } from "./app-update-service.js";

const releaseSchema = z.object({
  tag_name: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  draft: z.literal(false),
  prerelease: z.literal(false),
  body: z.string().nullish(),
  published_at: z.string().nullish(),
});
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

async function readOfficialRelease(): Promise<unknown> {
  const response = await fetch("https://api.github.com/repos/getpaseo/paseo/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Paseo-Review" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Release check failed (HTTP ${response.status})`);
  return response.json();
}

export function createReviewUpdateChecker(
  readRelease: () => Promise<unknown> = readOfficialRelease,
  now: () => number = () => Date.now(),
) {
  let cached: { expiresAt: number; release: Promise<z.infer<typeof releaseSchema>> } | null = null;
  return async (currentVersion: string): Promise<AppUpdateCheckResult> => {
    const result: AppUpdateCheckResult = {
      notificationOnly: true,
      hasUpdate: false,
      readyToInstall: false,
      currentVersion,
      latestVersion: currentVersion,
      body: null,
      date: null,
      errorMessage: null,
    };
    try {
      if (!cached || now() >= cached.expiresAt) {
        cached = {
          expiresAt: now() + CHECK_INTERVAL_MS,
          release: readRelease().then((value) => releaseSchema.parse(value)),
        };
      }
      const release = await cached.release;
      const latestVersion = release.tag_name.replace(/^v/, "");
      const baseVersion = currentVersion.replace(/^v/, "").split("-review.")[0];
      if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) throw new Error("Invalid review base version");
      const latest = latestVersion.split(".").map(Number);
      const current = baseVersion.split(".").map(Number);
      const difference = latest.findIndex((value, index) => value !== current[index]);
      return {
        ...result,
        hasUpdate: difference >= 0 && latest[difference] > current[difference],
        latestVersion,
        body: release.body ?? null,
        date: release.published_at ?? null,
      };
    } catch (error) {
      cached = null;
      return { ...result, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  };
}

export const checkReviewRelease = createReviewUpdateChecker();
