/**
 * Real-time audio capture + pitch pipeline for Note Trainer.
 *
 * Adapted copy of the tuner plugin's audio pipeline so Note Trainer is
 * self-contained. Differences from the original: the global is
 * `window._noteTrainerAudio` and the YIN worker is loaded from this plugin's
 * own endpoint. Behaviour (desktop JUCE bridge first, getUserMedia fallback,
 * median smoothing + octave fold, re-entrant start/stop guard) is unchanged.
 *
 * window._noteTrainerAudio.start(options, onResult):
 *   options = { deviceId, channel: 'mono'|'left'|'right', audioInputMode: 'auto'|'browser' }
 *   onResult({ smoothedFreq, rms, hasSignal }) — smoothedFreq is null until a
 *   stable pitch is established (warm-up / low confidence / silence).
 */
(function() {
    const _MIN_YIN_SAMPLES = 4096;
    const _FRAME_SIZE = 2048;
    const _MIN_DETECTABLE_HZ = 20;
    const _FREQ_HISTORY_LEN = 3;
    const _WARMUP_FRAMES = 2;
    const _FRAME_WATCHDOG_MS = 500;
    const _WORKER_URL = '/api/plugins/note-trainer/workers/yin.js';

    let _audioCtx = null;
    let _sourceNode = null;
    let _stream = null;
    let _processor = null;
    let _gainNode = null;
    let _accumBuffer = new Float32Array(0);
    let _pendingBuffer = null;
    let _detectInterval = null;
    let _processingFrame = false;
    let _yinWorker = null;
    let _freqHistory = [];
    let _validFrameCount = 0;
    let _lastFreq = 0;
    let _onResult = null;
    let _usingDesktopBridge = false;
    let _bridgeInterval = null;
    let _startGen = 0;
    let _frameSentAt = 0;
    // Track whether WE started the desktop JUCE engine, plus the audio handle to
    // stop it with, so teardown can release the mic instead of leaving it hot.
    // Only stop an engine this plugin started — another plugin (e.g. note_detect)
    // may own a session we must not tear down.
    let _weStartedEngine = false;
    let _engineAudio = null;

    function _octaveFold(freq, ref) {
        if (!ref || freq <= 0) return freq;
        while (freq > ref * 1.414) freq /= 2;
        while (freq < ref / 1.414) freq *= 2;
        return freq;
    }

    function _median(arr) {
        if (!arr.length) return 0;
        var s = arr.slice().sort(function(a, b) { return a - b; });
        var mid = Math.floor(s.length / 2);
        return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    function _handleYinResult(result) {
        const rms = result ? result.rms : 0;
        const hasSignal = rms > 0.01;

        if (!result || (!hasSignal && result.confidence < 0.5) || (result.freq < _MIN_DETECTABLE_HZ && result.freq !== 0)) {
            _validFrameCount = 0; _freqHistory = []; _lastFreq = 0;
            if (_onResult) _onResult({ smoothedFreq: null, rms, hasSignal: false });
            return;
        }

        if (result.confidence < 0.5 && hasSignal) {
            _validFrameCount = 0; _freqHistory = []; _lastFreq = 0;
            if (_onResult) _onResult({ smoothedFreq: null, rms, hasSignal: false });
            return;
        }

        _freqHistory.push(_octaveFold(result.freq, _lastFreq));
        if (_freqHistory.length > _FREQ_HISTORY_LEN) _freqHistory.shift();
        _validFrameCount++;

        if (_validFrameCount <= _WARMUP_FRAMES) {
            if (_onResult) _onResult({ smoothedFreq: null, rms, hasSignal });
            return;
        }

        const smoothedFreq = _median(_freqHistory);
        _lastFreq = smoothedFreq;
        if (_onResult) _onResult({ smoothedFreq, rms, hasSignal });
    }

    function _frameBusy() {
        if (!_processingFrame) return false;
        if (Date.now() - _frameSentAt > _FRAME_WATCHDOG_MS) { _processingFrame = false; return false; }
        return true;
    }

    async function _tryBridgeStart(audioInputMode, myGen) {
        if (audioInputMode === 'browser') return false;
        var desktop = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
        if (!desktop || !desktop.isDesktop || !desktop.audio
            || typeof desktop.audio.isAvailable !== 'function') return false;

        var available = false;
        try { available = await desktop.audio.isAvailable(); } catch (_) {}
        if (myGen !== _startGen) return false;
        if (!available) return false;

        if (typeof desktop.audio.getRawAudioFrame !== 'function') return false;

        var started = false;
        try {
            var running = typeof desktop.audio.isAudioRunning === 'function'
                ? await desktop.audio.isAudioRunning() : false;
            if (!running && typeof desktop.audio.startAudio === 'function') {
                await desktop.audio.startAudio();
                started = true;
                // Remember we own this engine start so _doStop() can release it.
                _weStartedEngine = true;
                _engineAudio = desktop.audio;
            }
        } catch (e) {
            console.warn('[note-trainer] bridge startAudio failed:', e && e.message ? e.message : e);
        }
        if (myGen !== _startGen) {
            if (started && typeof desktop.audio.stopAudio === 'function') {
                try { desktop.audio.stopAudio(); } catch (_) {}
            }
            _weStartedEngine = false;
            _engineAudio = null;
            return false;
        }

        var bridgeSampleRate = 48000;
        try {
            if (typeof desktop.audio.getSampleRate === 'function') {
                var sr = await desktop.audio.getSampleRate();
                if (typeof sr === 'number' && Number.isFinite(sr) && sr > 0) bridgeSampleRate = sr;
            }
        } catch (_) {}
        if (myGen !== _startGen) return false;

        _usingDesktopBridge = true;
        console.log('[note-trainer] using desktop JUCE bridge with raw audio + YIN');

        _yinWorker = new Worker(_WORKER_URL);
        _yinWorker.onmessage = function(e) { _handleYinResult(e.data); _processingFrame = false; };
        _yinWorker.onerror = function(e) { console.error('Note Trainer: YIN worker error', e); _processingFrame = false; };

        _bridgeInterval = setInterval(async function() {
            if (_frameBusy() || !_yinWorker) return;
            try {
                var samples = await desktop.audio.getRawAudioFrame(_MIN_YIN_SAMPLES);
                if (!_yinWorker) return;
                if (!(samples instanceof Float32Array) || samples.length < _MIN_YIN_SAMPLES) return;
                var frame = samples.slice();
                _processingFrame = true;
                _frameSentAt = Date.now();
                _yinWorker.postMessage({ samples: frame, sampleRate: bridgeSampleRate }, [frame.buffer]);
            } catch (e) {
                console.warn('[note-trainer] bridge raw audio poll failed:', e && e.message ? e.message : e);
                if (_onResult) _onResult({ smoothedFreq: null, rms: 0, hasSignal: false });
            }
        }, 30);

        return true;
    }

    async function _doStart(deviceId, channel, audioInputMode) {
        _doStop();
        const myGen = _startGen;

        var bridgeStarted = await _tryBridgeStart(audioInputMode || 'auto', myGen);
        if (myGen !== _startGen) return;
        if (bridgeStarted) return;
        const constraints = {
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
        };
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };

        try {
            _stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            if (e.name === 'OverconstrainedError' && deviceId) {
                delete constraints.audio.deviceId;
                delete constraints.audio.channelCount;
            } else if (e.name === 'NotFoundError' && deviceId) {
                delete constraints.audio.deviceId;
            } else if (e.name === 'OverconstrainedError') {
                delete constraints.audio.channelCount;
            } else {
                throw e;
            }
            _stream = await navigator.mediaDevices.getUserMedia(constraints);
        }

        if (myGen !== _startGen) {
            if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
            return;
        }

        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _sourceNode = _audioCtx.createMediaStreamSource(_stream);
        _gainNode = _audioCtx.createGain();
        _gainNode.gain.value = 1.0;

        if (_sourceNode.channelCount >= 2 && channel !== 'mono') {
            const splitter = _audioCtx.createChannelSplitter(2);
            const merger = _audioCtx.createChannelMerger(1);
            _sourceNode.connect(splitter);
            splitter.connect(merger, channel === 'left' ? 0 : 1, 0);
            merger.connect(_gainNode);
        } else {
            _sourceNode.connect(_gainNode);
        }

        _processor = _audioCtx.createScriptProcessor(_FRAME_SIZE, 1, 1);
        _processor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            const combined = new Float32Array(_accumBuffer.length + input.length);
            combined.set(_accumBuffer);
            combined.set(input, _accumBuffer.length);
            if (combined.length >= _MIN_YIN_SAMPLES) {
                _pendingBuffer = combined.slice(combined.length - _MIN_YIN_SAMPLES);
                _accumBuffer = combined.slice(input.length);
            } else {
                _accumBuffer = combined;
            }
        };

        _gainNode.connect(_processor);
        _processor.connect(_audioCtx.destination);

        _yinWorker = new Worker(_WORKER_URL);
        _yinWorker.onmessage = (e) => { _handleYinResult(e.data); _processingFrame = false; };
        _yinWorker.onerror = (e) => { console.error('Note Trainer: YIN worker error', e); _processingFrame = false; };

        _detectInterval = setInterval(() => {
            if (_frameBusy() || !_pendingBuffer || !_yinWorker) return;
            const buf = _pendingBuffer;
            _pendingBuffer = null;
            _processingFrame = true;
            _frameSentAt = Date.now();
            _yinWorker.postMessage({ samples: buf, sampleRate: _audioCtx.sampleRate }, [buf.buffer]);
        }, 30);
    }

    function _doStop() {
        _startGen++;
        // Release the desktop JUCE engine if WE started it — otherwise the mic
        // stays hot and the audio thread keeps spinning after the game stops or
        // the user leaves the screen. Never stop an engine another plugin owns.
        if (_weStartedEngine && _engineAudio && typeof _engineAudio.stopAudio === 'function') {
            try { _engineAudio.stopAudio(); } catch (_) {}
        }
        _weStartedEngine = false;
        _engineAudio = null;
        if (_bridgeInterval) { clearInterval(_bridgeInterval); _bridgeInterval = null; }
        _usingDesktopBridge = false;
        if (_detectInterval) { clearInterval(_detectInterval); _detectInterval = null; }
        if (_yinWorker) { _yinWorker.terminate(); _yinWorker = null; }
        _processingFrame = false;
        _pendingBuffer = null;
        _accumBuffer = new Float32Array(0);
        _freqHistory = [];
        _validFrameCount = 0;
        _lastFreq = 0;
        if (_processor) { _processor.disconnect(); _processor = null; }
        if (_gainNode) { _gainNode.disconnect(); _gainNode = null; }
        if (_sourceNode) { _sourceNode.disconnect(); _sourceNode = null; }
        if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
        if (_audioCtx) { _audioCtx.close(); _audioCtx = null; }
    }

    window._noteTrainerAudio = {
        start: async function(options, onResult) {
            _onResult = onResult;
            await _doStart(options.deviceId, options.channel, options.audioInputMode || 'auto');
        },
        stop: function() {
            _onResult = null;
            _doStop();
        },
        restart: async function(options) {
            _doStop();
            await _doStart(options.deviceId, options.channel, options.audioInputMode || 'auto');
        },
        get usingBridge() { return _usingDesktopBridge; },
    };
})();
