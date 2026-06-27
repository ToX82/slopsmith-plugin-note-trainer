'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEar, TIERS } = require('../../utils/ear.js');

// Deterministic ear trainer rooted at C4. rng=0 -> always picks pool[0] (the
// root, offset 0 = C, pitch class 0).
function makeEar(extra) {
    return createEar(Object.assign({
        rootMidi: 60, tier: 'easy', rounds: 3, rng: () => 0,
    }, extra));
}

test('easy tier pool is root, major third, perfect fifth (C E G)', () => {
    const e = makeEar();
    assert.deepEqual(e.pool.map(n => n.name), ['C', 'E', 'G']);
    assert.deepEqual(e.pool.map(n => n.pc), [0, 4, 7]);
    assert.equal(e.rootName, 'C');
});

test('a correct guess scores and builds a streak', () => {
    const e = makeEar();
    const t = e.nextRound();         // C (pc 0)
    assert.equal(t.pc, 0);
    const ev = e.guess(0);
    assert.equal(ev.correct, true);
    assert.equal(ev.expectedName, 'C');
    assert.equal(e.state.score, 100);
    assert.equal(e.state.combo, 1);
    assert.equal(e.state.correctCount, 1);
});

test('a wrong guess with tries left keeps the round open and scores nothing', () => {
    const e = makeEar();
    e.nextRound();                   // C (pc 0)
    e.guess(0);                      // build a streak (first-try correct)
    e.nextRound();
    const ev = e.guess(7);           // say G, but it's C — 1st of 3 tries
    assert.equal(ev.correct, false);
    assert.equal(ev.resolved, false);
    assert.equal(ev.exhausted, false);
    assert.equal(ev.attempt, 1);
    assert.equal(ev.attemptsLeft, 2);
    assert.equal(ev.scoreDelta, 0);
    // Round not committed yet: combo intact, no wrong tallied.
    assert.equal(e.state.combo, 1);
    assert.equal(e.state.wrongCount, 0);
    assert.equal(e.isFinished(), false);
});

test('round resolves wrong only after maxAttempts wrong guesses', () => {
    const e = makeEar();
    e.nextRound();                   // C (pc 0)
    e.guess(0);                      // build a streak
    e.nextRound();                   // C again
    e.guess(4);                      // wrong (1/3)
    e.guess(7);                      // wrong (2/3)
    const ev = e.guess(4);           // wrong (3/3) -> exhausted
    assert.equal(ev.resolved, true);
    assert.equal(ev.exhausted, true);
    assert.equal(ev.expectedName, 'C');
    assert.equal(e.state.combo, 0);  // streak broken now
    assert.equal(e.state.wrongCount, 1);
});

test('a correct guess on a later attempt still scores, scaled down', () => {
    const e = makeEar();
    e.nextRound();                   // C (pc 0)
    e.guess(4);                      // wrong (1/3)
    const ev = e.guess(0);           // correct on 2nd try
    assert.equal(ev.correct, true);
    assert.equal(ev.resolved, true);
    assert.equal(ev.attempt, 2);
    assert.equal(ev.scoreDelta, 50); // basePoints 100 * 0.5 second-try factor
    assert.equal(e.state.score, 50);
    assert.equal(e.state.combo, 1);
    assert.equal(e.state.correctCount, 1);
});

test('streak multiplier ramps 1x -> 2x -> 3x', () => {
    const e = makeEar({ rounds: 10 });
    assert.equal(e.comboMultiplier(), 1);
    for (let i = 0; i < 3; i++) { e.nextRound(); e.guess(0); }
    assert.equal(e.state.combo, 3);
    assert.equal(e.comboMultiplier(), 2);
    for (let i = 0; i < 3; i++) { e.nextRound(); e.guess(0); }
    assert.equal(e.state.combo, 6);
    assert.equal(e.comboMultiplier(), 3);
});

test('session finishes after `rounds` answers, full accuracy -> gold', () => {
    const e = makeEar({ rounds: 3 });
    for (let i = 0; i < 2; i++) { e.nextRound(); e.guess(0); }
    assert.equal(e.isFinished(), false);
    e.nextRound();
    const ev = e.guess(0);
    assert.equal(ev.finished, true);
    assert.equal(e.isFinished(), true);
    const res = e.result();
    assert.equal(res.accuracy, 1);
    assert.equal(res.medal, 'gold');
    assert.equal(res.correct, 3);
});

test('guessing after the session is finished is a no-op', () => {
    const e = makeEar({ rounds: 1 });
    e.nextRound();
    e.guess(0);
    assert.equal(e.isFinished(), true);
    const ev = e.guess(4);
    assert.equal(ev.committed, false);
    assert.equal(e.state.correctCount, 1);
});

test('per-interval stats accumulate and surface in the result', () => {
    const e = makeEar({ rounds: 2 });
    e.nextRound();                   // C (pc 0)
    e.guess(0);                      // correct on 1st try
    e.nextRound();                   // C again (rng=0 + repeat-guard -> offset 0)
    e.guess(4); e.guess(7); e.guess(4);   // three wrong -> exhausted
    assert.deepEqual(e.state.stats[0], { correct: 1, wrong: 1 });
    const res = e.result();
    const row = res.intervals.find(r => r.offset === 0);
    assert.equal(row.attempts, 2);
    assert.equal(row.correct, 1);
    assert.equal(row.accuracy, 0.5);
    // Only tried intervals are reported, weakest first.
    assert.equal(res.intervals.length, 1);
    assert.equal(res.weakest[0].offset, 0);
});

test('adaptive picking favours the weak interval', () => {
    // Weights: offset 0 and 4 mastered (weight 1 each), offset 7 always missed
    // (weight 3). Cumulative [1,2,5]; rng 0.5 -> r=2.5 lands in the offset-7 band.
    const e = createEar({
        rootMidi: 60, tier: 'easy', rng: () => 0.5,
        priorStats: { 0: { correct: 10, wrong: 0 }, 4: { correct: 10, wrong: 0 }, 7: { correct: 0, wrong: 10 } },
    });
    const t = e.nextRound();
    assert.equal(t.offset, 7);
    assert.equal(t.name, 'G');
});

test('adaptive can be turned off for uniform picking', () => {
    // Same rng 0.5 but no weighting -> middle of three -> offset 4 (E).
    const e = createEar({ rootMidi: 60, tier: 'easy', rng: () => 0.5, adaptive: false });
    assert.equal(e.nextRound().offset, 4);
});

test('medium tier is the major scale, hard tier is all 12 notes', () => {
    assert.deepEqual(TIERS.medium.offsets, [0, 2, 4, 5, 7, 9, 11]);
    assert.equal(createEar({ tier: 'hard' }).pool.length, 12);
});

test('each pool entry carries the interval label matching its offset', () => {
    const e = makeEar();
    // easy offsets [0,4,7] -> Unison, Major 3rd, Perfect 5th
    assert.deepEqual(e.pool.map(n => n.interval.abbr), ['P1', 'M3', 'P5']);
    assert.equal(e.pool[1].interval.long, 'Major 3rd');
    assert.equal(e.pool[2].interval.long, 'Perfect 5th');
    // The interval offset equals the pool offset (root-relative distance).
    e.pool.forEach(n => assert.equal(n.interval, require('../../utils/note-math.js').intervalName(n.offset)));
});
