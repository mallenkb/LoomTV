import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeXmlText, parseXmltvGuide, parseXmltvGuideChunks, parseXmltvTimestamp } from '../src/main/iptv/xmltvGuide.ts';

test('xmltv timestamps resolve through their declared offset', () => {
  assert.equal(parseXmltvTimestamp('20240115120000 +0000'), Date.UTC(2024, 0, 15, 12, 0, 0));
  assert.equal(parseXmltvTimestamp('20240115120000 -0500'), Date.UTC(2024, 0, 15, 17, 0, 0));
  assert.equal(parseXmltvTimestamp('20240115120000 +0530'), Date.UTC(2024, 0, 15, 6, 30, 0));
});

test('xmltv timestamps without an offset are read as local wall-clock time', () => {
  assert.equal(
    parseXmltvTimestamp('20240115120000'),
    new Date(2024, 0, 15, 12, 0, 0).getTime(),
  );
});

test('xmltv timestamps reject impossible and malformed values', () => {
  assert.equal(parseXmltvTimestamp('20241315120000 +0000'), null);
  assert.equal(parseXmltvTimestamp('20240115250000 +0000'), null);
  assert.equal(parseXmltvTimestamp('not a timestamp'), null);
});

test('xml entities decode, including numeric references', () => {
  assert.equal(decodeXmlText('Tom &amp; Jerry &#8212; &quot;Classics&quot;'), 'Tom & Jerry — "Classics"');
  assert.equal(decodeXmlText('&#x2014;'), '—');
});

test('xmltv guide reads programmes for the channels a playlist carries', () => {
  const guide = `<?xml version="1.0"?>
    <tv>
      <channel id="hbo.us"><display-name>HBO</display-name></channel>
      <programme start="20240115120000 +0000" stop="20240115133000 +0000" channel="hbo.us">
        <title lang="en">The Wire</title>
        <desc lang="en">Baltimore &amp; its institutions.</desc>
      </programme>
      <programme start="20240115120000 +0000" stop="20240115130000 +0000" channel="unlisted.us">
        <title>Not in this playlist</title>
      </programme>
    </tv>`;

  const result = parseXmltvGuide(guide, new Set(['hbo.us']));

  assert.equal(result.programmes.length, 1);
  assert.deepEqual(result.programmes[0], {
    tvgId: 'hbo.us',
    startMs: Date.UTC(2024, 0, 15, 12, 0, 0),
    endMs: Date.UTC(2024, 0, 15, 13, 30, 0),
    title: 'The Wire',
    description: 'Baltimore & its institutions.',
  });
  assert.equal(result.skipped, 1);
});

test('xmltv guide drops entries with no title or an unusable time range', () => {
  const guide = `<tv>
      <programme start="20240115120000 +0000" stop="20240115110000 +0000" channel="a"><title>Backwards</title></programme>
      <programme start="20240115120000 +0000" stop="20240115130000 +0000" channel="a"></programme>
      <programme start="broken" stop="20240115130000 +0000" channel="a"><title>Bad start</title></programme>
      <programme start="20240115140000 +0000" stop="20240115150000 +0000" channel="a"><title>Good</title></programme>
    </tv>`;

  const result = parseXmltvGuide(guide);

  assert.deepEqual(result.programmes.map((programme) => programme.title), ['Good']);
  assert.equal(result.skipped, 3);
});

test('xmltv guide read in chunks matches a single read at every split size', async () => {
  const xml = [
    '<?xml version="1.0"?><tv>',
    '<channel id="news.us@HD"><display-name>News</display-name></channel>',
    '<PROGRAMME start="20240115120000 +0000" stop="20240115130000 +0000" channel="news.us@HD">',
    '<title lang="en">Noon &amp; Later</title><desc>Caf&#233; talk</desc></PROGRAMME>',
    '<programme start="20240115130000 +0000" stop="20240115123000 +0000" channel="news.us"><title>Backwards</title></programme>',
    '<programme start="20240115130000 +0000" stop="20240115140000 +0000" channel="other.us"><title>Elsewhere</title></programme>',
    '<programme start="20240115140000 +0000" channel="news.us"><title>Unclosed',
    '<programme start="20240115150000 +0000" stop="20240115160000 +0000" channel="news.us"><title>Three</title></programme>',
    '<programme start="20240115160000 +0000" stop="20240115170000 +0000" channel="news.us"><title>Four <i>live</i></title></programme>',
    '</tv>',
  ].join('\n');
  const known = new Set(['news.us']);
  const expected = parseXmltvGuide(xml, known);
  assert.deepEqual(expected.programmes.map((entry) => entry.title), ['Noon & Later', 'Four live']);
  for (const size of [1, 2, 7, 13, 64, xml.length]) {
    async function* chunks() {
      for (let offset = 0; offset < xml.length; offset += size) yield xml.slice(offset, offset + size);
    }
    assert.deepEqual(await parseXmltvGuideChunks(chunks(), known), expected, `chunk size ${size}`);
  }
});
