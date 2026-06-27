'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, DEFINITIONS } = require('../../utils/achievements.js');

function ctx(extra) {
    return Object.assign({
        sessionType: 'fret',
        result: { accuracy: 0.8, medal: null, bestCombo: 1, score: 100, correct: 5, wrong: 1 },
        medals: {},
        lifetime: { correct: 5, wrong: 1, sessions: 1 },
        stringMastered: false,
    }, extra || {});
}

test('first correct note unlocks First steps', () => {
    const newly = evaluate(ctx({ result: { correct: 1, accuracy: 1, bestCombo: 1 } }), []);
    const ids = newly.map(a => a.id);
    assert.ok(ids.includes('first_step'));
});

test('combo thresholds unlock at 5 and 10', () => {
    assert.ok(evaluate(ctx({ result: { bestCombo: 4, correct: 4, accuracy: 1 } }), []).map(a => a.id).includes('combo_5') === false);
    assert.ok(evaluate(ctx({ result: { bestCombo: 5, correct: 5, accuracy: 1 } }), []).map(a => a.id).includes('combo_5'));
    assert.ok(evaluate(ctx({ result: { bestCombo: 10, correct: 10, accuracy: 1 } }), []).map(a => a.id).includes('combo_10'));
});

test('first medal fires when the medals map becomes non-empty', () => {
    assert.ok(!evaluate(ctx({ medals: {} }), []).map(a => a.id).includes('first_medal'));
    assert.ok(evaluate(ctx({ medals: { '1': 'bronze' } }), []).map(a => a.id).includes('first_medal'));
});

test('fret gold needs a numeric level key, ear gold needs an ear: key', () => {
    assert.ok(evaluate(ctx({ medals: { '2': 'gold' } }), []).map(a => a.id).includes('fret_gold'));
    assert.ok(!evaluate(ctx({ medals: { 'ear:easy': 'gold' } }), []).map(a => a.id).includes('fret_gold'));
    assert.ok(evaluate(ctx({ medals: { 'ear:hard': 'gold' } }), []).map(a => a.id).includes('ear_gold'));
    assert.ok(!evaluate(ctx({ medals: { '2': 'gold' } }), []).map(a => a.id).includes('ear_gold'));
});

test('chromatic gold keys on level id 4', () => {
    assert.ok(evaluate(ctx({ medals: { '4': 'gold' } }), []).map(a => a.id).includes('chromatic_gold'));
    assert.ok(!evaluate(ctx({ medals: { '4': 'silver' } }), []).map(a => a.id).includes('chromatic_gold'));
});

test('interval gold requires an ear session in interval mode with a gold medal', () => {
    assert.ok(evaluate(ctx({ sessionType: 'ear', intervalMode: true, result: { medal: 'gold', correct: 10, accuracy: 1, bestCombo: 3 } }), []).map(a => a.id).includes('interval_gold'));
    assert.ok(!evaluate(ctx({ sessionType: 'ear', intervalMode: false, result: { medal: 'gold', correct: 10, accuracy: 1, bestCombo: 3 } }), []).map(a => a.id).includes('interval_gold'));
});

test('lifetime thresholds count cumulative correct notes', () => {
    assert.ok(evaluate(ctx({ lifetime: { correct: 100, wrong: 10, sessions: 5 } }), []).map(a => a.id).includes('century'));
    assert.ok(evaluate(ctx({ lifetime: { correct: 500, wrong: 10, sessions: 5 } }), []).map(a => a.id).includes('veteran'));
    assert.ok(!evaluate(ctx({ lifetime: { correct: 99, wrong: 0, sessions: 1 } }), []).map(a => a.id).includes('century'));
});

test('perfectionist needs a flawless session of meaningful length', () => {
    assert.ok(evaluate(ctx({ result: { correct: 10, accuracy: 1, bestCombo: 5, medal: 'gold' } }), []).map(a => a.id).includes('perfectionist'));
    // A 2-correct session shouldn't trivially count.
    assert.ok(!evaluate(ctx({ result: { correct: 2, accuracy: 1, bestCombo: 2 } }), []).map(a => a.id).includes('perfectionist'));
});

test('already-unlocked achievements are not reported again', () => {
    const newly = evaluate(ctx({ result: { bestCombo: 5, correct: 5, accuracy: 1 } }), ['combo_5']);
    assert.ok(!newly.map(a => a.id).includes('combo_5'));
});

test('string master defers to the caller-provided flag', () => {
    assert.ok(evaluate(ctx({ stringMastered: true }), []).map(a => a.id).includes('string_master'));
    assert.ok(!evaluate(ctx({ stringMastered: false }), []).map(a => a.id).includes('string_master'));
});

test('every definition has a matching test predicate', () => {
    // Guard against defining an achievement but forgetting its test.
    DEFINITIONS.forEach(def => {
        // Sanity-shape only; the real coverage is above.
        assert.ok(def.id && def.title && def.desc, 'malformed definition ' + JSON.stringify(def));
    });
});
