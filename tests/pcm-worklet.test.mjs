import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8');

function runProcessor(rate, blockSizes, input) {
  const frames = [];
  let Processor;
  class FakeWorkletProcessor {
    constructor() { this.port = { postMessage: (bytes) => frames.push(bytes) }; }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeWorkletProcessor,
    registerProcessor: (name, type) => { assert.equal(name, 'pcm16k'); Processor = type; },
    sampleRate: rate,
  });
  const processor = new Processor();
  let offset = 0, blockIndex = 0;
  while (offset < input.length) {
    const count = Math.min(blockSizes[blockIndex++ % blockSizes.length], input.length - offset);
    processor.process([[input.subarray(offset, offset + count)]]);
    offset += count;
  }
  return frames.flatMap((frame) => {
    assert.equal(frame.byteLength, 1280);
    const view = new DataView(frame);
    return Array.from({ length: 640 }, (_, i) => view.getInt16(i * 2, true));
  });
}

test('resamples 48 and 44.1 kHz consistently across different process block sizes', () => {
  for (const rate of [48000, 44100]) {
    const input = Float32Array.from({ length: rate / 5 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / rate) * 0.8);
    const regular = runProcessor(rate, [128], input);
    const irregular = runProcessor(rate, [73, 177, 91], input);
    assert.deepEqual(irregular, regular);
    assert.equal(regular.length, 3200);
  }
});

test('encodes clamped signed 16-bit little-endian PCM', () => {
  const values = [-1, 0, 0.5, 1, 1.5, -2];
  const input = Float32Array.from({ length: 640 }, (_, i) => values[i % values.length]);
  const output = runProcessor(16000, [128], input);
  assert.deepEqual(output.slice(0, 6), [-32768, 0, 16384, 32767, 32767, -32768]);
});
