// Builds MPEG-TS packets for tests: a PAT and a PMT listing tracks of chosen stream types.
const PMT_PID = 0x100;

function packet(pid, section) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = 0x40 | ((pid >> 8) & 0x1f); // payload unit start
  p[2] = pid & 0xff;
  p[3] = 0x10; // payload only
  p[4] = 0; // pointer field
  Buffer.from(section).copy(p, 5);
  return p;
}

// section_length counts everything after its own field, the CRC included (left as zeros here).
const withLength = (bytes) => {
  const len = bytes.length - 3;
  bytes[1] = 0xb0 | ((len >> 8) & 0x0f);
  bytes[2] = len & 0xff;
  return bytes;
};

export function patPacket() {
  return packet(0, withLength([0x00, 0, 0, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff, 0, 0, 0, 0]));
}

/** tracks: [{ type, descriptors: [bytes] }], e.g. { type: 0x02 } for MPEG-2 video. */
export function pmtPacket(tracks) {
  const body = [0x02, 0, 0, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00];
  tracks.forEach(({ type, descriptors = [] }, i) => {
    const pid = 0x101 + i;
    body.push(type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0 | (descriptors.length >> 8), descriptors.length & 0xff, ...descriptors);
  });
  body.push(0, 0, 0, 0);
  return packet(PMT_PID, withLength(body));
}

/** A stream start: a filler packet, then the tables, then more filler. */
export function tsStart(tracks) {
  const filler = Buffer.alloc(188, 0xff);
  filler[0] = 0x47;
  filler[1] = 0x1f;
  filler[2] = 0xff; // null packets
  filler[3] = 0x10;
  return Buffer.concat([filler, patPacket(), pmtPacket(tracks), filler, filler]);
}
