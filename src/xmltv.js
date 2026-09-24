import sax from 'sax';

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// XMLTV times look like "20240101120000 +0100"; the offset is optional (UTC then).
export function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{2}:?\d{2})?/.exec(String(s || '').trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', off] = m;
  let ts = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000;
  if (off) {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    ts -= sign * (+digits.slice(0, 2) * 3600 + +digits.slice(2, 4) * 60);
  }
  return ts;
}

function attrString(attrs) {
  let s = '';
  for (const [k, v] of Object.entries(attrs)) s += ` ${k}="${escapeXml(v)}"`;
  return s;
}

/**
 * Stream-parse an XMLTV document.
 *   onChannel({ id, names, icon })
 *   onProgramme({ channel, start, stop, title, desc, xml }) — xml is the element's inner markup
 * Either callback may return false to stop parsing early.
 * Uses sax's lenient mode because real-world EPGs are frequently not well-formed.
 */
export function parseXmltv(readable, { onChannel, onProgramme } = {}) {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(false, { lowercase: true, trim: false, normalize: false });
    let stopped = false;
    let chan = null;
    let prog = null;
    let depth = 0; // depth inside the current channel/programme
    let textTarget = null;
    let text = '';
    const selfClosing = [];

    const stop = () => {
      stopped = true;
      readable.unpipe(parser);
      readable.destroy();
      resolve();
    };

    parser.on('error', function () {
      // Recover and keep going; one bad entity should not lose the whole guide.
      this._parser.error = null;
      this._parser.resume();
    });

    parser.on('opentag', (node) => {
      if (stopped) return;
      const { name, attributes } = node;
      if (prog) {
        depth++;
        selfClosing.push(node.isSelfClosing);
        prog.xml += `<${name}${attrString(attributes)}${node.isSelfClosing ? '/>' : '>'}`;
        if (depth === 1 && (name === 'title' || name === 'desc')) {
          textTarget = name;
          text = '';
        }
        return;
      }
      if (chan) {
        depth++;
        if (name === 'display-name') {
          textTarget = 'display-name';
          text = '';
        } else if (name === 'icon' && attributes.src && !chan.icon) {
          chan.icon = attributes.src;
        }
        return;
      }
      if (name === 'channel') {
        chan = { id: attributes.id || '', names: [], icon: '' };
        depth = 0;
      } else if (name === 'programme') {
        prog = {
          channel: attributes.channel || '',
          start: attributes.start || '',
          stop: attributes.stop || '',
          title: null,
          desc: null,
          xml: '',
        };
        depth = 0;
      }
    });

    const onText = (t) => {
      if (stopped) return;
      if (prog) prog.xml += escapeXml(t);
      if (textTarget) text += t;
    };
    parser.on('text', onText);
    parser.on('cdata', onText);

    parser.on('closetag', (name) => {
      if (stopped) return;
      if (prog) {
        if (depth === 0 && name === 'programme') {
          const p = prog;
          prog = null;
          if (onProgramme && onProgramme(p) === false) stop();
          return;
        }
        if (!selfClosing.pop()) prog.xml += `</${name}>`;
        if (depth === 1 && textTarget === name) {
          if (name === 'title' && prog.title === null) prog.title = text.trim();
          if (name === 'desc' && prog.desc === null) prog.desc = text.trim();
          textTarget = null;
        }
        depth--;
        return;
      }
      if (chan) {
        if (depth === 0 && name === 'channel') {
          const c = chan;
          chan = null;
          if (onChannel && onChannel(c) === false) stop();
          return;
        }
        if (textTarget === 'display-name' && name === 'display-name') {
          const n = text.trim();
          if (n) chan.names.push(n);
          textTarget = null;
        }
        depth--;
      }
    });

    parser.on('end', () => {
      if (!stopped) resolve();
    });
    readable.on('error', (e) => {
      if (!stopped) reject(e);
    });
    readable.pipe(parser);
  });
}
