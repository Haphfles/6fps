export const VIDEO = Object.freeze({ width: 1080, height: 1920, fps: 6, frames: 90 });

export function validateMovieFrames(frames) {
  if (!Array.isArray(frames) || frames.length !== VIDEO.frames) {
    throw new Error('Finish all 90 frames before exporting.');
  }
  const ordered = [...frames].sort((a, b) => a.slot - b.slot);
  if (ordered.some((frame, index) => frame.slot !== index + 1)) {
    throw new Error('Every frame from 1 to 90 must be complete. Refresh and try again.');
  }
  return ordered;
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
}

export async function exportMovie({ frames, getImage, onProgress = () => {}, signal }) {
  const ordered = validateMovieFrames(frames);
  checkCancelled(signal);
  const { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, Quality, canEncodeVideo } = await import('./vendor/mediabunny.js');
  const quality = new Quality({ bitrate: 4_000_000 });
  const options = { width: VIDEO.width, height: VIDEO.height, frameRate: VIDEO.fps, quality };
  let codec, extension;
  for (const candidate of ['avc', 'vp9', 'vp8']) {
    checkCancelled(signal);
    if (await canEncodeVideo(candidate, options)) { codec = candidate; extension = candidate === 'avc' ? 'mp4' : 'webm'; break; }
  }
  if (!codec) throw new Error('Video export is unavailable in this browser. Open this movie in a current Safari or Chrome browser to export it.');

  const canvas = document.createElement('canvas');
  canvas.width = VIDEO.width; canvas.height = VIDEO.height;
  const context = canvas.getContext('2d', { alpha: false });
  const output = new Output({ format: extension === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, quality, latencyMode: 'quality', keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: VIDEO.fps });
  try {
    await output.start();
    for (let index = 0; index < ordered.length; index++) {
      checkCancelled(signal);
      const image = await getImage(ordered[index].slot);
      if (!image) throw new Error(`Frame ${ordered[index].slot} could not be loaded. Refresh and try again.`);
      checkCancelled(signal);
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, VIDEO.width, VIDEO.height);
      const scale = Math.min(VIDEO.width / image.width, VIDEO.height / image.height);
      context.drawImage(image, (VIDEO.width - image.width * scale) / 2, (VIDEO.height - image.height * scale) / 2, image.width * scale, image.height * scale);
      // Exact media timestamps: 90 frames × 1/6 second = 15 seconds, independent of encoding speed.
      await source.add(index / VIDEO.fps, 1 / VIDEO.fps, { keyFrame: index % 12 === 0 });
      onProgress(index + 1);
      // Let progress, cancellation and browser input render between full-HD frames.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    checkCancelled(signal);
    await output.finalize();
    checkCancelled(signal);
    return { blob: new Blob([output.target.buffer], { type: extension === 'mp4' ? 'video/mp4' : 'video/webm' }), extension };
  } finally {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    canvas.width = 0; canvas.height = 0;
  }
}
