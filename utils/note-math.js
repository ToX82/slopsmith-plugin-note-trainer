/**
 * Note / frequency math for Note Trainer.
 *
 * Builds on the tuner plugin's freqToMidi / midiToFreq helpers and adds the
 * fretboard-aware logic the game needs: turning a detected frequency into a
 * note+octave, locating a pitch-class on a string, and judging a detection
 * against a target ("right note on the right string").
 *
 * Pure module — no DOM. Exposed as window._noteTrainerMath in the browser and
 * as module.exports under Node (for unit tests).
 */
(function () {
    function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
    function midiToFreq(m) { return Math.pow(2, (m - 69) / 12) * 440; }

    const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const NAMES_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

    // Pitch classes (0=C) grouped by note-set.
    const NATURAL_PCS = [0, 2, 4, 5, 7, 9, 11];
    const ACCIDENTAL_PCS = [1, 3, 6, 8, 10];

    function pitchClass(midi) { return ((Math.round(midi) % 12) + 12) % 12; }

    // Scientific-pitch octave: MIDI 60 = C4.
    function octaveOf(midi) { return Math.floor(Math.round(midi) / 12) - 1; }

    function nameOf(pc, useFlats) { return (useFlats ? NAMES_FLAT : NAMES_SHARP)[((pc % 12) + 12) % 12]; }

    // Map a note name ("C", "F#", "Bb", "Gb"…) to its pitch class, or null.
    function nameToPc(name) {
        if (typeof name !== 'string') return null;
        const s = name.trim();
        let i = NAMES_SHARP.indexOf(s);
        if (i >= 0) return i;
        i = NAMES_FLAT.indexOf(s);
        if (i >= 0) return i;
        return null;
    }

    // Detected frequency -> rich note descriptor. cents is the signed deviation
    // (-50..50) from the nearest equal-tempered note.
    function freqToNoteOctave(freq) {
        if (!freq || freq <= 0) return null;
        const exact = freqToMidi(freq);
        const midi = Math.round(exact);
        const pc = pitchClass(midi);
        return {
            exactMidi: exact,
            midi: midi,
            pitchClass: pc,
            octave: octaveOf(midi),
            cents: Math.round((exact - midi) * 100),
            nameSharp: nameOf(pc, false),
            nameFlat: nameOf(pc, true),
        };
    }

    // Signed cents of `freq` relative to a target MIDI note.
    function centsOff(freq, refMidi) {
        if (!freq || freq <= 0) return Infinity;
        return (freqToMidi(freq) - refMidi) * 100;
    }

    // Open-string frequencies (Hz, low→high) -> rounded open-string MIDI numbers.
    function openMidiFromFreqs(freqs) {
        return (freqs || []).map(f => Math.round(freqToMidi(f)));
    }

    // Inclusive MIDI range a string can produce, open string to highest fret.
    function stringRange(openMidi, maxFret) {
        return [openMidi, openMidi + maxFret];
    }

    function midiOnString(midi, openMidi, maxFret) {
        return midi >= openMidi && midi <= openMidi + maxFret;
    }

    // Every fret (0..maxFret) on a string that sounds the given pitch class.
    function fretsForPitchClassOnString(openMidi, pc, maxFret) {
        const out = [];
        for (let fret = 0; fret <= maxFret; fret++) {
            if (pitchClass(openMidi + fret) === ((pc % 12) + 12) % 12) out.push(fret);
        }
        return out;
    }

    // The note-set's candidate targets as { pc, name } pairs.
    //   natural   -> A B C D E F G
    //   sharps    -> naturals + C# D# F# G# A#
    //   flats     -> naturals + Db Eb Gb Ab Bb
    //   chromatic -> all 12 (sharp spelling)
    function notesForSet(noteSet) {
        if (noteSet === 'natural') return NATURAL_PCS.map(pc => ({ pc, name: nameOf(pc, false) }));
        if (noteSet === 'sharps') return NATURAL_PCS.concat(ACCIDENTAL_PCS)
            .sort((a, b) => a - b).map(pc => ({ pc, name: nameOf(pc, false) }));
        if (noteSet === 'flats') return NATURAL_PCS.concat(ACCIDENTAL_PCS)
            .sort((a, b) => a - b).map(pc => ({ pc, name: nameOf(pc, true) }));
        // chromatic
        const all = [];
        for (let pc = 0; pc < 12; pc++) all.push({ pc, name: nameOf(pc, false) });
        return all;
    }

    // Judge a detected MIDI note against a target.
    //   target = { pitchClass, openMidi, maxFret }
    // Returns 'correct' | 'wrong-string' | 'wrong-note'.
    //   correct      -> right pitch-class AND within the target string's range
    //   wrong-string -> right pitch-class but outside that string's range
    //   wrong-note   -> different pitch-class
    function judge(detectedMidi, target) {
        if (pitchClass(detectedMidi) !== ((target.pitchClass % 12) + 12) % 12) return 'wrong-note';
        if (midiOnString(detectedMidi, target.openMidi, target.maxFret)) return 'correct';
        return 'wrong-string';
    }

    // Name a melodic interval from its semitone offset above a root (0..11).
    // Returns { abbr, short, long, semitones, desc, song }:
    //   abbr  -> compact symbol for tight UI (e.g. "M3", "P5")
    //   short -> button-friendly label (e.g. "Major 3rd"); for the tritone we
    //            use the friendlier "Tritone" rather than forcing A4/d5.
    //   long  -> full spelling used in feedback sentences.
    //   semitones -> distance from the root in half-steps (0..11).
    //   desc  -> plain-language character of the interval (its "feel").
    //   song  -> a famous tune whose opening leap IS this interval, so a
    //            beginner can recognise it by ear instead of guessing.
    // This is the theory bridge for ear training: recognizing the *distance*
    // between two notes (the interval) is more transferable than naming the
    // absolute letter, and it's the foundation of chords and scales. The desc
    // and song fields are what turn the minigame into a lesson rather than a
    // coin-flip — they explain what "M3", "TT"… actually mean.
    const INTERVALS = [
        { abbr: 'P1', short: 'Unison',  long: 'Unison',      semitones: 0,
          desc: 'The same note repeated — zero distance.',                               song: 'a single note held' },
        { abbr: 'm2', short: 'm2',      long: 'Minor 2nd',   semitones: 1,
          desc: 'The tightest, most tense step — two neighbouring piano keys.',          song: 'the "Jaws" shark theme' },
        { abbr: 'M2', short: 'M2',      long: 'Major 2nd',   semitones: 2,
          desc: 'One whole step — the gap between "do" and "re".',                       song: '"Happy Birthday" (first two notes)' },
        { abbr: 'm3', short: 'm3',      long: 'Minor 3rd',   semitones: 3,
          desc: 'The sad, dark colour at the heart of a minor chord.',                   song: '"Greensleeves" / "Smoke on the Water"' },
        { abbr: 'M3', short: 'M3',      long: 'Major 3rd',   semitones: 4,
          desc: 'The bright, happy colour at the heart of a major chord.',               song: '"When the Saints Go Marching In"' },
        { abbr: 'P4', short: 'P4',      long: 'Perfect 4th', semitones: 5,
          desc: 'Strong and open, slightly suspended.',                                 song: '"Here Comes the Bride"' },
        { abbr: 'TT', short: 'Tritone', long: 'Tritone',     semitones: 6,
          desc: 'Exactly half an octave — restless and unstable, the "devil\'s interval".', song: 'the "Simpsons" theme (first leap)' },
        { abbr: 'P5', short: 'P5',      long: 'Perfect 5th', semitones: 7,
          desc: 'The most stable, open and powerful interval after the octave.',         song: '"Twinkle Twinkle" / "Star Wars"' },
        { abbr: 'm6', short: 'm6',      long: 'Minor 6th',   semitones: 8,
          desc: 'Wide and wistful — bittersweet.',                                       song: '"The Entertainer" / "Love Story"' },
        { abbr: 'M6', short: 'M6',      long: 'Major 6th',   semitones: 9,
          desc: 'Wide and warm — hopeful.',                                             song: '"My Bonnie Lies Over the Ocean"' },
        { abbr: 'm7', short: 'm7',      long: 'Minor 7th',   semitones: 10,
          desc: 'Tense and bluesy — it wants to resolve.',                              song: '"Somewhere" (West Side Story)' },
        { abbr: 'M7', short: 'M7',      long: 'Major 7th',   semitones: 11,
          desc: 'Almost a full octave — sharp and yearning.',                           song: '"Take On Me" (the chorus leap)' },
    ];
    function intervalName(offset) {
        const i = (((offset % 12) + 12) % 12);
        return INTERVALS[i];
    }

    const api = {
        freqToMidi, midiToFreq, pitchClass, octaveOf, nameOf, nameToPc,
        freqToNoteOctave, centsOff, openMidiFromFreqs, stringRange, midiOnString,
        fretsForPitchClassOnString, notesForSet, judge, intervalName, INTERVALS,
        NAMES_SHARP, NAMES_FLAT, NATURAL_PCS, ACCIDENTAL_PCS,
    };

    if (typeof window !== 'undefined') window._noteTrainerMath = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
