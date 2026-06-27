// Note Trainer — Slopsmith plugin orchestrator.
// Wires the mounted screen (screen.html) to the audio pipeline, the game
// engine, the SVG fretboard and the view helpers. Owns session state and the
// screen lifecycle (start/stop audio on navigation).
(function () {
    const STORAGE_KEY = 'slopsmith_note_trainer_settings';
    const API = '/api/plugins/note-trainer';

    // ── Script loader (idempotent) ────────────────────────────────────
    const _loaded = new Set();
    function _loadScript(url) {
        if (_loaded.has(url)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => { _loaded.add(url); resolve(); };
            s.onerror = () => reject(new Error('Note Trainer: failed to load ' + url));
            document.head.appendChild(s);
        });
    }

    // ── Shared state ──────────────────────────────────────────────────
    const S = {
        root: null,
        ui: null,
        fb: null,
        game: null,
        ear: null,                 // ear-training engine (mode 'ear')
        earTier: 'easy',           // ear difficulty, chosen inside the minigame
        earMode: 'note',           // ear answer style: 'note' | 'interval'
        earUseHome: true,          // ear training: play the C reference before the target
        earBusy: false,            // locked while a tone plays / between rounds
        bound: false,
        running: false,           // audio + a session are live
        mode: 'relax',
        config: null,             // server config
        tunings: {},
        levels: [],
        gameKind: 'fret',         // 'fret' = fretboard practice, 'ear' = ear training
        currentLevelId: null,     // null = free play (fretboard)
        drillFocus: null,         // {strings, pcs} when drilling weak spots (fretboard)
        levelStrings: {},         // levelId -> [stringIndex, …] strings picked to drill
        openMidi: [],
        maxFret: 12,
        stringCount: 6,
        mic: { deviceId: '', channel: 'mono', audioInputMode: 'auto' },
        timerInterval: null,
    };

    const M = () => window._noteTrainerMath;

    // ── Persistence (mic only; progress lives server-side) ─────────────
    function loadMicSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (typeof s.deviceId === 'string') S.mic.deviceId = s.deviceId;
            if (['mono', 'left', 'right'].includes(s.channel)) S.mic.channel = s.channel;
            if (['auto', 'browser'].includes(s.audioInputMode)) S.mic.audioInputMode = s.audioInputMode;
        } catch (_) { /* unavailable */ }
    }
    function saveMicSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S.mic)); } catch (_) {}
    }

    async function saveProgress(patch) {
        try {
            await fetch(API + '/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            Object.assign(S.config, patch);
        } catch (e) { console.warn('Note Trainer: save failed', e); }
    }

    // ── Setup population ──────────────────────────────────────────────
    function instrumentLabel(key) {
        const map = {
            'guitar-6': 'Guitar (6 strings)', 'guitar-7': 'Guitar (7 strings)',
            'guitar-8': 'Guitar (8 strings)', 'bass-4': 'Bass (4 strings)', 'bass-5': 'Bass (5 strings)',
        };
        return map[key] || key;
    }

    function populateInstruments() {
        const sel = S.ui.$('nt-instrument');
        sel.innerHTML = '';
        Object.keys(S.tunings).forEach(key => {
            const o = document.createElement('option');
            o.value = key; o.textContent = instrumentLabel(key);
            sel.appendChild(o);
        });
        sel.value = (S.config && S.config.lastInstrument && S.tunings[S.config.lastInstrument])
            ? S.config.lastInstrument : Object.keys(S.tunings)[0];
        populateTunings();
    }

    function populateTunings() {
        const inst = S.ui.$('nt-instrument').value;
        const sel = S.ui.$('nt-tuning');
        const tunings = S.tunings[inst] || {};
        sel.innerHTML = '';
        Object.keys(tunings).forEach(name => {
            const o = document.createElement('option');
            o.value = name; o.textContent = name;
            sel.appendChild(o);
        });
        const want = S.config && S.config.lastTuning;
        sel.value = (want && tunings[want]) ? want : Object.keys(tunings)[0];
    }

    async function populateMics() {
        const sel = S.ui.$('nt-mic');
        sel.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = ''; auto.textContent = 'Automatic (default)';
        sel.appendChild(auto);
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
                const o = document.createElement('option');
                o.value = d.deviceId;
                o.textContent = d.label || ('Microphone ' + (i + 1));
                sel.appendChild(o);
            });
        } catch (_) { /* labels need permission; the Automatic option still works */ }
        sel.value = S.mic.deviceId || '';
    }

    // ── Gamification helpers ──────────────────────────────────────────
    // Open-string MIDI for whatever instrument/tuning is picked right now
    // (needed before a session starts, to draw mastery + the string drill).
    function currentOpenMidi() {
        const inst = S.ui.$('nt-instrument').value;
        const tuningName = S.ui.$('nt-tuning').value;
        const freqs = (S.tunings[inst] || {})[tuningName];
        return freqs ? M().openMidiFromFreqs(freqs) : [];
    }

    function shortStringName(midi) { return M().nameOf(M().pitchClass(midi), false); }

    // Aggregate practice stats for one note-set on one string -> stars (0-2).
    function masteryFor(noteSet, stringIndex) {
        const notes = M().notesForSet(noteSet);
        let correct = 0, wrong = 0;
        notes.forEach(n => {
            const s = S.config.stats[stringIndex + ':' + n.pc];
            if (s) { correct += s.correct || 0; wrong += s.wrong || 0; }
        });
        const attempts = correct + wrong;
        const acc = attempts ? correct / attempts : 0;
        let stars = 0;
        if (attempts >= 4 && acc >= 0.9) stars = 2;
        else if (attempts >= 2 && acc >= 0.65) stars = 1;
        return { stars, attempts, correct, wrong };
    }

    // Overall mastery % for a level: correct/attempts across every string.
    function levelMasteryPct(noteSet, stringCount) {
        let correct = 0, attempts = 0;
        for (let i = 0; i < stringCount; i++) {
            const m = masteryFor(noteSet, i);
            correct += m.correct; attempts += m.attempts;
        }
        return attempts ? Math.round((correct / attempts) * 100) : 0;
    }

    // Smart practice: rank every drilled note/string pair by accuracy, worst
    // first. Only pairs with enough attempts (≥2) count, so a single random
    // miss can't dominate. Used to focus a session on the player's real holes.
    function weakSpotStats(stringCount) {
        const out = [];
        for (let i = 0; i < stringCount; i++) {
            for (let pc = 0; pc < 12; pc++) {
                const s = S.config.stats[i + ':' + pc];
                if (!s) continue;
                const attempts = (s.correct || 0) + (s.wrong || 0);
                if (attempts < 2) continue;
                out.push({
                    stringIndex: i, pc,
                    correct: s.correct || 0, wrong: s.wrong || 0, attempts,
                    acc: (s.correct || 0) / attempts,
                });
            }
        }
        out.sort((a, b) => (a.acc - b.acc) || (b.attempts - a.attempts));
        return out;
    }

    function weakSpotFocus(stringCount) {
        const weak = weakSpotStats(stringCount).slice(0, 6);
        if (!weak.length) return null;
        const strings = Array.from(new Set(weak.map(w => w.stringIndex))).sort((a, b) => a - b);
        const pcs = Array.from(new Set(weak.map(w => w.pc)));
        return { strings, pcs, weak };
    }

    function starHtml(stars) {
        return '<span class="' + (stars >= 1 ? 's-on' : 's-off') + '">★</span>'
            + '<span class="' + (stars >= 2 ? 's-on' : 's-off') + '">★</span>';
    }

    const MEDAL_EMOJI = { gold: '🥇', silver: '🥈', bronze: '🥉' };

    // Strings the player has picked to drill for a level (defaults to all).
    function getLevelStrings(id, stringCount) {
        const stored = S.levelStrings[id];
        if (Array.isArray(stored)) {
            const valid = stored.filter(i => i >= 0 && i < stringCount);
            if (valid.length) return valid.slice().sort((a, b) => a - b);
        }
        return Array.from({ length: stringCount }, (_, i) => i);
    }

    function persistLevelStrings() {
        saveProgress({ levelStrings: S.levelStrings });
    }

    function renderLevels() {
        const wrap = S.ui.$('nt-levels');
        wrap.innerHTML = '';
        const openMidi = currentOpenMidi();
        const stringCount = openMidi.length || 6;

        const fret = S.gameKind === 'fret';
        const free = document.createElement('button');
        free.className = 'nt-level-card free' + (fret && S.currentLevelId == null && !S.drillFocus ? ' active' : '');
        free.innerHTML = '<span class="nt-lc-title">🎛 Free practice</span>'
            + '<span class="nt-lc-desc">Use the settings above — pick any note set, mode and tuning, no constraints.</span>';
        free.addEventListener('click', () => selectLevel(null));
        wrap.appendChild(free);

        // Smart-practice card: turns the per-note/string stats already being
        // tracked into a targeted drill on whatever the player misses most.
        if (fret) {
            const focus = weakSpotFocus(stringCount);
            if (focus) {
                const drill = document.createElement('button');
                drill.className = 'nt-level-card weak' + (S.drillFocus ? ' active' : '');
                const sample = focus.weak.slice(0, 2).map(w =>
                    M().nameOf(w.pc, false) + ' on ' + shortStringName(openMidi[w.stringIndex])
                ).join(', ');
                drill.innerHTML =
                    '<span class="nt-lc-title">🎯 Drill weak spots</span>'
                    + '<span class="nt-lc-desc">Auto-focus on the notes you miss most. Right now: ' + sample + '.</span>'
                    + '<div class="nt-lc-foot"><span class="nt-lc-best">' + focus.weak.length + ' spot' + (focus.weak.length === 1 ? '' : 's') + ' to work on</span></div>';
                drill.addEventListener('click', startWeakSpotDrill);
                wrap.appendChild(drill);
            }
        }

        // Every level is available from the start — no lock gating.
        S.levels.forEach(lv => {
            const card = document.createElement('button');
            card.className = 'nt-level-card' + (fret && S.currentLevelId === lv.id ? ' active' : '');

            const medal = S.config.medals[lv.id];
            const best = S.config.bestScores[String(lv.id)];
            const pct = levelMasteryPct(lv.noteSet, stringCount);
            const notes = M().notesForSet(lv.noteSet);

            const chips = notes.map(n => '<span class="nt-lc-chip">' + n.name + '</span>').join('');
            const mastery = openMidi.map((midi, i) =>
                '<span class="nt-lc-ms"><b>' + shortStringName(midi) + '</b> '
                + starHtml(masteryFor(lv.noteSet, i).stars) + '</span>').join('');

            card.innerHTML =
                (medal ? '<span class="nt-lc-medal">' + MEDAL_EMOJI[medal] + '</span>' : '')
                + '<span class="nt-lc-title">Lv ' + lv.id + ' · ' + lv.label + '</span>'
                + '<span class="nt-lc-desc">' + lv.desc + '</span>'
                + '<div class="nt-lc-notes">' + chips + '</div>'
                + '<div class="nt-lc-mastery">' + mastery + '</div>'
                + '<div class="nt-lc-foot">'
                + '<div class="nt-lc-bar"><i style="width:' + pct + '%"></i></div>'
                + '<span class="nt-lc-pct">' + pct + '%</span>'
                + (best != null ? '<span class="nt-lc-best"><svg class="nt-ic is-fill"><use href="#nt-i-star"/></svg> ' + best + '</span>' : '')
                + '</div>';
            card.addEventListener('click', () => selectLevel(lv.id));
            wrap.appendChild(card);
        });

        renderDrill();
    }

    // The mini-fretboard string picker for the active level (hidden otherwise).
    function renderDrill() {
        const box = S.ui.$('nt-drill');
        if (!box) return;
        const lv = (S.gameKind === 'fret' && S.currentLevelId != null)
            ? S.levels.find(l => l.id === S.currentLevelId) : null;
        if (!lv) { box.style.display = 'none'; box.innerHTML = ''; return; }

        const openMidi = currentOpenMidi();
        const stringCount = openMidi.length || 6;
        const active = new Set(getLevelStrings(lv.id, stringCount));
        const allOn = active.size === stringCount;

        let rows = '';
        // Draw high string on top, lowest at the bottom (standard orientation).
        for (let i = stringCount - 1; i >= 0; i--) {
            rows += '<div class="nt-fb-row' + (active.has(i) ? ' on' : '') + '" data-str="' + i + '">'
                + '<span class="nt-fb-name">' + shortStringName(openMidi[i]) + '</span>'
                + '<span class="nt-fb-wire"><span class="nt-fb-dot"></span></span>'
                + '</div>';
        }
        box.innerHTML =
            '<div class="nt-drill-head"><span class="t">Practice strings <span>tap to focus on specific strings</span></span>'
            + '<button type="button" class="nt-drill-all">' + (allOn ? 'Clear' : 'All strings') + '</button></div>'
            + '<div class="nt-fb">' + rows + '</div>';
        box.style.display = '';

        box.querySelectorAll('.nt-fb-row').forEach(row => {
            row.addEventListener('click', () => toggleDrillString(lv.id, parseInt(row.getAttribute('data-str'), 10), stringCount));
        });
        box.querySelector('.nt-drill-all').addEventListener('click', () => {
            S.levelStrings[lv.id] = allOn ? [0] : Array.from({ length: stringCount }, (_, i) => i);
            persistLevelStrings();
            renderDrill();
        });
    }

    function toggleDrillString(id, i, stringCount) {
        const active = new Set(getLevelStrings(id, stringCount));
        if (active.has(i)) { if (active.size > 1) active.delete(i); }   // keep at least one
        else active.add(i);
        S.levelStrings[id] = Array.from(active).sort((a, b) => a - b);
        persistLevelStrings();
        renderDrill();
    }

    function refreshSelection() { applyGameKind(); renderLevels(); updateGlobalProgress(); renderEarMastery(); }

    // Swap the active-game accent + which setup panel shows, and refresh the
    // picker cards. Every minigame lives behind this single switch.
    function applyGameKind() {
        const ear = S.gameKind === 'ear';
        S.root.classList.toggle('is-game-fret', !ear);
        S.root.classList.toggle('is-game-ear', ear);
        const hint = S.ui.$('nt-setup-hint');
        if (hint) {
            hint.innerHTML = ear
                ? '<svg class="nt-ic"><use href="#nt-i-info"/></svg> No mic needed — just listen and tap.'
                : '';
        }
        const label = S.ui.$('nt-start-label');
        if (label) label.textContent = ear ? 'Start ear training' : 'Start practice';
        renderGames();
    }

    function selectLevel(id) {
        S.gameKind = 'fret';
        S.drillFocus = null;                       // picking a level leaves smart-drill mode
        S.currentLevelId = id;
        if (id != null) {
            const lv = S.levels.find(l => l.id === id);
            if (lv) {
                S.ui.$('nt-noteset').value = lv.noteSet;
                if (lv.noteSet === 'chromatic') S.ui.$('nt-mode').value = 'challenge';
            }
        }
        refreshSelection();
    }

    // Launch a relax session focused on the player's weakest note/string pairs.
    // The engine's `pcs` allowlist (combined with `strings`) over-samples the
    // trouble zone while still mixing positions, so it drills without being
    // robotic.
    function startWeakSpotDrill() {
        const openMidi = currentOpenMidi();
        if (!openMidi.length) return;
        const focus = weakSpotFocus(openMidi.length);
        if (!focus) return;
        S.gameKind = 'fret';
        S.drillFocus = focus;
        S.currentLevelId = null;
        S.ui.$('nt-mode').value = 'relax';
        S.mode = 'relax';
        refreshSelection();
        start();
    }

    // Selecting the Fretboard Trainer picker card keeps the last level picked
    // (or free practice); it only switches which setup panel is shown.
    function selectFretGame() { S.gameKind = 'fret'; refreshSelection(); }

    function selectEar() {
        S.gameKind = 'ear';
        applyGameKind();
        updateGlobalProgress();
    }

    // The game picker — a row of game cards (Fretboard Trainer, Ear Training,
    // …future). Selecting one swaps the accent and the setup panel below. This
    // is the hub every new minigame plugs into: add a card + a panel.
    const MEDAL_ORDER = { bronze: 1, silver: 2, gold: 3 };
    function bestMedalAcross(keys) {
        let medal = null;
        keys.forEach(k => {
            const m = S.config.medals[k];
            if (m && (!medal || MEDAL_ORDER[m] > MEDAL_ORDER[medal])) medal = m;
        });
        return medal;
    }
    function bestScoreAcross(keys) {
        let best = null;
        keys.forEach(k => {
            const b = S.config.bestScores[String(k)];
            if (b != null && (best == null || b > best)) best = b;
        });
        return best;
    }

    function footHtml(best, medal) {
        if (best == null && !medal) return '<span class="nt-gc-empty">Not played yet</span>';
        let s = '';
        if (medal) s += '<span class="nt-gc-best">' + MEDAL_EMOJI[medal] + '</span>';
        if (best != null) s += '<span class="nt-gc-best"><svg class="nt-ic is-fill"><use href="#nt-i-star"/></svg> ' + best + ' best</span>';
        return s;
    }

    function renderGames() {
        const wrap = S.ui.$('nt-games');
        if (!wrap) return;
        wrap.innerHTML = '';

        const fretActive = S.gameKind === 'fret';

        const fretKeys = S.levels.map(l => l.id).concat(['free']);
        const fretCard = document.createElement('button');
        fretCard.className = 'nt-game-card' + (fretActive ? ' active' : '');
        fretCard.setAttribute('data-accent', 'fret');
        fretCard.innerHTML =
            '<span class="nt-gc-head">'
            + '<span class="nt-gc-icon"><svg class="nt-ic"><use href="#nt-i-fret"/></svg></span>'
            + '<span class="nt-gc-title">Fretboard Trainer</span>'
            + '</span>'
            + '<span class="nt-gc-desc">Play the note shown on the right string — the mic checks it live, across the whole neck.</span>'
            + '<div class="nt-gc-foot">' + footHtml(bestScoreAcross(fretKeys), bestMedalAcross(fretKeys)) + '</div>';
        fretCard.addEventListener('click', selectFretGame);
        wrap.appendChild(fretCard);

        const earKeys = ['easy', 'medium', 'hard'].map(t => 'ear:' + t);
        const earCard = document.createElement('button');
        earCard.className = 'nt-game-card' + (!fretActive ? ' active' : '');
        earCard.setAttribute('data-accent', 'ear');
        earCard.innerHTML =
            '<span class="nt-gc-head">'
            + '<span class="nt-gc-icon"><svg class="nt-ic"><use href="#nt-i-sound"/></svg></span>'
            + '<span class="nt-gc-title">Ear Training</span>'
            + '</span>'
            + '<span class="nt-gc-desc">Hear a note and name it — no mic, no theory. Builds relative pitch with a home-note anchor.</span>'
            + '<div class="nt-gc-foot">' + footHtml(bestScoreAcross(earKeys), bestMedalAcross(earKeys)) + '</div>';
        earCard.addEventListener('click', selectEar);
        wrap.appendChild(earCard);
    }

    // Total medals earned across every game — shown in the header as identity.
    function updateGlobalProgress() {
        const el = S.ui.$('nt-medal-count');
        if (el) el.textContent = String(Object.keys(S.config.medals || {}).length);
        // Achievements pill (hidden until at least one is unlocked).
        const achWrap = S.ui.$('nt-ach-progress');
        const achCount = S.ui.$('nt-ach-count');
        const achTotal = S.ui.$('nt-ach-total');
        const defs = window._noteTrainerAchievements ? window._noteTrainerAchievements.DEFINITIONS : null;
        const unlocked = (S.config.achievements || []).length;
        if (achCount) achCount.textContent = String(unlocked);
        if (achTotal && defs) achTotal.textContent = '/' + defs.length;
        if (achWrap) achWrap.style.display = unlocked > 0 ? '' : 'none';
    }

    // ── Geometry helpers ──────────────────────────────────────────────
    function stringLabel(i) {
        const name = M().nameOf(M().pitchClass(S.openMidi[i]), false);
        const ordinal = S.stringCount - i;
        const suffix = ordinal === 1 ? 'st' : ordinal === 2 ? 'nd' : ordinal === 3 ? 'rd' : 'th';
        return name + ' (' + ordinal + suffix + ' string)';
    }

    function allowedStringsForLevel(lv) {
        const all = S.openMidi.map((_, i) => i);
        if (!lv) return all;                       // free practice → every string
        const picked = getLevelStrings(lv.id, S.openMidi.length);
        return picked.length ? picked : all;       // the player's mini-fretboard choice
    }

    // ── Session lifecycle ─────────────────────────────────────────────
    async function start() {
        // Ear training is a self-contained, mic-free experience.
        if (S.gameKind === 'ear') { startEar(); return; }

        const inst = S.ui.$('nt-instrument').value;
        const tuningName = S.ui.$('nt-tuning').value;
        const noteSet = S.ui.$('nt-noteset').value;
        S.mode = S.ui.$('nt-mode').value;
        S.mic.deviceId = S.ui.$('nt-mic').value;
        saveMicSettings();

        const freqs = (S.tunings[inst] || {})[tuningName];
        if (!freqs) return;
        S.openMidi = M().openMidiFromFreqs(freqs);
        S.stringCount = S.openMidi.length;
        S.maxFret = (S.config && S.config.maxFret) || 12;

        // Render the fretboard.
        S.fb.render({ openMidi: S.openMidi, maxFret: S.maxFret });

        // Persist the chosen setup.
        saveProgress({ lastInstrument: inst, lastTuning: tuningName, lastNoteSet: noteSet, lastMode: S.mode });

        // Build the game (skipped in Learn).
        if (S.mode !== 'learn') {
            let gNoteSet, gStrings, gPcs, gCount, gPromote;
            if (S.drillFocus) {
                // Smart-drill: target the weakest strings × notes regardless of
                // the note-set dropdown. Chromatic gives every pc, `pcs` narrows.
                gNoteSet = 'chromatic';
                gStrings = S.drillFocus.strings;
                gPcs = S.drillFocus.pcs;
                gCount = 12; gPromote = 0.8;
            } else {
                const lv = S.currentLevelId != null ? S.levels.find(l => l.id === S.currentLevelId) : null;
                gNoteSet = lv ? lv.noteSet : noteSet;
                gStrings = allowedStringsForLevel(lv);
                gCount = lv ? lv.count : (S.mode === 'relax' ? 20 : 15);
                gPromote = lv ? lv.promote : 0.8;
            }
            S.game = window._noteTrainerGame.createGame({
                openMidi: S.openMidi, maxFret: S.maxFret,
                noteSet: gNoteSet, strings: gStrings, pcs: gPcs,
                mode: S.mode, count: gCount, promote: gPromote,
            });
            advanceTarget();
            if (S.drillFocus) S.ui.feedback('🎯 Drilling your weak spots — relax mode, take your time.', 'hint');
        } else {
            S.game = null;
            S.ui.setPrompt('', null);
            S.fb.clearHighlight();
        }

        // Per-mode HUD visibility.
        const showStats = S.mode !== 'learn';
        S.ui.$('nt-score').parentElement.style.display = showStats ? '' : 'none';
        S.ui.$('nt-combo').parentElement.style.display = showStats ? '' : 'none';
        S.ui.$('nt-timer-wrap').style.display = (S.mode === 'arcade' || S.mode === 'challenge') ? '' : 'none';
        S.ui.$('nt-progress-wrap').style.display = showStats ? '' : 'none';

        S.ui.setScore(0);
        S.ui.setCombo(0);
        S.ui.feedback('', '');
        S.ui.clearMicError();

        S.root.classList.add('is-playing');
        S.ui.$('nt-stop').style.display = '';

        // Start audio.
        try {
            await window._noteTrainerAudio.start({
                deviceId: S.mic.deviceId, channel: S.mic.channel, audioInputMode: S.mic.audioInputMode,
            }, onDetection);
            S.running = true;
            startTimer();
        } catch (e) {
            console.error('Note Trainer: audio start failed', e);
            S.ui.showMicError(e);
            stop();
        }
    }

    function stop() {
        S.running = false;
        S.earBusy = false;
        stopTimer();
        if (window._noteTrainerAudio) window._noteTrainerAudio.stop();
        S.root.classList.remove('is-playing');
        S.root.classList.remove('is-ear');
        S.ui.$('nt-stop').style.display = 'none';
        S.ui.hideResults();
        if (S.config) refreshSelection();
    }

    function startTimer() {
        stopTimer();
        if (S.mode !== 'arcade' && S.mode !== 'challenge') return;
        S.timerInterval = setInterval(() => {
            if (!S.game || !S.game.state.target) return;
            S.ui.setTimer((Date.now() - S.game.state.targetShownAt) / 1000);
        }, 100);
    }
    function stopTimer() { if (S.timerInterval) { clearInterval(S.timerInterval); S.timerInterval = null; } }

    function advanceTarget() {
        S.fb.clear();
        const t = S.game.nextTarget();
        S.fb.highlightString(t.stringIndex);
        S.ui.setPrompt(t.name, stringLabel(t.stringIndex));
        S.ui.setProgress(S.game.state.correctCount, S.game.config.count);
        if (S.mode === 'arcade' || S.mode === 'challenge') S.ui.setTimer(0);
    }

    // ── Detection callback (≈ every 30ms) ─────────────────────────────
    function onDetection(res) {
        const note = (res && res.smoothedFreq) ? M().freqToNoteOctave(res.smoothedFreq) : null;

        if (note) {
            const sign = note.cents >= 0 ? '+' : '';
            S.ui.setDetected('Detected: <b>' + note.nameSharp + note.octave + '</b> (' + sign + note.cents + ' cents)');
        } else {
            S.ui.setDetected(res && res.hasSignal ? 'Uncertain note…' : 'Listening…');
        }

        if (S.mode === 'learn') {
            if (note) { S.fb.markDetected(note.midi); S.ui.setPrompt(note.nameSharp + note.octave, null); }
            return;
        }

        if (!S.game) return;
        const ev = S.game.feed({
            midi: note ? note.midi : null,
            cents: note ? note.cents : 0,
            hasSignal: !!(res && res.hasSignal),
        });
        if (ev.committed) handleCommit(ev);
    }

    function handleCommit(ev) {
        const t = ev.target;
        S.ui.setScore(S.game.state.score, ev.verdict === 'correct');
        S.ui.setCombo(S.game.state.combo);

        if (ev.verdict === 'correct') {
            const fret = ev.detectedMidi - t.openMidi;
            S.fb.flash(t.stringIndex, fret, 'ok');
            S.ui.ding(S.game.state.combo);
            let msg = 'Correct! ' + t.name;
            if (ev.multiplier > 1) msg += '  (combo x' + ev.multiplier + ')';
            S.ui.feedback(msg, 'ok');
            S.ui.setProgress(S.game.state.correctCount, S.game.config.count);
            setTimeout(() => {
                if (!S.running) return;
                if (S.game.isFinished()) finishSession();
                else { S.ui.feedback('', ''); advanceTarget(); }
            }, 650);
        } else if (ev.verdict === 'wrong-string') {
            S.ui.buzz();
            S.ui.feedback('Right note, but not on the ' + stringLabel(t.stringIndex) + ' — try again.', 'err');
            maybeReveal(ev);
        } else { // wrong-note
            S.ui.buzz();
            const got = M().nameOf(M().pitchClass(ev.detectedMidi), false);
            S.ui.feedback('You played ' + got + ', need ' + t.name + ' — try again.', 'err');
            maybeReveal(ev);
        }
    }

    function maybeReveal(ev) {
        if (!ev.shouldReveal) return;
        const t = ev.target;
        S.fb.showTarget(t.stringIndex, S.game.targetFrets(), t.name);
        S.ui.feedback('Hint: ' + t.name + ' is here ↓', 'hint');
    }

    async function finishSession() {
        stopTimer();
        const result = S.game.levelResult();

        // Persist best score and accumulate per-note/string stats (mastery grows
        // across sessions, so it can't be undone by one bad run on a key).
        const key = S.currentLevelId != null ? String(S.currentLevelId) : 'free';
        const best = Object.assign({}, S.config.bestScores);
        if (!best[key] || result.score > best[key]) best[key] = result.score;

        const stats = {};
        for (const k in S.config.stats) stats[k] = Object.assign({}, S.config.stats[k]);
        for (const k in S.game.state.stats) {
            const cur = stats[k] || (stats[k] = { correct: 0, wrong: 0 });
            cur.correct += S.game.state.stats[k].correct;
            cur.wrong += S.game.state.stats[k].wrong;
        }
        const patch = { bestScores: best, stats };

        // Keep the best medal ever earned on this level.
        let message = Math.round(result.accuracy * 100) + '% accuracy.';
        if (S.currentLevelId != null && result.medal) {
            const order = { bronze: 1, silver: 2, gold: 3 };
            const medals = Object.assign({}, S.config.medals);
            if (!medals[key] || order[result.medal] > order[medals[key]]) medals[key] = result.medal;
            patch.medals = medals;
            message += ' ' + MEDAL_EMOJI[result.medal] + ' '
                + result.medal.charAt(0).toUpperCase() + result.medal.slice(1) + '!';
        } else if (S.currentLevelId != null) {
            message += ' Reach ' + Math.round((S.game.config.promote) * 100) + '% for a medal.';
        }

        await saveProgress(patch);
        S.running = false;
        if (window._noteTrainerAudio) window._noteTrainerAudio.stop();
        S.ui.showResults(result, { title: 'Session complete', message });
        recordSession('fret', result);
    }

    // ── Achievements / lifetime ───────────────────────────────────────
    // After every session (fret or ear) we fold the result into the player's
    // lifetime totals and re-evaluate the long-term achievements, toasting any
    // newly unlocked ones. Pure logic lives in utils/achievements.js; this just
    // builds its context from the just-saved config.
    function computeStringMastered() {
        if (!S.openMidi || !S.openMidi.length || !S.levels.length) return false;
        return S.levels.some(lv => {
            for (let i = 0; i < S.openMidi.length; i++) {
                if (masteryFor(lv.noteSet, i).stars >= 2) return true;
            }
            return false;
        });
    }

    function recordSession(kind, result) {
        const ach = window._noteTrainerAchievements;
        if (!ach || !result) return;
        const lifetime = Object.assign({ correct: 0, wrong: 0, sessions: 0 }, S.config.lifetime || {});
        lifetime.correct += result.correct || 0;
        lifetime.wrong += result.wrong || 0;
        lifetime.sessions += 1;

        const ctx = {
            sessionType: kind,
            result,
            medals: S.config.medals || {},
            lifetime,
            stringMastered: kind === 'fret' ? computeStringMastered() : false,
        };
        if (kind === 'ear') ctx.intervalMode = S.earMode === 'interval';

        const newly = ach.evaluate(ctx, S.config.achievements || []);
        if (newly.length) {
            const achievements = (S.config.achievements || []).concat(newly.map(a => a.id));
            saveProgress({ lifetime, achievements });
            newly.forEach((a, i) => {
                setTimeout(() => S.ui.toast(a.icon + ' ' + a.title, a.desc), 350 + i * 750);
            });
        } else {
            saveProgress({ lifetime });
        }
        updateGlobalProgress();
    }

    // ── Ear training ──────────────────────────────────────────────────
    // The difficulty segmented control lives inside the minigame.
    function renderEarDiff() {
        S.ui.$('nt-ear-diff').querySelectorAll('.nt-seg').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-tier') === S.earTier);
        });
        renderEarMastery();
    }

    // Lifetime "how well do I know each interval" readout for the selected
    // difficulty, drawn from the persisted per-interval stats. Hidden until
    // there's at least one tried interval. Doubles as a progress map and an
    // explanation of why some intervals come up more (the picker favours weak
    // ones). Labels follow the answer mode: interval symbols, or note names.
    function renderEarMastery() {
        const box = S.ui.$('nt-ear-mastery');
        if (!box) return;
        const TIERS = window._noteTrainerEar && window._noteTrainerEar.TIERS;
        const tier = TIERS && (TIERS[S.earTier] || TIERS.easy);
        const stats = S.config.earStats || {};
        const offsets = (tier && tier.offsets) || [];
        const hasData = offsets.some(o => { const s = stats[o]; return s && (s.correct + s.wrong) > 0; });
        if (!hasData) { box.style.display = 'none'; box.innerHTML = ''; return; }

        const m = M();
        const byInterval = S.earMode === 'interval';
        let rows = '';
        offsets.forEach(o => {
            const iv = m.intervalName(o);
            const s = stats[o] || { correct: 0, wrong: 0 };
            const n = s.correct + s.wrong;
            const acc = n ? s.correct / n : null;
            const pct = acc == null ? 0 : Math.round(acc * 100);
            const cls = acc == null ? '' : acc >= 0.85 ? 'is-strong' : acc >= 0.6 ? 'is-mid' : 'is-weak';
            const label = byInterval ? iv.abbr : m.nameOf(o, false);
            const tip = (byInterval ? iv.long : m.nameOf(o, false)) + (n ? ' — ' + s.correct + '/' + n + ' correct' : ' — not tried yet');
            rows += '<div class="nt-em-row" title="' + tip + '">'
                + '<span class="nt-em-abbr">' + label + '</span>'
                + '<span class="nt-em-bar"><span class="nt-em-fill ' + cls + '" style="width:' + pct + '%"></span></span>'
                + '<span class="nt-em-pct' + (acc == null ? ' is-empty' : '') + '">' + (acc == null ? '—' : pct + '%') + '</span>'
                + '</div>';
        });
        box.innerHTML = '<div class="nt-em-head"><span>Your ' + (byInterval ? 'interval' : 'note') + ' mastery</span>'
            + '<span class="nt-em-hint">weak ones come up more</span></div>' + rows;
        box.style.display = '';
    }

    function setEarTier(tier) {
        if (!tier || tier === S.earTier) { renderEarDiff(); return; }
        S.earTier = tier;
        saveProgress({ lastEarTier: tier });
        renderEarDiff();
        if (S.running && S.gameKind === 'ear') startEar();   // restart with the new difficulty
    }

    // Ear training can be answered with note names (the letter) or interval
    // names (the distance from the home note). Intervals are the deeper,
    // transferable theory skill; notes are the gentler on-ramp. Both are
    // always available so the player can switch any time.
    function renderEarMode() {
        const seg = S.ui.$('nt-ear-mode');
        if (seg) seg.querySelectorAll('.nt-seg').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-mode') === S.earMode);
        });
        const intro = S.ui.$('nt-ear-intro');
        if (intro) {
            intro.textContent = S.earMode === 'interval'
                ? 'A "home" note plays, then a mystery note — name the INTERVAL (the distance between them) you heard. Intervals are the building blocks of melody and chords, so this is the real ear-training skill. New to the labels (M3, P5, TT…)? A cheat-sheet under the buttons explains each one and links it to a famous tune. Ten rounds, streaks and a final medal.'
                : 'A reference "home" note plays, then a mystery note — name what you heard from the buttons. Ten rounds per session, with streaks and a final medal.';
        }
        renderEarMastery();
    }

    function setEarMode(mode) {
        if (!mode || mode === S.earMode) { renderEarMode(); return; }
        S.earMode = mode;
        saveProgress({ earMode: mode });
        renderEarMode();
        if (S.running && S.gameKind === 'ear') startEar();   // relabel the buttons live
    }

    // Show/hide the on-demand "Hear home note" button to match the reference
    // toggle: if the player turned the anchor off, the button is pointless.
    function applyEarUseHome() {
        const wrap = S.ui.$('nt-ear-home-wrap');
        if (wrap) wrap.style.display = S.earUseHome ? '' : 'none';
    }

    function setEarUseHome(on) {
        const val = !!on;
        if (val === S.earUseHome) return;
        S.earUseHome = val;
        saveProgress({ earUseHome: val });
        applyEarUseHome();
    }

    function startEar() {
        S.mode = 'ear';
        const tier = S.earTier;
        saveProgress({ lastMode: 'ear', lastEarTier: tier });
        // Carry the player's lifetime per-interval record in so the picker
        // over-samples whatever they keep getting wrong (adaptive practice).
        S.ear = window._noteTrainerEar.createEar({ tier, rounds: 10, priorStats: S.config.earStats || {} });
        S.earBusy = false;
        renderEarDiff();

        S.ui.$('nt-ear-root').textContent = S.ear.rootName;
        S.ui.$('nt-ear-feedback').textContent = '';
        S.ui.$('nt-ear-feedback').className = 'nt-feedback';
        renderEarChoices();
        renderEarTheory();
        earHud();

        S.root.classList.add('is-ear');
        S.ui.$('nt-stop').style.display = '';
        S.running = true;
        nextEarRound();
    }

    function earHud() {
        if (!S.ear) return;
        S.ui.$('nt-ear-score').textContent = String(S.ear.state.score);
        const c = S.ear.state.combo;
        const streak = S.ui.$('nt-ear-streak');
        streak.innerHTML = 'x' + c + (c >= 3 ? ' <svg class="nt-ic is-fill"><use href="#nt-i-fire"/></svg>' : '');
        const stat = streak.closest('.nt-stat');
        if (stat) {
            stat.classList.toggle('is-hot', c >= 3);
            stat.classList.toggle('is-blazing', c >= 6);
        }
        const total = S.ear.config.rounds;
        S.ui.$('nt-ear-round').textContent = Math.min(S.ear.state.round, total) + '/' + total;
    }

    function renderEarChoices() {
        const wrap = S.ui.$('nt-ear-choices');
        wrap.innerHTML = '';
        const interval = S.earMode === 'interval';
        const seen = new Set();
        S.ear.pool.forEach(n => {            // pool is in ascending musical order
            if (seen.has(n.pc)) return;
            seen.add(n.pc);
            const b = document.createElement('button');
            b.className = 'nt-choice' + (interval ? ' is-interval' : '');
            if (interval) {
                b.innerHTML = '<span class="nt-abbr">' + n.interval.abbr + '</span>'
                    + '<span class="nt-full">' + n.interval.long + '</span>';
                b.title = n.interval.long + ' — ' + n.interval.desc;
            } else {
                b.textContent = n.name;
            }
            b.setAttribute('data-pc', String(n.pc));
            b.addEventListener('click', () => onEarGuess(n.pc));
            wrap.appendChild(b);
        });
    }

    // A small "cheat sheet" under the answer buttons that explains what each
    // interval in play actually is — its character and a famous tune whose
    // opening leap matches it. This is what makes interval mode a lesson
    // instead of a guess: the player can map "M3" to a bright, happy sound
    // ("When the Saints…") rather than memorising an abbreviation. Only shown
    // in interval mode and only for the intervals actually in the current pool.
    function renderEarTheory() {
        const box = S.ui.$('nt-ear-theory');
        if (!box) return;
        if (S.earMode !== 'interval' || !S.ear) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        const seen = new Set();
        let rows = '';
        S.ear.pool.forEach(n => {
            const iv = n.interval;
            if (seen.has(iv.abbr)) return;
            seen.add(iv.abbr);
            rows += '<li class="nt-th-row">'
                + '<span class="nt-th-abbr">' + iv.abbr + '</span>'
                + '<span class="nt-th-body">'
                +   '<span class="nt-th-name">' + iv.long + '</span>'
                +   '<span class="nt-th-desc">' + iv.desc + '</span>'
                +   '<span class="nt-th-song">♪ ' + iv.song + '</span>'
                + '</span>'
                + '</li>';
        });
        box.innerHTML = '<div class="nt-th-head">What the intervals mean</div>'
            + '<ul class="nt-th-list">' + rows + '</ul>';
        box.style.display = '';
    }

    // Enable/disable the answer buttons. When enabling mid-round, choices
    // already marked wrong stay locked so the player can't re-pick a dud — they
    // pick from what's left across their remaining attempts.
    function enableChoices(on) {
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => {
            b.disabled = on ? b.classList.contains('wrong') : true;
        });
    }
    function clearChoiceStates() {
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => b.classList.remove('correct', 'wrong'));
    }
    function markChoice(pc, cls) {
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => {
            if (parseInt(b.getAttribute('data-pc'), 10) === pc) b.classList.add(cls);
        });
    }
    function setViz(on) {
        const v = S.ui.$('nt-ear-viz');
        if (v) v.classList.toggle('is-sounding', !!on);
    }

    // Play the home (reference) note, then the mystery target, then unlock the
    // answer buttons. The home anchor is what makes this learnable. Timing is
    // paced so each note is fully audible with a clean gap between them — no
    // overlap, no clipped attack. When the reference toggle is off, only the
    // target sounds (harder: trains absolute pitch).
    function playEarSequence(target) {
        S.earBusy = true;
        enableChoices(false);
        setViz(true);
        const HOME_DUR = 900, TARGET_DUR = 1100, GAP = 280, TAIL = 120;
        if (S.earUseHome) {
            S.ui.playNoteTone(S.ear.rootFreq, HOME_DUR);
            const targetAt = HOME_DUR + GAP;
            setTimeout(() => { if (S.running) S.ui.playNoteTone(target.freq, TARGET_DUR); }, targetAt);
            setTimeout(() => {
                if (!S.running) return;
                setViz(false);
                enableChoices(true);
                S.earBusy = false;
            }, targetAt + TARGET_DUR + TAIL);
        } else {
            S.ui.playNoteTone(target.freq, TARGET_DUR);
            setTimeout(() => {
                if (!S.running) return;
                setViz(false);
                enableChoices(true);
                S.earBusy = false;
            }, TARGET_DUR + TAIL);
        }
    }

    function nextEarRound() {
        if (!S.running || !S.ear) return;
        clearChoiceStates();
        S.ui.$('nt-ear-feedback').textContent = '';
        S.ui.$('nt-ear-feedback').className = 'nt-feedback';
        const t = S.ear.nextRound();
        earHud();
        playEarSequence(t);
    }

    // Turn a wrong guess into a teaching moment: name what the player picked and
    // how it relates to the right answer. In interval mode that's the semitone
    // gap and direction ("Major 3rd — 1 semitone narrower"); in note mode it's
    // simply the note they named. Empty when the guess somehow matches.
    function guessContrast(ev) {
        if (ev.guessPc === ev.expectedPc) return '';
        if (S.earMode === 'interval') {
            const g = M().intervalName(ev.guessPc);
            const d = ev.expectedPc - ev.guessPc;     // root is C, so pc === offset
            const n = Math.abs(d);
            return ' You said ' + g.long + ' — ' + n + ' semitone' + (n > 1 ? 's' : '')
                + (d > 0 ? ' narrower' : ' wider') + ' than the answer.';
        }
        return ' You said ' + M().nameOf(ev.guessPc, false) + '.';
    }

    function onEarGuess(pc) {
        if (!S.running || !S.ear || S.earBusy || S.ear.isFinished()) return;
        S.earBusy = true;
        enableChoices(false);
        const ev = S.ear.guess(pc);
        earHud();
        const fb = S.ui.$('nt-ear-feedback');
        const cur = S.ear.state.current;

        // Wrong, but tries remain: lock just this choice, nudge, replay the
        // mystery note and reopen the round — don't reveal the answer yet.
        if (!ev.resolved) {
            markChoice(ev.guessPc, 'wrong');
            S.ui.buzz();
            const left = ev.attemptsLeft;
            fb.textContent = 'Not quite —' + guessContrast(ev) + ' ' + left + (left === 1 ? ' try' : ' tries') + ' left. Listen again.';
            fb.className = 'nt-feedback hint';
            if (cur) S.ui.playNoteTone(cur.freq, 700);
            setTimeout(() => {
                if (!S.running) return;
                enableChoices(true);   // wrong choices stay locked
                S.earBusy = false;
            }, 1100);
            return;
        }

        // Round resolved — either correct, or out of attempts. Reveal the
        // answer (and mark the final wrong pick, if any).
        S.ui.$('nt-ear-choices').querySelectorAll('.nt-choice').forEach(b => {
            const bpc = parseInt(b.getAttribute('data-pc'), 10);
            if (bpc === ev.expectedPc) b.classList.add('correct');
            else if (bpc === ev.guessPc && !ev.correct) b.classList.add('wrong');
        });

        // A correct answer that needed more than one try gets a gentler note.
        const tryNote = ev.correct && ev.attempt > 1 ? ' (on try ' + ev.attempt + ')' : '';
        if (S.earMode === 'interval' && cur) {
            // Reinforce the theory bond: name the interval AND the note pair
            // (root → target), so the sound links to both concepts at once.
            const pair = S.ear.rootName + ' → ' + cur.name;
            const ivl = cur.interval.long;
            if (ev.correct) {
                S.ui.ding(S.ear.state.combo);
                fb.textContent = 'Correct — ' + ivl + ' (' + pair + ')' + tryNote + (ev.multiplier > 1 ? '  (streak x' + ev.multiplier + ')' : '') + '!';
                fb.className = 'nt-feedback ok';
            } else {
                S.ui.buzz();
                fb.textContent = 'Out of tries — it was a ' + ivl + ' (' + pair + ').' + guessContrast(ev) + ' Listen to it again.';
                fb.className = 'nt-feedback err';
            }
        } else if (ev.correct) {
            S.ui.ding(S.ear.state.combo);
            fb.textContent = 'Correct — that was ' + ev.expectedName + tryNote + (ev.multiplier > 1 ? '  (streak x' + ev.multiplier + ')' : '') + '!';
            fb.className = 'nt-feedback ok';
        } else {
            S.ui.buzz();
            fb.textContent = 'Out of tries — it was ' + ev.expectedName + '.' + guessContrast(ev) + ' Listen to it again.';
            fb.className = 'nt-feedback err';
        }
        // Replay the answer so the ear bonds the sound to the name.
        if (cur) S.ui.playNoteTone(cur.freq, 700);

        setTimeout(() => {
            if (!S.running) return;
            S.earBusy = false;
            if (ev.finished) finishEar();
            else nextEarRound();
        }, ev.correct ? 1000 : 1600);
    }

    function finishEar() {
        const result = S.ear.result();
        const key = 'ear:' + S.ear.config.tier;
        const best = Object.assign({}, S.config.bestScores);
        if (!best[key] || result.score > best[key]) best[key] = result.score;
        const patch = { bestScores: best };

        // Fold this session's per-interval tally into the lifetime record, so
        // adaptive practice and the mastery readout keep improving over time.
        const earStats = {};
        for (const k in S.config.earStats) earStats[k] = Object.assign({}, S.config.earStats[k]);
        for (const k in S.ear.state.stats) {
            const cur = earStats[k] || (earStats[k] = { correct: 0, wrong: 0 });
            cur.correct += S.ear.state.stats[k].correct;
            cur.wrong += S.ear.state.stats[k].wrong;
        }
        patch.earStats = earStats;

        if (result.medal) {
            const order = { bronze: 1, silver: 2, gold: 3 };
            const medals = Object.assign({}, S.config.medals);
            if (!medals[key] || order[result.medal] > order[medals[key]]) medals[key] = result.medal;
            patch.medals = medals;
        }
        saveProgress(patch);
        S.running = false;

        let message = Math.round(result.accuracy * 100) + '% correct.';
        if (result.medal) message += ' ' + MEDAL_EMOJI[result.medal] + ' '
            + result.medal.charAt(0).toUpperCase() + result.medal.slice(1) + '!';
        // Point the player at what to work on next: their weakest intervals.
        const weak = (result.weakest || []).filter(w => w.accuracy != null && w.accuracy < 1).slice(0, 2);
        if (weak.length) {
            message += ' Toughest: ' + weak.map(w => w.interval.long).join(', ') + '.';
        }
        S.ui.showResults(result, { title: 'Ear training complete', message });
        recordSession('ear', result);
    }

    // ── Binding / boot ────────────────────────────────────────────────
    async function loadData() {
        const [cfg, tun, lvl] = await Promise.all([
            fetch(API + '/config').then(r => r.json()).catch(() => ({})),
            fetch(API + '/tunings').then(r => r.json()).catch(() => ({ tunings: {} })),
            fetch(API + '/levels').then(r => r.json()).catch(() => ({ levels: [] })),
        ]);
        S.config = Object.assign({
            bestScores: {}, medals: {}, levelStrings: {}, stats: {}, earStats: {},
            achievements: [], lifetime: { correct: 0, wrong: 0, sessions: 0 },
            maxFret: 12, lastEarTier: 'easy', earMode: 'note', earUseHome: true,
        }, cfg);
        S.tunings = tun.tunings || {};
        S.levels = lvl.levels || [];
        S.levelStrings = Object.assign({}, S.config.levelStrings);
    }

    async function init() {
        S.ui = window._noteTrainerUI(S.root);
        S.fb = window._noteTrainerFretboard(S.ui.$('nt-fretboard'));
        loadMicSettings();
        await loadData();

        const verEl = S.ui.$('nt-version');
        if (verEl) verEl.textContent = ' v0.1.0';

        populateInstruments();
        await populateMics();
        if (S.config.lastNoteSet) S.ui.$('nt-noteset').value = S.config.lastNoteSet;
        if (S.config.lastEarTier) S.earTier = S.config.lastEarTier;
        if (S.config.earMode === 'interval' || S.config.earMode === 'note') S.earMode = S.config.earMode;
        if (typeof S.config.earUseHome === 'boolean') S.earUseHome = S.config.earUseHome;
        const useHomeEl = S.ui.$('nt-ear-use-home');
        if (useHomeEl) useHomeEl.checked = S.earUseHome;
        applyEarUseHome();
        if (S.config.lastMode && S.config.lastMode !== 'ear') S.ui.$('nt-mode').value = S.config.lastMode;
        S.mode = S.ui.$('nt-mode').value;
        renderEarDiff();
        renderEarMode();

        // Restore the last game picked (ear training is its own card, not a mode).
        if (S.config.lastMode === 'ear') selectEar();
        else { S.gameKind = 'fret'; refreshSelection(); }

        S.ui.$('nt-instrument').addEventListener('change', () => { populateTunings(); renderLevels(); });
        S.ui.$('nt-tuning').addEventListener('change', renderLevels);
        S.ui.$('nt-start').addEventListener('click', () => { if (!S.running) start(); });
        S.ui.$('nt-stop').addEventListener('click', stop);
        S.ui.$('nt-res-close').addEventListener('click', () => { S.ui.hideResults(); stop(); });
        S.ui.$('nt-res-again').addEventListener('click', () => { S.ui.hideResults(); start(); });

        // Ear-training controls.
        S.ui.$('nt-ear-diff').querySelectorAll('.nt-seg').forEach(b => {
            b.addEventListener('click', () => setEarTier(b.getAttribute('data-tier')));
        });
        S.ui.$('nt-ear-mode').querySelectorAll('.nt-seg').forEach(b => {
            b.addEventListener('click', () => setEarMode(b.getAttribute('data-mode')));
        });
        if (useHomeEl) useHomeEl.addEventListener('change', () => setEarUseHome(useHomeEl.checked));
        S.ui.$('nt-ear-replay').addEventListener('click', () => {
            if (S.ear && S.ear.state.current && !S.ear.isFinished()) playEarSequence(S.ear.state.current);
        });
        S.ui.$('nt-ear-home-btn').addEventListener('click', () => {
            if (S.ear) S.ui.playNoteTone(S.ear.rootFreq, 650);
        });

        // Stop audio whenever we leave the Note Trainer screen.
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('screen:changed', () => {
                if (S.running && (!S.root || !S.root.offsetParent)) stop();
            });
        }
    }

    function bind() {
        if (S.bound) return true;
        const root = document.getElementById('note-trainer-root');
        if (!root) return false;
        S.bound = true;
        S.root = root;
        init().catch(e => console.error('Note Trainer: init failed', e));
        return true;
    }

    function boot() {
        // Preload utility scripts (note-math first — game.js captures it at eval).
        _loadScript(API + '/utils/note-math.js')
            .then(() => Promise.all([
                _loadScript(API + '/utils/game.js'),
                _loadScript(API + '/utils/ear.js'),
                _loadScript(API + '/utils/achievements.js'),
                _loadScript(API + '/utils/fretboard.js'),
                _loadScript(API + '/utils/ui.js'),
                _loadScript(API + '/utils/audio.js'),
            ]))
            .then(() => {
                if (bind()) return;
                let tries = 0;
                const timer = setInterval(() => { tries++; if (bind() || tries > 40) clearInterval(timer); }, 250);
            })
            .catch(e => console.error('Note Trainer: boot failed', e));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
    console.log('Note Trainer plugin loaded.');
})();
