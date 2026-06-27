'use strict';

// Smoke test for the bundled YIN worker — confirms the copy still detects
// pitch and rejects silence. (Full coverage lives in the tuner plugin.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _yinDetect } = require('../../workers/yin.js');

const SAMPLE_RATE = 44100;
const FRAME = 4096;

function sine(freq, n, amp = 0.8) {
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
    return buf;
}

test('silence returns freq 0', () => {
    const r = _yinDetect(new Float32Array(FRAME), SAMPLE_RATE);
    assert.equal(r.freq, 0);
});

test('detects A4 (440 Hz) within 1.5%', () => {
    const r = _yinDetect(sine(440, FRAME), SAMPLE_RATE);
    assert.ok(r.freq > 0);
    assert.ok(Math.abs(r.freq - 440) / 440 * 100 < 1.5, `got ${r.freq.toFixed(2)} Hz`);
});

test('detects low E2 (82.41 Hz) within 1.5%', () => {
    const r = _yinDetect(sine(82.41, FRAME), SAMPLE_RATE);
    assert.ok(Math.abs(r.freq - 82.41) / 82.41 * 100 < 1.5, `got ${r.freq.toFixed(2)} Hz`);
});
