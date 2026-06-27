# Note Trainer

> Learn the fretboard with your hands, not flashcards.

A Slopsmith minigame that turns rote fretboard memorization into a game you *play*.
It shows you the neck, asks for a note on a given string (e.g. **C** on the **low E**),
and listens through the microphone to check — in real time — whether you actually
played it. No clicking, no guessing: pick up the instrument and play.

It reuses Slopsmith's pitch-detection pipeline (the **YIN** algorithm running in a Web
Worker, fed by the desktop's JUCE audio bridge, with a browser-microphone fallback),
so detection is fast and works for both **guitar and bass**.

## Why it's different

- **You play, it listens.** Real notes from a real instrument — not a multiple-choice quiz.
- **It adapts to you.** The game tracks which note/string pairs you fumble and steers
  practice toward your weak spots.
- **It also trains your ear.** A separate, mic-free mode builds relative pitch and
  interval recognition — the skills that actually transfer to playing music.
- **It rewards progress.** Combos, medals, achievements and persistent stats keep the
  grind feeling like a game.

## Game modes

| Mode | What you do |
| --- | --- |
| **Relax** | Practice with no timer — scoring, combos and stats, zero pressure. |
| **Arcade** | Beat the clock: speed bonus plus a growing combo multiplier. |
| **Challenge** | A fixed series of notes, ending in a medal (🥉/🥈/🥇) based on accuracy. |
| **Learn** | Explore mode: play a note and watch *every* position on the neck light up with its name and fret. |
| **Ear training** | No mic, no theory required — train your ear with note names or intervals (details below). |

### Ear training, in depth

A "home" reference note plays, then a mystery note; you name what you heard from
on-screen buttons. This trains *relative* pitch — the learnable kind.

- **Three difficulties:** 3 notes (C E G) → the major scale (7 notes) → all 12.
- **Two answer styles:** by **note name**, or by **interval** — the *distance* from the
  home note (Unison, Major 3rd, Perfect 5th…). Interval recognition is the foundation
  of melody and chords and transfers to any key. Interval mode includes an on-screen
  cheat-sheet that ties each label (M3, P5, TT…) to a famous tune.
- **Three tries per round:** points scale down with each attempt; after the third miss
  the answer is revealed and play moves on.
- **Adaptive practice:** a per-interval mastery readout tracks how well you know each one
  across sessions, the picker over-samples your weak intervals, and wrong guesses get
  contrast feedback ("you said P4 — one semitone narrower than the answer").

## Levels & focus

Four levels (`data/levels.json`), all unlocked from the start: **Naturals**, **Sharps**,
**Flats**, **Chromatic**. Pick a level and use the **mini-fretboard** to choose which
string(s) to drill — one string in isolation or the whole neck. Each level card shows
per-string **mastery stars**, an overall mastery bar, your best score, and the best
**medal** you've earned.

- **Free practice** ignores level constraints and just uses the controls above.
- **🎯 Drill weak spots** appears once you have practice data: it auto-focuses a relax
  session on the exact note/string pairs you miss most (the engine's `pcs` allowlist
  narrows the target pool to your trouble zone).

Progress — best scores, medals, per-note/string mastery, picked strings, lifetime totals
and achievements — is saved on the backend. The microphone choice lives in `localStorage`.

## Gamification

- **Combos** build a score multiplier (1× → 2× at a 3 streak → 3× at 6). The success
  chime climbs in pitch and gains a sparkle as the streak heats up, and the combo
  counter glows (hot → blazing).
- **Achievements** are long-term goals — first medal, 10-combo, mastering a string,
  100/500 lifetime notes — that unlock with a toast and live in the header.
- **Medals** are awarded per level/tier for hitting the accuracy threshold.

## How checking works

The audio gives us the **frequency**, not *which* string was plucked. A note counts as
correct when its **pitch class** matches the target **and** the frequency falls within
the **physical range** of the indicated string (any octave of that note on that string
is valid). "Right note, wrong string" and "wrong note" get distinct feedback; after a few
failed attempts the game reveals the correct positions on the fretboard.

## Structure

```
plugin.json     manifest (menu entry, screen, script, routes)
routes.py       serves utils/workers, config (progress), tunings, levels
screen.html     layout: setup, HUD, fretboard SVG, results
screen.js       orchestrator: state, audio lifecycle, game loop
utils/
  audio.js          microphone capture + YIN          (window._noteTrainerAudio)
  note-math.js      note/frequency/fretboard math      (window._noteTrainerMath)
  fretboard.js      SVG fretboard rendering            (window._noteTrainerFretboard)
  game.js           game engine: targets, validation, scoring (window._noteTrainerGame)
  ear.js            ear-training engine: rounds, judging, scoring (window._noteTrainerEar)
  achievements.js   long-term achievement evaluator    (window._noteTrainerAchievements)
  ui.js             HUD, feedback, sounds (note synth), results, toasts (window._noteTrainerUI)
workers/yin.js  pitch detection (Web Worker)
data/levels.json  level curriculum
```

## Tests

```bash
npm run test:js      # node --test  (note-math, game, ear, achievements, yin)
python -m pytest     # backend (config, serving, tunings, levels)
```

The Python tests require `pip install -r requirements-test.txt` (fastapi, httpx, pytest).
Audio/mic behaviour can't be unit-tested — verify it live by running Slopsmith and
opening the plugin screen.
