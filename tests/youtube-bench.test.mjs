import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subtitleWords } from '../bench/youtube.mjs';

test('YouTube VTT cues yield one reference transcript without rolling duplicates', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
[Music]

00:00:01.000 --> 00:00:02.000
<c>Hello &amp; welcome</c>

00:00:02.000 --> 00:00:03.000 align:start position:0%
Hello &amp; welcome <00:00:02.500>to LiveDub

00:00:03.000 --> 00:00:04.000
to LiveDub today

00:00:04.000 --> 00:00:05.000
Thanks for watching.
`;
  assert.deepEqual(subtitleWords(vtt), ['hello', 'welcome', 'to', 'livedub', 'today', 'thanks', 'for', 'watching']);
  assert.deepEqual(subtitleWords(vtt, 2, 2), ['hello', 'welcome', 'to', 'livedub', 'today']);
});
