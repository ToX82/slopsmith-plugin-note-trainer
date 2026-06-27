/**
 * Ear-training engine for Note Trainer — pure logic, no DOM, no audio.
 *
 * Trains *relative* pitch (the kind you can actually learn), not absolute pitch:
 * every round it anchors on a fixed "home" note (the root) and then plays a
 * target a few semitones above it. The player names the target from a small
 * pool. Because the home note is constant, the same target always sounds the
 * same way relative to home — that's the skill being built.
 *
 * The orchestrator (screen.js) synthesises the actual tones and renders the
 * answer buttons; it asks this engine which note to play and whether a guess
 * was right, and reacts to the scoring it returns.
 *
 * Exposed as window._noteTrainerEar in the browser, module.exports under Node.
 */
(function () {
    const M = (typeof window !== 'undefined') ? window._noteTrainerMath
        : (typeof require !== 'undefined' ? require('./note-math.js') : null);

    // Difficulty tiers as semitone offsets above the home note.
    //   easy   -> root, major third, perfect fifth (the most consonant, C E G)
    //   medium -> the major scale (do-re-mi… : C D E F G A B)
    //   hard   -> all twelve notes
    const TIERS = {
        easy:   { label: 'Easy',   offsets: [0, 4, 7] },
        medium: { label: 'Medium', offsets: [0, 2, 4, 5, 7, 9, 11] },
        hard:   { label: 'Hard',   offsets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    };

    const DEFAULTS = {
        rootMidi: 60,        // C4 — the "home" reference note
        tier: 'easy',
        rounds: 10,          // questions per session
        maxAttempts: 3,      // guesses allowed per round before the answer shows
        useFlats: false,
        basePoints: 100,
        adaptive: true,      // bias target picking toward the player's weak intervals
        priorStats: null,    // { offset -> {correct, wrong} } carried across sessions
    };

    // Points are scaled down the more tries a round takes, so a first-try
    // answer is worth the most but a recovered guess still earns something.
    // Index 0 = 1st attempt, 1 = 2nd, 2 = 3rd (clamped for any extra).
    const ATTEMPT_FACTORS = [1, 0.5, 0.25];

    function createEar(config) {
        const cfg = Object.assign({}, DEFAULTS, config);
        const rng = cfg.rng || Math.random;
        const offsets = (cfg.offsets && cfg.offsets.length)
            ? cfg.offsets.slice()
            : (TIERS[cfg.tier] || TIERS.easy).offsets.slice();
        const rootPc = M.pitchClass(cfg.rootMidi);

        const pool = offsets.map(off => {
            const midi = cfg.rootMidi + off;
            const pc = M.pitchClass(midi);
            return {
                offset: off, midi, pc,
                name: M.nameOf(pc, cfg.useFlats),
                freq: M.midiToFreq(midi),
                // The melodic interval above the root — the theory layer ear
                // training can optionally name instead of (or alongside) the
                // absolute note letter. offset === semitones from the root,
                // so it maps 1:1 to an interval.
                interval: M.intervalName(off),
            };
        });

        const state = {
            round: 0,
            score: 0,
            combo: 0,
            bestCombo: 0,
            correctCount: 0,
            wrongCount: 0,
            attempts: 0,        // guesses used on the current round
            finished: false,
            current: null,      // the active target from `pool`
            // Per-interval tally for THIS session, keyed by offset (semitones
            // from the root). One entry per resolved round. Mirrors the
            // fretboard game's per-note stats so weakness can be measured.
            stats: {},
        };

        function comboMultiplier() {
            if (state.combo >= 6) return 3;
            if (state.combo >= 3) return 2;
            return 1;
        }

        // Combine this session's tally with any prior (cross-session) stats for
        // an interval, so a long-standing weakness still pulls the picker.
        function combinedStats(off) {
            const a = cfg.priorStats && cfg.priorStats[off];
            const b = state.stats[off];
            return {
                correct: (a ? a.correct : 0) + (b ? b.correct : 0),
                wrong:   (a ? a.wrong   : 0) + (b ? b.wrong   : 0),
            };
        }

        // Sampling weight for an interval: the less accurately the player names
        // it, the more often it comes up. Unseen intervals get a mild boost so
        // they still appear; a fully-mastered one drops to the baseline. Range
        // ~1.0 (mastered) … 3.0 (always missed), 1.4 for never-tried.
        function weightFor(off) {
            const s = combinedStats(off);
            const n = s.correct + s.wrong;
            if (n === 0) return 1.4;
            return 1 + 2 * (1 - s.correct / n);
        }

        function weightedPick() {
            if (!cfg.adaptive) return pool[Math.floor(rng() * pool.length)];
            const weights = pool.map(p => weightFor(p.offset));
            const total = weights.reduce((a, b) => a + b, 0);
            let r = rng() * total;
            for (let i = 0; i < pool.length; i++) {
                r -= weights[i];
                if (r < 0) return pool[i];
            }
            return pool[pool.length - 1];
        }

        // Pick the next target, biased toward weak intervals (when adaptive) and
        // avoiding an immediate repeat when possible.
        function nextRound() {
            if (state.finished) return null;
            let pick, guard = 0;
            const prev = state.current ? state.current.offset : null;
            do {
                pick = weightedPick();
            } while (pool.length > 1 && pick.offset === prev && ++guard < 20);
            state.current = pick;
            state.round++;
            state.attempts = 0;
            return pick;
        }

        // Judge a guessed pitch-class against the current target. The player
        // gets up to `maxAttempts` tries per round: a wrong guess with tries
        // left leaves the round OPEN (resolved=false, nothing scored) so they
        // can try again; the round only resolves on a correct guess or once
        // the attempts run out (exhausted=true), and only then does it count
        // toward the session and possibly finish it.
        function guess(pc) {
            if (state.finished || !state.current) return { committed: false };
            const expected = state.current;
            const norm = (((pc % 12) + 12) % 12);
            const correct = norm === expected.pc;
            state.attempts++;
            const attempt = state.attempts;                        // 1-based
            const exhausted = !correct && attempt >= cfg.maxAttempts;
            const resolved = correct || exhausted;
            const ev = {
                committed: true, correct, resolved, exhausted, attempt,
                attemptsLeft: Math.max(0, cfg.maxAttempts - attempt),
                expectedPc: expected.pc, expectedName: expected.name,
                guessPc: norm,
            };
            if (!resolved) {
                // Wrong, but the round stays open — no scoring or counting yet.
                ev.scoreDelta = 0;
                ev.multiplier = comboMultiplier();
                ev.combo = state.combo;
                ev.finished = false;
                return ev;
            }
            const tally = state.stats[expected.offset] || (state.stats[expected.offset] = { correct: 0, wrong: 0 });
            if (correct) {
                const mult = comboMultiplier();
                const factor = ATTEMPT_FACTORS[Math.min(attempt - 1, ATTEMPT_FACTORS.length - 1)];
                const delta = Math.round(cfg.basePoints * mult * factor);
                state.score += delta;
                state.combo++;
                state.bestCombo = Math.max(state.bestCombo, state.combo);
                state.correctCount++;
                tally.correct++;
                ev.scoreDelta = delta; ev.multiplier = mult; ev.combo = state.combo;
            } else {
                state.combo = 0;
                state.wrongCount++;
                tally.wrong++;
                ev.scoreDelta = 0; ev.multiplier = 1; ev.combo = 0;
            }
            if (state.correctCount + state.wrongCount >= cfg.rounds) state.finished = true;
            ev.finished = state.finished;
            return ev;
        }

        function accuracy() {
            const total = state.correctCount + state.wrongCount;
            return total ? state.correctCount / total : 0;
        }

        // Per-interval breakdown for THIS session, one row per pool entry that
        // came up, in ascending pitch order. Lets the UI surface "the intervals
        // you struggled with" instead of just an overall percentage.
        function intervalBreakdown() {
            return pool.map(p => {
                const s = state.stats[p.offset] || { correct: 0, wrong: 0 };
                const n = s.correct + s.wrong;
                return {
                    offset: p.offset, name: p.name, interval: p.interval,
                    correct: s.correct, wrong: s.wrong, attempts: n,
                    accuracy: n ? s.correct / n : null,
                };
            }).filter(r => r.attempts > 0);
        }

        // The session's weakest intervals (lowest accuracy first; ties broken by
        // most-missed). Only intervals actually tested are returned.
        function weakestIntervals(limit) {
            const rows = intervalBreakdown().slice()
                .sort((a, b) => (a.accuracy - b.accuracy) || (b.wrong - a.wrong));
            return (limit != null) ? rows.slice(0, limit) : rows;
        }

        function result() {
            const acc = accuracy();
            return {
                score: state.score,
                accuracy: acc,
                bestCombo: state.bestCombo,
                correct: state.correctCount,
                wrong: state.wrongCount,
                intervals: intervalBreakdown(),
                weakest: weakestIntervals(),
                medal: acc >= 0.95 ? 'gold' : acc >= 0.85 ? 'silver' : acc >= 0.7 ? 'bronze' : null,
            };
        }

        return {
            state, pool,
            rootMidi: cfg.rootMidi,
            rootFreq: M.midiToFreq(cfg.rootMidi),
            rootName: M.nameOf(rootPc, cfg.useFlats),
            nextRound, guess, comboMultiplier, accuracy, result,
            intervalBreakdown, weakestIntervals,
            isFinished: () => state.finished,
            config: cfg,
        };
    }

    const api = { createEar, DEFAULTS, TIERS };
    if (typeof window !== 'undefined') window._noteTrainerEar = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
