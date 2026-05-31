// ============================================================================
// Butterfly IFFT Pass — Radix-2 DIT with Inline Twiddle + Bit-Reversal
// ============================================================================
// Complete rewrite. No precomputed butterfly texture needed.
// Processes two packed complex signals in (xy) and (zw) channels.
//
// For IFFT: uses positive exponent twiddle W = e^{+2πi·k/groupSize}
// Unnormalized output (no 1/N division) for correct ocean wave heights.
// ============================================================================

uniform sampler2D uInput;
uniform float uStage;
uniform float uResolution;
uniform int   uDirection;   // 0=horizontal, 1=vertical
uniform int   uApplySign;   // 1 on very last stage only

#define TAU 6.28318530717959

// Bit-reversal for DIT stage 0 input reordering
float bitReverse(float idx, float numBits) {
    float result = 0.0;
    float val = idx;
    for (float i = 0.0; i < 12.0; i++) {
        if (i >= numBits) break;
        result = result * 2.0 + mod(val, 2.0);
        val = floor(val / 2.0);
    }
    return result;
}

void main() {
    vec2 fc = gl_FragCoord.xy;
    float N = uResolution;
    float numBits = log2(N);

    // Index in the transform dimension
    float idx = (uDirection == 0) ? fc.x : fc.y;

    // Butterfly geometry for this stage
    float halfGroup = pow(2.0, uStage);
    float groupSize = halfGroup * 2.0;
    float posInGroup = mod(idx, groupSize);
    bool isTop = (posInGroup < halfGroup);

    // Two indices this butterfly connects
    float topIdx = isTop ? idx : (idx - halfGroup);
    float botIdx = isTop ? (idx + halfGroup) : idx;

    // Stage 0: apply bit-reversal to read from scrambled input
    float readTop = (uStage < 0.5) ? bitReverse(topIdx, numBits) : topIdx;
    float readBot = (uStage < 0.5) ? bitReverse(botIdx, numBits) : botIdx;

    // Sample the two inputs
    vec2 uvTop, uvBot;
    if (uDirection == 0) {
        uvTop = vec2((readTop + 0.5) / N, (fc.y + 0.5) / N);
        uvBot = vec2((readBot + 0.5) / N, (fc.y + 0.5) / N);
    } else {
        uvTop = vec2((fc.x + 0.5) / N, (readTop + 0.5) / N);
        uvBot = vec2((fc.x + 0.5) / N, (readBot + 0.5) / N);
    }

    vec4 topVal = texture2D(uInput, uvTop);
    vec4 botVal = texture2D(uInput, uvBot);

    // Twiddle: W = e^{+2πi·k/groupSize}  (positive exponent for IFFT)
    float k = isTop ? posInGroup : (posInGroup - halfGroup);
    float angle = TAU * k / groupSize;
    float twRe = cos(angle);
    float twIm = sin(angle);

    // Complex multiply W × botVal for two packed complex signals
    vec4 wBot;
    wBot.x = twRe * botVal.x - twIm * botVal.y;
    wBot.y = twRe * botVal.y + twIm * botVal.x;
    wBot.z = twRe * botVal.z - twIm * botVal.w;
    wBot.w = twRe * botVal.w + twIm * botVal.z;

    // Butterfly: top = E + W·O,  bottom = E - W·O
    vec4 result = isTop ? (topVal + wBot) : (topVal - wBot);

    // Last stage of vertical IFFT: sign correction for centred spectrum
    if (uApplySign == 1) {
        float sign = (mod(fc.x + fc.y, 2.0) < 0.5) ? 1.0 : -1.0;
        result *= sign;
    }

    gl_FragColor = result;
}
