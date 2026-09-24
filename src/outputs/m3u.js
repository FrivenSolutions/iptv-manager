export function streamExt(url) {
  const m = /\.(m3u8|ts|mp4|mkv)(?:\?|$)/i.exec(url || '');
  return m ? m[1].toLowerCase() : 'ts';
}

/** The URL an IPTV client should play for a channel in this output. */
export function streamUrl(base, output, ch) {
  if (output.stream_mode === 'direct') return ch.url;
  return `${base}/s/${output.token}/${ch.id}.${streamExt(ch.url)}`;
}

const attr = (s) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');

export function buildM3U(output, channels, base, urlFor = (ch) => streamUrl(base, output, ch)) {
  const epg = `${base}/o/${output.token}/epg.xml`;
  const out = [`#EXTM3U url-tvg="${epg}" x-tvg-url="${epg}"`];
  for (const ch of channels) {
    let line = `#EXTINF:-1 tvg-id="${attr(ch.tvg_id)}" tvg-name="${attr(ch.name)}" tvg-logo="${attr(ch.logo)}"`;
    if (ch.chno) line += ` tvg-chno="${attr(ch.chno)}"`;
    line += ` group-title="${attr(ch.group)}",${String(ch.name).replace(/[\r\n]+/g, ' ')}`;
    out.push(line);
    // Per-stream player options only make sense when the client talks to the provider itself.
    if (output.stream_mode === 'direct') out.push(...ch.opts);
    out.push(urlFor(ch));
  }
  return out.join('\n') + '\n';
}
