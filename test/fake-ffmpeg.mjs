// A stand-in for ffmpeg in tests: answers -version, "test encodes" (a VAAPI one fails, as on a
// machine without the GPU), and "transcodes" by echoing its input with a marker in front.
// Each run appends its arguments to the file in FAKE_FFMPEG_LOG.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, `${JSON.stringify(args)}\n`);

if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 7.1-fake Copyright (c) the FFmpeg developers\n');
} else if (args.includes('lavfi')) {
  if (args.includes('h264_vaapi')) {
    process.stderr.write('Failed to initialise VAAPI connection: -1 (unknown libva error).\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('frame=240\nspeed=3.50x\nprogress=end\n');
  }
} else if (process.env.FAKE_FFMPEG_NOREAD) {
  // An encoder buried under a burst: it never reads its input (until it is stopped).
  process.stdout.write(`LIGHT[${args[args.indexOf('-c:v') + 1]}];`);
  setInterval(() => process.stdout.write('.'), 100);
} else {
  process.stdout.write(`LIGHT[${args[args.indexOf('-c:v') + 1]}];`);
  process.stdin.on('data', (d) => process.stdout.write(d));
  process.stdin.on('end', () => process.exit(0));
}
