import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGitCommit, currentVersion } from '../src/version.js';
import { parseM3U, isVod } from '../src/m3u.js';
import { parseXmltv, parseXmltvTime } from '../src/xmltv.js';
import { normalizeName, matchChannels } from '../src/epgmatch.js';
import { categoryState, testRule, DEFAULT_EMPTY_EVENT_PATTERNS, DEFAULT_GUIDE_PATTERNS, compilePatterns, isEmptyEvent } from '../src/filters.js';
import { rewriteHls } from '../src/stream.js';
import { splitUrls, xcBase } from '../src/ingest.js';
import { firstText } from '../src/outputs/xc.js';
import { addCategories, parseJellyfin } from '../src/outputs/epg.js';

test('parseM3U reads header, attributes, commas in names and player options', () => {
  const { header, entries } = parseM3U([
    '﻿#EXTM3U url-tvg="http://x/guide.xml"',
    '#EXTINF:-1 tvg-id="cnn.us" tvg-name="CNN" tvg-logo="http://l/cnn.png" group-title="US, News",CNN, International',
    '#EXTVLCOPT:http-user-agent=Foo',
    'http://p/1.ts',
    '#EXTINF:-1,No Attrs',
    '#EXTGRP:Misc',
    'http://p/2.ts',
    '',
  ].join('\r\n'));
  assert.equal(header['url-tvg'], 'http://x/guide.xml');
  assert.equal(entries.length, 2);
  assert.deepEqual(
    { name: entries[0].name, group: entries[0].group, id: entries[0].attrs['tvg-id'], opts: entries[0].opts },
    { name: 'CNN, International', group: 'US, News', id: 'cnn.us', opts: ['#EXTVLCOPT:http-user-agent=Foo'] },
  );
  assert.equal(entries[1].group, 'Misc');
  assert.equal(entries[1].name, 'No Attrs');
});

test('isVod flags movie and series URLs but not live streams', () => {
  assert.ok(isVod('http://h/movie/u/p/1.mp4'));
  assert.ok(isVod('http://h/series/u/p/1.mkv'));
  assert.ok(!isVod('http://h/live/u/p/1.ts'));
  assert.ok(!isVod('http://h/u/p/1'));
});

test('parseXmltvTime handles offsets and missing zones', () => {
  assert.equal(parseXmltvTime('20240101120000 +0000'), Date.UTC(2024, 0, 1, 12) / 1000);
  assert.equal(parseXmltvTime('20240101120000 +0100'), Date.UTC(2024, 0, 1, 11) / 1000);
  assert.equal(parseXmltvTime('20240101120000 -0530'), Date.UTC(2024, 0, 1, 17, 30) / 1000);
  assert.equal(parseXmltvTime('20240101120000'), Date.UTC(2024, 0, 1, 12) / 1000);
  assert.equal(parseXmltvTime('garbage'), null);
});

test('parseXmltv keeps programme inner markup and survives bad entities', async () => {
  const xml = `<?xml version="1.0"?><tv>
    <channel id="a"><display-name>Alpha HD</display-name><display-name>A</display-name><icon src="http://i/a.png"/></channel>
    <programme start="20240101000000 +0000" stop="20240101010000 +0000" channel="a">
      <title lang="en">News &amp; Weather</title><desc>Bad &nbsp; entity</desc><category>News</category><icon src="x.png"/>
    </programme>
  </tv>`;
  const chans = [];
  const progs = [];
  await parseXmltv(Readable.from([xml]), { onChannel: (c) => chans.push(c), onProgramme: (p) => progs.push(p) });
  assert.deepEqual(chans, [{ id: 'a', names: ['Alpha HD', 'A'], icon: 'http://i/a.png' }]);
  assert.equal(progs.length, 1);
  assert.equal(progs[0].title, 'News & Weather');
  assert.match(progs[0].xml, /<title lang="en">News &amp; Weather<\/title>/);
  assert.match(progs[0].xml, /<icon src="x.png"\/>/);
  assert.match(progs[0].xml, /<category>News<\/category>/);
});

test('normalizeName strips country prefixes and quality tags', () => {
  assert.equal(normalizeName('US: ESPN HD'), 'espn');
  assert.equal(normalizeName('UK | Sky Sports Main Event FHD'), 'skysportsmainevent');
  assert.equal(normalizeName('|US| A&E (East)'), 'aande');
  assert.equal(normalizeName('CNN - HD', false), 'cnn');
});

test('matchChannels prefers manual, then tvg-id, then name', () => {
  const epg = [{ id: 'ESPN.us', names: ['ESPN'] }, { id: 'cnn.us', names: ['CNN'] }];
  const m = matchChannels([
    { id: 1, name: 'X', tvg_id: 'espn.US' },
    { id: 2, name: 'US: CNN HD', tvg_id: '' },
    { id: 3, name: 'Nothing', tvg_id: 'none' },
    { id: 4, name: 'CNN', tvg_id: 'ESPN.us', custom_epg_id: 'manual.id' },
  ], epg);
  assert.deepEqual(m.get(1), { epgId: 'ESPN.us', how: 'tvg-id' });
  assert.deepEqual(m.get(2), { epgId: 'cnn.us', how: 'name' });
  assert.deepEqual(m.get(3), { epgId: null, how: null });
  assert.deepEqual(m.get(4), { epgId: 'manual.id', how: 'manual' });
});

test('matchChannels matches a tvg-id against exact display names (HDHomeRun tuner numbers)', () => {
  const epg = [{ id: 'US101.hdhomerun.com', names: ['2.1', 'WCBS'] }, { id: 'US102.hdhomerun.com', names: ['12.1', 'WPIX'] }];
  const m = matchChannels([{ id: 1, name: 'WCBS-HD', tvg_id: '2.1' }, { id: 2, name: 'X', tvg_id: '12' }], epg);
  assert.deepEqual(m.get(1), { epgId: 'US101.hdhomerun.com', how: 'tvg-id' });
  assert.equal(m.get(2).how, null, 'no partial display-name matches');
});

test('default empty-event patterns', () => {
  const re = compilePatterns(DEFAULT_EMPTY_EVENT_PATTERNS);
  for (const idle of ['ESPN+ 03:', 'NFL Game Pass 07 -', 'PPV 12', 'NBA 04 NO EVENT', 'MLB 09 no event ', 'Event 1 : ']) {
    assert.ok(isEmptyEvent(idle, re), `${idle} should count as empty`);
  }
  for (const live of ['ESPN+ 03: Lakers vs Celtics', 'NFL Game Pass 07 - Bills at Jets', 'PPV 12: Title Fight', 'NO EVENT TONIGHT? no']) {
    assert.ok(!isEmptyEvent(live, re), `${live} should not count as empty`);
  }
  // Known trade-off of "ends with a number": a live event whose title ends in a number.
  assert.ok(isEmptyEvent('PPV 01: UFC 300', re));
  assert.deepEqual(compilePatterns(['(', 'ok$']).map(String), ['/ok$/i'], 'invalid patterns are skipped');
});

test('readGitCommit handles detached, loose and packed refs; version.json wins', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-ver-'));
  try {
    const git = path.join(root, '.git');
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'HEAD'), `${a}\n`);
    assert.equal(readGitCommit(root), a, 'detached HEAD');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(git, 'packed-refs'), `# pack-refs with: peeled\n${b} refs/heads/main\n`);
    assert.equal(readGitCommit(root), b, 'packed ref');
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), `${a}\n`);
    assert.equal(readGitCommit(root), a, 'loose ref beats packed');
    assert.deepEqual(currentVersion(root), { commit: a, source: 'git' });
    fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ commit: b }));
    assert.deepEqual(currentVersion(root), { commit: b, source: 'build' });
    assert.equal(readGitCommit(path.join(root, 'nope')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default guide-title patterns', () => {
  const re = compilePatterns(DEFAULT_GUIDE_PATTERNS);
  for (const t of ['No Game Today', 'NO GAME TODAY - check back', 'No Event', 'No Events Scheduled', 'No Live Event', 'Off Air']) {
    assert.ok(isEmptyEvent(t, re), `${t} should count as a placeholder`);
  }
  for (const t of ['Bills at Jets', 'Game Day Live', 'Big Event Tonight', 'Offside: The Show', 'Is There No Event Horizon?']) {
    assert.ok(!isEmptyEvent(t, re), `${t} should not count as a placeholder`);
  }
});

test('rule operators', () => {
  const r = (op, value) => ({ op, value });
  assert.ok(testRule(r('contains', 'sport'), 'US| SPORTS'));
  assert.ok(testRule(r('not_contains', 'adult'), 'US| SPORTS'));
  assert.ok(testRule(r('starts_with', 'us|'), 'US| SPORTS'));
  assert.ok(!testRule(r('not_starts_with', 'us'), 'US| SPORTS'));
  assert.ok(testRule(r('ends_with', ' hd'), 'US: CNN HD'));
  assert.ok(!testRule(r('ends_with', 'hd'), 'HD Movies'));
  assert.ok(testRule(r('not_ends_with', 'backup'), 'ESPN'));
  assert.ok(!testRule(r('not_ends_with', 'BACKUP'), 'ESPN backup'), 'case-insensitive');
  assert.ok(testRule(r('ends_with', ''), 'anything'), 'an empty value matches like the other operators');
  assert.ok(testRule(r('regex', '^(us|uk)\\|'), 'UK| NEWS'));
  assert.ok(!testRule(r('regex', '('), 'anything'));
});

test('categoryState: manual beats rules, exclude beats include, default when no includes', () => {
  const rules = [
    { id: 1, source_id: null, action: 'include', op: 'starts_with', value: 'US' },
    { id: 2, source_id: null, action: 'exclude', op: 'contains', value: 'adult' },
    { id: 3, source_id: 9, action: 'include', op: 'contains', value: 'only9' },
  ];
  const cat = (name, source_id = 1) => ({ name, source_id });
  assert.equal(categoryState(cat('US| NEWS'), rules, null, 0).included, true);
  assert.equal(categoryState(cat('US| ADULT'), rules, null, 0).included, false);
  assert.equal(categoryState(cat('UK| NEWS'), rules, null, 0).included, false);
  assert.equal(categoryState(cat('UK| NEWS'), rules, 'include', 0).reason, 'manual');
  assert.equal(categoryState(cat('US| NEWS'), rules, 'exclude', 0).included, false);
  assert.equal(categoryState(cat('only9 stuff', 9), rules, null, 0).included, true);
  assert.deepEqual(categoryState(cat('anything'), [], null, 1), { included: true, reason: 'default' });
  assert.deepEqual(categoryState(cat('anything'), [], null, 0), { included: false, reason: 'default' });
});

test('rewriteHls routes playlist and key URIs through the mapper', () => {
  const out = rewriteHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\n', 'http://up/a/index.m3u8', (u) => `P(${u})`);
  assert.match(out, /URI="P\(http:\/\/up\/a\/key.bin\)"/);
  assert.match(out, /^P\(http:\/\/up\/a\/seg1.ts\)$/m);
});

test('firstText pulls the first title/desc out of stored programme markup', () => {
  const xml = '<title lang="en">News &amp; Weather</title><title lang="fr">Infos</title><desc>Line &lt;1&gt;</desc>';
  assert.equal(firstText(xml, 'title'), 'News & Weather');
  assert.equal(firstText(xml, 'desc'), 'Line <1>');
  assert.equal(firstText(xml, 'sub-title'), '');
  assert.equal(firstText('<desc/>', 'desc'), '');
});

test('parseJellyfin keeps known categories in canonical order and spelling', () => {
  assert.deepEqual(parseJellyfin('kids, movie,bogus'), ['Movie', 'Kids']);
  assert.deepEqual(parseJellyfin(null), []);
});

test('addCategories inserts after title/desc, before later elements, without duplicates', () => {
  assert.equal(
    addCategories('<title>A</title><desc>B</desc><icon src="i"/><episode-num>1</episode-num>', ['Sports']),
    '<title>A</title><desc>B</desc><category lang="en">Sports</category><icon src="i"/><episode-num>1</episode-num>',
  );
  assert.equal(
    addCategories('<title>A</title><category>sports</category><rating><value>G</value></rating>', ['Sports', 'Kids']),
    '<title>A</title><category>sports</category><category lang="en">Kids</category><rating><value>G</value></rating>',
  );
  assert.equal(addCategories('', ['News']), '<category lang="en">News</category>');
  assert.equal(addCategories('<title>A</title><category>News</category>', ['news']), '<title>A</title><category>News</category>');
});

test('splitUrls and xcBase normalize user input', () => {
  assert.deepEqual(splitUrls('http://a/x.xml\n\nhttp://b/y.xml, http://c/z.xml'), ['http://a/x.xml', 'http://b/y.xml', 'http://c/z.xml']);
  assert.equal(xcBase('provider.tv:8080/'), 'http://provider.tv:8080');
  assert.equal(xcBase('https://p.tv/player_api.php?username=a'), 'https://p.tv');
});
