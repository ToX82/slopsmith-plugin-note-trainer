'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGame } = require('../../utils/game.js');

const OPEN = [40, 45, 50, 55, 59, 64]; // standard guitar

// Deterministic game: only the low E string, natural notes, rng=0 -> always
// targets the first note (C, pitch class 0) on string 0.
function makeGame(extra) {
    return createGame(Object.assign({
        openMidi: OPEN, maxFret: 12, noteSet: 'natural', strings: [0],
        mode: 'relax', count: 2, promote: 0.8,
        stableFrames: 2, rearmFrames: 1, centsTol: 45,
        rng: () => 0, now: () => 1000,
    }, extra));
}

// Arm the debounce (a frame of silence) then hold a steady pitch until it commits.
function playNote(g, midi, frames) {
    g.feed({ midi: null, cents: 0, hasSignal: false });             // re-arm
    let ev = { committed: false };
    const n = frames || 2;
    for (let i = 0; i < n; i++) ev = g.feed({ midi, cents: 0, hasSignal: true });
    return ev;
}

test('targets the expected note (C on low E)', () => {
    const g = makeGame();
    const t = g.nextTarget();
    assert.equal(t.stringIndex, 0);
    assert.equal(t.pitchClass, 0);
    assert.equal(t.name, 'C');
    assert.equal(t.openMidi, 40);
});

test('a steady correct pitch commits as correct and scores', () => {
    const g = makeGame();
    g.nextTarget();
    const ev = playNote(g, 48); // C3 on low E
    assert.equal(ev.committed, true);
    assert.equal(ev.verdict, 'correct');
    assert.equal(g.state.correctCount, 1);
    assert.equal(g.state.combo, 1);
    assert.equal(g.state.score, 100); // base 100 * 1x, no time bonus in relax
});

test('debounce: fewer than stableFrames does not commit', () => {
    const g = makeGame();
    g.nextTarget();
    g.feed({ midi: null, cents: 0, hasSignal: false }); // arm
    const ev = g.feed({ midi: 48, cents: 0, hasSignal: true }); // only 1 frame
    assert.equal(ev.committed, false);
});

test('cents beyond tolerance never commit', () => {
    const g = makeGame();
    g.nextTarget();
    g.feed({ midi: null, cents: 0, hasSignal: false });
    const ev1 = g.feed({ midi: 48, cents: 80, hasSignal: true });
    const ev2 = g.feed({ midi: 48, cents: 80, hasSignal: true });
    assert.equal(ev1.committed, false);
    assert.equal(ev2.committed, false);
});

test('wrong pitch class -> wrong-note, combo resets', () => {
    const g = makeGame();
    g.nextTarget();
    const ev = playNote(g, 50); // D3, pitch class 2
    assert.equal(ev.verdict, 'wrong-note');
    assert.equal(g.state.combo, 0);
    assert.equal(g.state.wrongCount, 1);
});

test('right note out of string range -> wrong-string', () => {
    const g = makeGame();
    g.nextTarget();
    const ev = playNote(g, 60); // C4, above low E + 12 frets
    assert.equal(ev.verdict, 'wrong-string');
});

test('reveal fires after hintThreshold failed attempts', () => {
    const g = makeGame({ hintThreshold: 2 });
    g.nextTarget();
    const ev1 = playNote(g, 50);
    const ev2 = playNote(g, 50);
    assert.equal(!!ev1.shouldReveal, false);
    assert.equal(ev2.shouldReveal, true);
});

test('targetFrets reports where the note sits on the string', () => {
    const g = makeGame();
    g.nextTarget();
    assert.deepEqual(g.targetFrets(), [8]); // C on low E within 12 frets
});

test('combo multiplier ramps 1x -> 2x -> 3x', () => {
    const g = makeGame({ count: 10 });
    g.nextTarget();
    assert.equal(g.comboMultiplier(), 1);
    for (let i = 0; i < 3; i++) { playNote(g, 48); }
    assert.equal(g.state.combo, 3);
    assert.equal(g.comboMultiplier(), 2);
    for (let i = 0; i < 3; i++) { playNote(g, 48); }
    assert.equal(g.state.combo, 6);
    assert.equal(g.comboMultiplier(), 3);
});

test('level completes after count correct, promoted with full accuracy', () => {
    const g = makeGame({ count: 2 });
    g.nextTarget();
    playNote(g, 48);
    assert.equal(g.isFinished(), false);
    playNote(g, 48);
    assert.equal(g.isFinished(), true);
    const res = g.levelResult();
    assert.equal(res.accuracy, 1);
    assert.equal(res.promoted, true);
    assert.equal(res.medal, 'gold');
});

test('stats accumulate per string:pitchClass', () => {
    const g = makeGame();
    g.nextTarget();
    playNote(g, 48); // correct
    playNote(g, 50); // wrong-note
    const s = g.state.stats['0:0'];
    assert.equal(s.correct, 1);
    assert.equal(s.wrong, 1);
});

test('pcs allowlist narrows targets to the listed pitch classes', () => {
    // Natural set on low E, but restrict to C (pc 0) and G (pc 7).
    const g = makeGame({ noteSet: 'natural', pcs: [0, 7], count: 6 });
    for (let i = 0; i < 12; i++) {
        const t = g.nextTarget();
        assert.ok(t.pitchClass === 0 || t.pitchClass === 7, 'unexpected target pc ' + t.pitchClass);
    }
});

test('an empty pcs filter falls back to the full note-set (never starves the pool)', () => {
    // pcs with no overlap vs 'natural' must not empty the pool.
    const g = makeGame({ noteSet: 'natural', pcs: [1, 3] }); // C#, D# aren't naturals
    const t = g.nextTarget();
    assert.ok(t && t.name, 'pool must still produce a target');
});
