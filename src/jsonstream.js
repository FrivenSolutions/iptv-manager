// Read a large JSON document one object at a time. Xtream Codes VOD lists can be tens of
// megabytes; parsing them whole would need several times that in memory.
import fs from 'node:fs';

/**
 * Yields [text, value] for every object directly inside the top-level array (or, for panels that
 * answer with an object keyed by id, every object value of it). `text` is the object's own JSON.
 */
export async function* jsonObjects(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1; // index in `buf` where the current element began, or -1
  let buf = '';
  for await (const chunk of stream) {
    const base = buf.length;
    buf += chunk;
    for (let i = base; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (inString) {
        if (escape) escape = false;
        else if (c === 92) escape = true; // \
        else if (c === 34) inString = false; // "
        continue;
      }
      if (c === 34) inString = true;
      else if (c === 123 || c === 91) { // { [
        if (depth === 1 && c === 123) start = i;
        depth++;
      } else if (c === 125 || c === 93) { // } ]
        depth--;
        if (depth === 1 && start >= 0 && c === 125) {
          const text = buf.slice(start, i + 1);
          start = -1;
          let value;
          try {
            value = JSON.parse(text);
          } catch {
            continue;
          }
          yield [text, value];
        }
      }
    }
    // Keep only the unfinished element (if any) for the next chunk.
    if (start >= 0) {
      buf = buf.slice(start);
      start = 0;
    } else {
      buf = '';
    }
  }
}
