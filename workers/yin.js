/**
 * YIN pitch detection worker.
 *
 * Receives { samples: Float32Array, sampleRate: number }, posts back
 * { freq, confidence, rms }. The samples ArrayBuffer should be passed
 * as transferable so no copy occurs across the worker boundary.
 *
 * Bundled copy of the tuner plugin's worker so Note Trainer stays
 * self-contained (no cross-plugin dependency). Kept byte-for-byte
 * compatible: same input/output contract, same Node-test guards.
 */
// Guard allows the file to be required in Node.js test environments where
// `self` is not defined; the worker message handler only runs in the browser.
if (typeof self !== 'undefined') {
    self.onmessage = (e) => {
        const { samples, sampleRate } = e.data;
        self.postMessage(_yinDetect(samples, sampleRate));
    };
}

function _yinDetect(buffer, sampleRate) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    let rms = 0;
    for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / buffer.length);
    if (rms < 0.01) return { freq: 0, confidence: 0, rms };

    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] = runningSum > 0 ? yinBuffer[tau] * tau / runningSum : 1;
    }

    // Canonical YIN absolute-threshold step: walk tau upward and take the FIRST
    // local minimum that drops below the threshold — NOT the globally deepest
    // dip. The fundamental period is the smallest tau that satisfies the
    // difference function; its sub-octaves (2T, 3T, …) sit at LARGER tau and
    // often dip just as deep or deeper, so picking the deepest dip is what
    // produced octave-low errors. Choosing the first qualifying dip rejects
    // those at the source. We still track the global minimum as a fallback.
    let tau = -1;
    let minVal = 1, minTau = -1;
    for (let t = 2; t < halfLen; t++) {
        if (yinBuffer[t] < minVal) { minVal = yinBuffer[t]; minTau = t; }
        if (yinBuffer[t] < threshold) {
            while (t + 1 < halfLen && yinBuffer[t + 1] < yinBuffer[t]) {
                t++;
                if (yinBuffer[t] < minVal) { minVal = yinBuffer[t]; minTau = t; }
            }
            tau = t;
            break;
        }
    }
    if (tau === -1) {
        if (minTau === -1) return { freq: 0, confidence: 0, rms };
        tau = minTau;
    }

    const s0 = yinBuffer[tau - 1];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const denom = s0 - 2 * s1 + s2;
    let betterTau = denom === 0 ? tau : tau + (s0 - s2) / (2 * denom);
    // A near-zero (but nonzero) denom can fling the parabolic estimate far
    // outside the bracket; the true minimum is within ±1 sample of tau. The
    // negated test also rejects NaN.
    if (!(betterTau >= tau - 1 && betterTau <= tau + 1)) betterTau = tau;

    return { freq: sampleRate / betterTau, confidence: 1 - yinBuffer[tau], rms };
}

// Allow direct import in Node.js test environments; harmless in browser workers
// where the `module` global is undefined.
if (typeof module !== 'undefined') module.exports = { _yinDetect };
