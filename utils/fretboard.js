/**
 * SVG fretboard renderer for Note Trainer.
 *
 * Vanilla SVG (no deps), scoped under .note-trainer-root. One instance per
 * mounted screen. Coordinate space is fixed and the <svg> scales to its
 * container via viewBox. String index 0 is the LOWEST-pitched string and is
 * drawn at the bottom (conventional guitar/bass orientation).
 *
 *   const fb = window._noteTrainerFretboard(containerEl);
 *   fb.render({ openMidi:[...], maxFret:12 });
 *   fb.highlightString(0);            // glow the target string
 *   fb.showTarget(0, [8, 20]);        // dim dots at correct frets (hint/reveal)
 *   fb.flash(0, 8, 'ok' | 'err');     // pulse a fret
 *   fb.markDetected(midi);            // learn mode: light every position of a note
 *   fb.clear();                       // drop all overlays
 */
(function () {
    const SVGNS = 'http://www.w3.org/2000/svg';
    const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];
    const DOUBLE_INLAYS = [12, 24];

    function el(name, attrs) {
        const node = document.createElementNS(SVGNS, name);
        if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
        return node;
    }

    function create(container) {
        const M = (typeof window !== 'undefined') ? window._noteTrainerMath : null;

        // Fixed drawing geometry (viewBox units).
        const LEFT = 78;      // room for open-string note + string label
        const RIGHT = 24;
        const TOP = 26;       // room for fret numbers
        const BOTTOM = 16;
        const FW = 64;        // per-fret width
        const SH = 34;        // per-string spacing

        let svg = null;
        let openMidi = [];
        let maxFret = 12;
        let stringCount = 6;
        const overlay = [];   // transient nodes (targets/flashes/detected)

        function stringY(i) { return TOP + (stringCount - 1 - i) * SH; }
        function fretCenterX(f) { return f === 0 ? LEFT - 30 : LEFT + (f - 0.5) * FW; }
        function fretLineX(f) { return LEFT + f * FW; }

        function noteLabel(midi) {
            if (!M) return '';
            return M.nameOf(M.pitchClass(midi), false) + M.octaveOf(midi);
        }

        function render(opts) {
            openMidi = (opts.openMidi || []).slice();
            maxFret = opts.maxFret || 12;
            stringCount = openMidi.length || 6;
            overlay.length = 0;

            const width = LEFT + maxFret * FW + RIGHT;
            const height = TOP + (stringCount - 1) * SH + BOTTOM;

            container.innerHTML = '';
            svg = el('svg', {
                viewBox: `0 0 ${width} ${height}`,
                class: 'note-trainer-fb-svg',
                preserveAspectRatio: 'xMidYMid meet',
            });

            // Fretboard wood panel.
            svg.appendChild(el('rect', {
                x: LEFT, y: TOP - SH / 2, width: maxFret * FW, height: (stringCount - 1) * SH + SH,
                rx: 4, class: 'note-trainer-fb-board',
            }));

            // Inlay markers.
            const midY = TOP + ((stringCount - 1) * SH) / 2;
            INLAYS.forEach(f => {
                if (f <= maxFret) svg.appendChild(el('circle', {
                    cx: fretCenterX(f), cy: midY, r: 6, class: 'note-trainer-fb-inlay',
                }));
            });
            DOUBLE_INLAYS.forEach(f => {
                if (f <= maxFret) {
                    svg.appendChild(el('circle', { cx: fretCenterX(f), cy: midY - SH * 0.7, r: 6, class: 'note-trainer-fb-inlay' }));
                    svg.appendChild(el('circle', { cx: fretCenterX(f), cy: midY + SH * 0.7, r: 6, class: 'note-trainer-fb-inlay' }));
                }
            });

            // Fret wires (fret 0 = nut, drawn thicker).
            for (let f = 0; f <= maxFret; f++) {
                svg.appendChild(el('line', {
                    x1: fretLineX(f), y1: stringY(stringCount - 1) - SH / 2,
                    x2: fretLineX(f), y2: stringY(0) + SH / 2,
                    class: f === 0 ? 'note-trainer-fb-nut' : 'note-trainer-fb-fret',
                }));
            }

            // Fret numbers.
            for (let f = 1; f <= maxFret; f++) {
                const t = el('text', { x: fretCenterX(f), y: 14, class: 'note-trainer-fb-fretnum' });
                t.textContent = String(f);
                svg.appendChild(t);
            }

            // Strings + open-string labels.
            for (let i = 0; i < stringCount; i++) {
                const y = stringY(i);
                svg.appendChild(el('line', {
                    x1: LEFT, y1: y, x2: fretLineX(maxFret), y2: y,
                    class: 'note-trainer-fb-string', 'data-string': i,
                    'stroke-width': 1 + (stringCount - 1 - i) * 0.5,   // thicker for lower strings
                }));
                const lbl = el('text', { x: 10, y: y + 4, class: 'note-trainer-fb-strlabel', 'data-strlabel': i });
                lbl.textContent = noteLabel(openMidi[i]);
                svg.appendChild(lbl);
            }

            // Per-string highlight band (hidden until highlightString).
            for (let i = 0; i < stringCount; i++) {
                svg.appendChild(el('rect', {
                    x: LEFT, y: stringY(i) - SH / 2 + 3, width: maxFret * FW, height: SH - 6,
                    class: 'note-trainer-fb-band', 'data-band': i, opacity: 0,
                }));
            }

            container.appendChild(svg);
        }

        function highlightString(idx) {
            if (!svg) return;
            svg.querySelectorAll('[data-band]').forEach(b => {
                // Subtle tint on the target string only; the others stay hidden.
                b.setAttribute('opacity', String(parseInt(b.getAttribute('data-band'), 10) === idx ? 0.10 : 0));
            });
            svg.querySelectorAll('[data-strlabel]').forEach(l => {
                l.classList.toggle('is-target', parseInt(l.getAttribute('data-strlabel'), 10) === idx);
            });
        }

        function _dot(stringIndex, fret, cls, text) {
            const g = el('g', { class: 'note-trainer-fb-mark ' + cls });
            g.appendChild(el('circle', { cx: fretCenterX(fret), cy: stringY(stringIndex), r: 11 }));
            if (text) {
                const t = el('text', { x: fretCenterX(fret), y: stringY(stringIndex) + 4, class: 'note-trainer-fb-marktext' });
                t.textContent = text;
                g.appendChild(t);
            }
            svg.appendChild(g);
            overlay.push(g);
            return g;
        }

        // Dim dots showing where the target note sits on a string (hint/reveal).
        function showTarget(stringIndex, frets, label) {
            if (!svg) return;
            (frets || []).forEach(f => _dot(stringIndex, f, 'is-hint', label || ''));
        }

        function flash(stringIndex, fret, kind) {
            if (!svg) return;
            const g = _dot(stringIndex, fret, kind === 'ok' ? 'is-ok' : 'is-err', '');
            // Force reflow so the animation restarts even on repeats.
            // eslint-disable-next-line no-unused-expressions
            g.getBoundingClientRect();
            g.classList.add('is-flash');
        }

        // Learn mode: light every position of a detected note across all strings.
        function markDetected(midi) {
            if (!svg || !M) return;
            clear();
            const pc = M.pitchClass(midi);
            for (let i = 0; i < stringCount; i++) {
                M.fretsForPitchClassOnString(openMidi[i], pc, maxFret).forEach(f => {
                    _dot(i, f, 'is-detected', M.nameOf(pc, false));
                });
            }
        }

        function clear() {
            overlay.forEach(n => n.remove());
            overlay.length = 0;
        }

        function clearHighlight() {
            if (!svg) return;
            svg.querySelectorAll('[data-band]').forEach(b => b.setAttribute('opacity', '0'));
            svg.querySelectorAll('[data-strlabel]').forEach(l => l.classList.remove('is-target'));
        }

        return { render, highlightString, clearHighlight, showTarget, flash, markDetected, clear };
    }

    if (typeof window !== 'undefined') window._noteTrainerFretboard = create;
    if (typeof module !== 'undefined') module.exports = { create };
})();
