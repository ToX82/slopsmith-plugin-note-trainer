'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../utils/note-math.js');

// Standard 6-string guitar open strings (Hz) -> known MIDI.
const GUITAR6_HZ = [82.41, 110.00, 146.83, 196.00, 246.94, 329.63];

test('openMidiFromFreqs maps standard guitar to E2 A2 D3 G3 B3 E4', () => {
    assert.deepEqual(m.openMidiFromFreqs(GUITAR6_HZ), [40, 45, 50, 55, 59, 64]);
});

test('freqToNoteOctave names and octaves', () => {
    const a4 = m.freqToNoteOctave(440);
    assert.equal(a4.nameSharp, 'A');
    assert.equal(a4.octave, 4);
    assert.equal(a4.midi, 69);

    const e2 = m.freqToNoteOctave(82.41);
    assert.equal(e2.nameSharp, 'E');
    assert.equal(e2.octave, 2);
    assert.equal(e2.midi, 40);
});

test('cents are signed and near zero for in-tune pitches', () => {
    const a4 = m.freqToNoteOctave(440);
    assert.ok(Math.abs(a4.cents) <= 1, `expected ~0 cents, got ${a4.cents}`);
    const sharp = m.freqToNoteOctave(445);
    assert.ok(sharp.cents > 0, 'a sharp pitch should read positive cents');
});

test('flat vs sharp spelling of the same pitch class', () => {
    const n = m.freqToNoteOctave(m.midiToFreq(61)); // C#4 / Db4
    assert.equal(n.nameSharp, 'C#');
    assert.equal(n.nameFlat, 'Db');
});

test('nameToPc handles sharp and flat spellings', () => {
    assert.equal(m.nameToPc('C'), 0);
    assert.equal(m.nameToPc('F#'), 6);
    assert.equal(m.nameToPc('Gb'), 6);
    assert.equal(m.nameToPc('B'), 11);
    assert.equal(m.nameToPc('H'), null);
});

test('fretsForPitchClassOnString finds C on the low E string', () => {
    // Low E (MIDI 40), C is pitch class 0 -> fret 8 within 0..12.
    assert.deepEqual(m.fretsForPitchClassOnString(40, 0, 12), [8]);
    // Extend the neck: C also at fret 20.
    assert.deepEqual(m.fretsForPitchClassOnString(40, 0, 22), [8, 20]);
});

test('judge: correct note in the string range', () => {
    // C3 (MIDI 48) on low E string, pitch class C(0).
    assert.equal(m.judge(48, { pitchClass: 0, openMidi: 40, maxFret: 12 }), 'correct');
});

test('judge: right note but out of the string range -> wrong-string', () => {
    // C4 (MIDI 60) is C but above low E + 12 frets (max MIDI 52).
    assert.equal(m.judge(60, { pitchClass: 0, openMidi: 40, maxFret: 12 }), 'wrong-string');
});

test('judge: different pitch class -> wrong-note', () => {
    // D3 (MIDI 50) is pitch class 2, target is C(0).
    assert.equal(m.judge(50, { pitchClass: 0, openMidi: 40, maxFret: 12 }), 'wrong-note');
});

test('notesForSet sizes and contents', () => {
    assert.equal(m.notesForSet('natural').length, 7);
    assert.equal(m.notesForSet('sharps').length, 12);
    assert.equal(m.notesForSet('flats').length, 12);
    assert.equal(m.notesForSet('chromatic').length, 12);

    const naturalNames = m.notesForSet('natural').map(n => n.name);
    assert.ok(naturalNames.includes('C') && naturalNames.includes('B'));
    assert.ok(!naturalNames.some(n => n.includes('#')), 'naturals must not contain sharps');

    assert.ok(m.notesForSet('flats').some(n => n.name === 'Bb'));
    assert.ok(m.notesForSet('sharps').some(n => n.name === 'A#'));
});

test('intervalName maps semitone offsets to interval labels', () => {
    assert.equal(m.intervalName(0).abbr, 'P1');
    assert.equal(m.intervalName(0).long, 'Unison');
    assert.equal(m.intervalName(4).abbr, 'M3');
    assert.equal(m.intervalName(4).long, 'Major 3rd');
    assert.equal(m.intervalName(7).abbr, 'P5');
    assert.equal(m.intervalName(7).long, 'Perfect 5th');
    assert.equal(m.intervalName(6).short, 'Tritone');
    assert.equal(m.intervalName(11).abbr, 'M7');
});

test('intervalName wraps negative offsets and octaves into 0..11', () => {
    // 12 semitones up is the octave -> same as unison (P1).
    assert.equal(m.intervalName(12).abbr, 'P1');
    assert.equal(m.intervalName(-5).abbr, 'P5');   // -5 mod 12 === 7
});
