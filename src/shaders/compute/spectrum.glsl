// ============================================================================
// Time-Evolution Spectrum — h̃(k,t) from h̃₀(k)
// ============================================================================
// CRITICAL FIX: corrected complex conjugate multiplication signs.
//
// Mode 0: vec4(Dy_re, Dy_im, Dx_re, Dx_im) — height + X choppiness packed
// Mode 1: vec4(Dz_re, Dz_im,    0,     0 ) — Z choppiness packed
// ============================================================================

uniform sampler2D uH0k;
uniform float uResolution;
uniform float uPatchSize;
uniform float uTime;
uniform float uChoppiness;
uniform int   uOutputMode;

#define PI  3.14159265358979
#define TAU 6.28318530717959

void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    float N = uResolution;

    vec2 k = vec2(
        TAU * (fragCoord.x - N * 0.5) / uPatchSize,
        TAU * (fragCoord.y - N * 0.5) / uPatchSize
    );

    float kLen = length(k);
    float w = sqrt(9.81 * max(kLen, 1e-6));

    vec4 h0 = texture2D(uH0k, fragCoord / N);
    float h0kRe  = h0.x;
    float h0kIm  = h0.y;
    float h0mkRe = h0.z;
    float h0mkIm = h0.w;

    float cosWt = cos(w * uTime);
    float sinWt = sin(w * uTime);

    // ─── CORRECTED TIME EVOLUTION ────────────────────────────────────
    // h̃(k,t) = h̃₀(k)·e^{iωt} + conj(h̃₀(-k))·e^{-iωt}
    //
    // Term 1: (h0kRe + i·h0kIm)(cos + i·sin)
    //   re: h0kRe·cos - h0kIm·sin
    //   im: h0kRe·sin + h0kIm·cos
    //
    // Term 2: (h0mkRe - i·h0mkIm)(cos - i·sin)
    //   re: h0mkRe·cos - h0mkIm·sin     ← was +h0mkIm·sin (BUG)
    //   im: -h0mkRe·sin - h0mkIm·cos    ← was +h0mkIm·cos (BUG)
    // ─────────────────────────────────────────────────────────────────
    float hRe = h0kRe * cosWt - h0kIm * sinWt
              + h0mkRe * cosWt - h0mkIm * sinWt;
    float hIm = h0kRe * sinWt + h0kIm * cosWt
              - h0mkRe * sinWt - h0mkIm * cosWt;

    if (uOutputMode == 0) {
        // Dy = h̃(k,t) directly
        float dyRe = hRe;
        float dyIm = hIm;

        // Dx = -i · (kx/|k|) · h̃ · λ
        // -i·(a+bi) = b - ai → (Im, -Re)
        float kxOverK = (kLen > 1e-6) ? k.x / kLen : 0.0;
        float dxRe =  hIm * kxOverK * uChoppiness;
        float dxIm = -hRe * kxOverK * uChoppiness;

        gl_FragColor = vec4(dyRe, dyIm, dxRe, dxIm);
    }
    else {
        // Dz = -i · (kz/|k|) · h̃ · λ
        float kzOverK = (kLen > 1e-6) ? k.y / kLen : 0.0;
        float dzRe =  hIm * kzOverK * uChoppiness;
        float dzIm = -hRe * kzOverK * uChoppiness;

        gl_FragColor = vec4(dzRe, dzIm, 0.0, 0.0);
    }
}
