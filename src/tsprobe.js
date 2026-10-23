// What a live MPEG-TS stream carries, from its own tables: the PAT names the program's PMT, and
// the PMT lists each track's stream type. They repeat several times a second, so the first
// few hundred KB of a stream are enough. Used to send on unchanged only what players and
// recorders can use everywhere (H.264 or H.265 video, AAC sound), and convert the rest.

const PACKET = 188;

const VIDEO = { 0x01: 'mpeg2', 0x02: 'mpeg2', 0x10: 'mpeg4', 0x1b: 'h264', 0x24: 'hevc', 0xea: 'vc1' };
const AUDIO = { 0x03: 'mp2', 0x04: 'mp2', 0x0f: 'aac', 0x11: 'aac-latm', 0x81: 'ac3', 0x87: 'eac3' };
// DVB marks Dolby and DTS sound as "private data" (stream type 6) with a descriptor saying which.
const PRIVATE_AUDIO = { 0x6a: 'ac3', 0x7a: 'eac3', 0x7b: 'dts' };

// What plays everywhere without converting: the Watch page, phones, TVs, and recordings that
// Jellyfin or a NAS won't have to transcode on every playback.
const OK_VIDEO = new Set(['h264', 'hevc']);
const OK_AUDIO = new Set(['aac']);

function kindOf(type, descriptors) {
  if (VIDEO[type]) return { video: VIDEO[type] };
  if (AUDIO[type]) return { audio: AUDIO[type] };
  if (type === 0x06) {
    for (let i = 0; i + 2 <= descriptors.length; i += 2 + descriptors[i + 1]) {
      const audio = PRIVATE_AUDIO[descriptors[i]];
      if (audio) return { audio };
    }
  }
  return {}; // subtitles, teletext, data
}

/**
 * The codecs found: { video, audio, convert }. video/audio are the first video and audio tracks
 * (the ones a light or converted copy uses), null when there are none. convert: whether the
 * stream needs converting to play everywhere. A channel without video (radio) is never converted.
 */
export function judge(tracks) {
  const video = tracks.find((t) => t.video)?.video || null;
  const audio = tracks.find((t) => t.audio)?.audio || null;
  const convert = !!video && (!OK_VIDEO.has(video) || (!!audio && !OK_AUDIO.has(audio)));
  return { video, audio, convert };
}

/** Feed stream bytes with push(); it returns the codecs once the PMT has gone by, else null. */
export class TsProbe {
  constructor() {
    this.rest = Buffer.alloc(0);
    this.pmtPid = null;
  }

  push(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    // Packets start with a sync byte (0x47), and so does the one 188 bytes on: until both are
    // seen, move on a byte at a time (the stream may start in the middle of a packet).
    let at = 0;
    while (at + PACKET <= buf.length) {
      if (buf[at] !== 0x47 || (at + PACKET < buf.length && buf[at + PACKET] !== 0x47)) {
        at++;
        continue;
      }
      const found = this.packet(buf.subarray(at, at + PACKET));
      if (found) return found;
      at += PACKET;
    }
    this.rest = Buffer.from(buf.subarray(at)); // less than a packet, kept for the next chunk
    return null;
  }

  packet(p) {
    const pusi = (p[1] & 0x40) !== 0;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const afc = (p[3] >> 4) & 3;
    if (!pusi || !(afc & 1)) return null; // tables start in a packet that says so
    let start = 4 + (afc & 2 ? 1 + p[4] : 0);
    if (start >= PACKET) return null;
    start += 1 + p[start]; // pointer field
    if (start + 12 > PACKET) return null;
    const tableId = p[start];
    const sectionEnd = Math.min(PACKET, start + 3 + (((p[start + 1] & 0x0f) << 8) | p[start + 2]) - 4); // without the CRC
    if (pid === 0 && tableId === 0x00) {
      for (let i = start + 8; i + 4 <= sectionEnd; i += 4) {
        const program = (p[i] << 8) | p[i + 1];
        if (program !== 0) {
          this.pmtPid = ((p[i + 2] & 0x1f) << 8) | p[i + 3];
          break;
        }
      }
      return null;
    }
    if (pid === this.pmtPid && tableId === 0x02) {
      const programInfo = ((p[start + 10] & 0x0f) << 8) | p[start + 11];
      const tracks = [];
      for (let i = start + 12 + programInfo; i + 5 <= sectionEnd;) {
        const esInfo = ((p[i + 3] & 0x0f) << 8) | p[i + 4];
        tracks.push(kindOf(p[i], p.subarray(i + 5, Math.min(sectionEnd, i + 5 + esInfo))));
        i += 5 + esInfo;
      }
      return judge(tracks);
    }
    return null;
  }
}
