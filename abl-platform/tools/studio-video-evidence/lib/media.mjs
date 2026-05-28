import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function maybeConvertVideo(videoPath, targetDir) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return null;
  }

  const parsed = path.parse(videoPath);
  const mp4Path = path.join(targetDir, `${parsed.name}.mp4`);

  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', videoPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path],
      {
        stdio: 'ignore',
      },
    );
    return fs.existsSync(mp4Path) ? mp4Path : videoPath;
  } catch {
    return videoPath;
  }
}
