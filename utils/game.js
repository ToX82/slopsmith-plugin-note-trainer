/**
 * Game engine for Note Trainer — pure logic, no DOM.
 *
 * Owns target generation, the pitch-stability debounce (so a transient or a
 * harmonic can't false-trigger), verdict judging via _noteTrainerMath, scoring
 * (combo multiplier + time bonus), per-note/string stats and level completion.
 *
 * The renderer/orchestrator (screen.js) feeds it smoothed detections frame by
 * frame and reacts to the events it returns; it never judges pitch itself.
 *
 * Exposed as window._noteTrainerGame in the browser, module.exports under Node.
 */
(function () {
    const M = (typeof window !== 'undefined') ? window._noteTrainerMath
        : (typeof require !== 'undefined' ? require('./note-math.js') : null);

    const DEFAULTS = {
        maxFret: 12,
        noteSet: 'natural',
        mode: 'relax',
        count: 12,            // targets to clear a level/challenge
        promote: 0.8,         // accuracy needed to unlock the next level
        pcs: null,            // optional pitch-class allowlist to narrow targets (weak-spot drill)
        stableFrames: 4,      // ~120ms at 30ms/frame of a steady pitch to commit
        rearmFrames: 3,       // frames of no stable pitch before a new commit can fire
        centsTol: 45,         // |cents| must be under this to count the pitch as "in tune"
        hintThreshold: 3,     // failed attempts on one target before the reveal
        basePoints: 100,
    };

    function createGame(config) {
        const cfg = Object.assign({}, DEFAULTS, config);
        const now = cfg.now || (() => Date.now());
        const rng = cfg.rng || Math.random;
        const openMidi = cfg.openMidi || [];
        const strings = (cfg.strings && cfg.strings.length)
            ? cfg.strings.slice()
            : openMidi.map((_, i) => i);
        // noteChoices starts from the note-set; an optional `pcs` allowlist
        // (mirroring `strings`) narrows it further — used by the "drill weak
        // spots" practice to over-sample exactly the notes the player misses.
        let noteChoices = M.notesForSet(cfg.noteSet);
        if (cfg.pcs && cfg.pcs.length) {
            const allow = new Set(cfg.pcs);
            const filtered = noteChoices.filter(n => allow.has(n.pc));
            if (filtered.length) noteChoices = filtered;   // never empty the pool
        }

        const state = {
            target: null,            // { stringIndex, pitchClass, name, openMidi, maxFret }
            attempts: 0,             // failed attempts on the current target
            score: 0,
            combo: 0,
            bestCombo: 0,
            correctCount: 0,
            wrongCount: 0,
            stats: {},               // "stringIndex:pc" -> { correct, wrong }
            targetShownAt: 0,
            finished: false,
        };

        // Debounce state.
        let _stableMidi = null;
        let _stableCount = 0;
        let _silenceCount = cfg.rearmFrames;   // start armed
        let _armed = true;

        function _statKey(stringIndex, pc) { return stringIndex + ':' + pc; }
        function _bump(stringIndex, pc, field) {
            const k = _statKey(stringIndex, pc);
            const s = state.stats[k] || (state.stats[k] = { correct: 0, wrong: 0 });
            s[field]++;
        }

        function comboMultiplier() {
            // 1x, then 2x from a 3-streak, 3x from a 6-streak.
            if (state.combo >= 6) return 3;
            if (state.combo >= 3) return 2;
            return 1;
        }

        function nextTarget() {
            let pick, key, guard = 0;
            const prev = state.target ? (state.target.stringIndex + ':' + state.target.pitchClass) : null;
            do {
                const stringIndex = strings[Math.floor(rng() * strings.length)];
                const note = noteChoices[Math.floor(rng() * noteChoices.length)];
                key = stringIndex + ':' + note.pc;
                pick = {
                    stringIndex,
                    pitchClass: note.pc,
                    name: note.name,
                    openMidi: openMidi[stringIndex],
                    maxFret: cfg.maxFret,
                };
            } while (key === prev && (strings.length * noteChoices.length) > 1 && ++guard < 20);

            state.target = pick;
            state.attempts = 0;
            state.targetShownAt = now();
            _armed = false;           // require a fresh attack before the next commit
            _silenceCount = 0;
            _stableMidi = null;
            _stableCount = 0;
            return pick;
        }

        // Frets where the current target sits on its string (for hints/reveal).
        function targetFrets() {
            if (!state.target) return [];
            return M.fretsForPitchClassOnString(state.target.openMidi, state.target.pitchClass, cfg.maxFret);
        }

        function _timeBonus() {
            if (cfg.mode !== 'arcade' && cfg.mode !== 'challenge') return 0;
            const elapsed = (now() - state.targetShownAt) / 1000;
            // Full 50-pt bonus under 2s, decaying to 0 by 7s.
            return Math.min(50, Math.max(0, Math.round(50 * (1 - (elapsed - 2) / 5))));
        }

        // Feed one smoothed detection.
        //   det = { midi: int|null, cents: number, hasSignal: bool }
        // midi is null when no stable pitch this frame. Returns an event:
        //   { committed:false }
        //   { committed:true, verdict:'correct'|'wrong-note'|'wrong-string',
        //     detectedMidi, target, scoreDelta, combo, multiplier, shouldReveal }
        function feed(det) {
            if (state.finished || !state.target) return { committed: false };

            const hasNote = det && det.midi != null && Math.abs(det.cents || 0) <= cfg.centsTol;

            if (!hasNote) {
                _silenceCount++;
                if (_silenceCount >= cfg.rearmFrames) { _armed = true; _stableMidi = null; _stableCount = 0; }
                return { committed: false };
            }

            _silenceCount = 0;
            if (det.midi === _stableMidi) _stableCount++;
            else { _stableMidi = det.midi; _stableCount = 1; }

            if (!_armed || _stableCount < cfg.stableFrames) return { committed: false };

            // Commit this note.
            _armed = false;
            const verdict = M.judge(_stableMidi, state.target);
            const ev = { committed: true, verdict, detectedMidi: _stableMidi, target: state.target };

            if (verdict === 'correct') {
                const mult = comboMultiplier();
                const delta = cfg.basePoints * mult + _timeBonus();
                state.score += delta;
                state.combo++;
                state.bestCombo = Math.max(state.bestCombo, state.combo);
                state.correctCount++;
                _bump(state.target.stringIndex, state.target.pitchClass, 'correct');
                ev.scoreDelta = delta;
                ev.multiplier = mult;
                ev.combo = state.combo;
                if (state.correctCount >= cfg.count) state.finished = true;
            } else {
                state.attempts++;
                state.wrongCount++;
                state.combo = 0;
                _bump(state.target.stringIndex, state.target.pitchClass, 'wrong');
                if (cfg.mode === 'arcade' || cfg.mode === 'challenge') {
                    state.score = Math.max(0, state.score - 25);
                }
                ev.scoreDelta = 0;
                ev.combo = 0;
                ev.shouldReveal = state.attempts >= cfg.hintThreshold;
            }
            return ev;
        }

        function accuracy() {
            const total = state.correctCount + state.wrongCount;
            return total ? state.correctCount / total : 0;
        }

        function levelResult() {
            const acc = accuracy();
            return {
                score: state.score,
                accuracy: acc,
                bestCombo: state.bestCombo,
                correct: state.correctCount,
                wrong: state.wrongCount,
                promoted: acc >= cfg.promote,
                medal: acc >= 0.95 ? 'gold' : acc >= 0.85 ? 'silver' : acc >= cfg.promote ? 'bronze' : null,
            };
        }

        return {
            state,
            nextTarget,
            targetFrets,
            feed,
            accuracy,
            levelResult,
            comboMultiplier,
            isFinished: () => state.finished,
            config: cfg,
        };
    }

    const api = { createGame, DEFAULTS };
    if (typeof window !== 'undefined') window._noteTrainerGame = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
