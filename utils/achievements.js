/**
 * Achievements for Note Trainer — pure logic, no DOM.
 *
 * Long-term goals that span sessions: first medal, hot combos, lifetime note
 * counts, mastering a string. The orchestrator (screen.js) builds a context
 * object from the just-finished session plus the cumulative config, calls
 * `evaluate(ctx, alreadyUnlocked)`, and shows a toast for each new unlock.
 *
 * Tests live here too: every test is a pure predicate over the context, so the
 * whole thing is unit-testable without a browser.
 *
 * Exposed as window._noteTrainerAchievements in the browser, module.exports
 * under Node.
 */
(function () {
    // ctx = {
    //   sessionType: 'fret' | 'ear',
    //   result: { accuracy, medal, bestCombo, score, correct, wrong, ... },
    //   medals:     cumulative { key -> 'gold'|'silver'|'bronze' } AFTER this session,
    //   lifetime:   cumulative { correct, wrong, sessions } AFTER this session,
    //   stringMastered: bool (fretboard only — true when some string is 2-star),
    // }
    const DEFINITIONS = [
        { id: 'first_step',     icon: '🎵', title: 'First steps',      desc: 'Play your first correct note.' },
        { id: 'combo_5',        icon: '🔥', title: 'On a roll',        desc: 'Reach a 5-note combo.' },
        { id: 'combo_10',       icon: '⚡', title: 'Unstoppable',      desc: 'Reach a 10-note combo.' },
        { id: 'first_medal',    icon: '🏅', title: 'Decorated',        desc: 'Earn your first medal.' },
        { id: 'perfectionist',  icon: '💎', title: 'Perfectionist',    desc: 'Finish a session with 100% accuracy.' },
        { id: 'fret_gold',      icon: '🥇', title: 'Golden fingers',   desc: 'Earn gold on a fretboard level.' },
        { id: 'chromatic_gold', icon: '🌈', title: 'Full spectrum',    desc: 'Earn gold on the Chromatic level.' },
        { id: 'ear_gold',       icon: '👂', title: 'Golden ear',       desc: 'Earn gold in ear training.' },
        { id: 'interval_gold',  icon: '📐', title: 'Sound reasoning',  desc: 'Earn gold in ear training while naming intervals.' },
        { id: 'century',        icon: '💯', title: 'Century',          desc: 'Play 100 correct notes in total.' },
        { id: 'veteran',        icon: '🎸', title: 'Veteran',          desc: 'Play 500 correct notes in total.' },
        { id: 'string_master',  icon: '🌟', title: 'String master',    desc: 'Master every note on a single string.' },
    ];

    const TESTS = {
        first_step:     c => (c.result && c.result.correct >= 1) || (c.lifetime && c.lifetime.correct >= 1),
        combo_5:        c => c.result && c.result.bestCombo >= 5,
        combo_10:       c => c.result && c.result.bestCombo >= 10,
        first_medal:    c => Object.keys(c.medals || {}).length >= 1,
        perfectionist:  c => c.result && c.result.correct >= 8 && c.result.accuracy >= 0.999,
        fret_gold:      c => hasGold(c.medals, k => /^\d+$/.test(k)),
        chromatic_gold: c => c.medals && c.medals['4'] === 'gold',
        ear_gold:       c => hasGold(c.medals, k => k.indexOf('ear:') === 0),
        interval_gold:  c => c.sessionType === 'ear' && c.intervalMode && c.result && c.result.medal === 'gold',
        century:        c => c.lifetime && c.lifetime.correct >= 100,
        veteran:        c => c.lifetime && c.lifetime.correct >= 500,
        string_master:  c => !!c.stringMastered,
    };

    function hasGold(medals, keyPred) {
        if (!medals) return false;
        return Object.keys(medals).some(k => keyPred(k) && medals[k] === 'gold');
    }

    // Returns the newly-unlocked achievement definitions (full objects) given
    // the session context and the set of ids already unlocked. A throwing test
    // is swallowed so a buggy predicate can never crash a session.
    function evaluate(ctx, alreadyUnlocked) {
        const have = new Set((alreadyUnlocked || []).slice ? alreadyUnlocked : []);
        const newly = [];
        DEFINITIONS.forEach(def => {
            if (have.has(def.id)) return;
            const test = TESTS[def.id];
            try {
                if (test && test(ctx || {})) newly.push(def);
            } catch (_) { /* achievements are best-effort */ }
        });
        return newly;
    }

    const api = { evaluate, DEFINITIONS };
    if (typeof window !== 'undefined') window._noteTrainerAchievements = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
