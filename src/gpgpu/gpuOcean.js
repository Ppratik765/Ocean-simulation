// ============================================================================
// GPUOcean — Minimal GPGPU FFT Ocean Pipeline
// ============================================================================
// Single-cascade 256×256 FFT ocean.
//
// Pipeline per frame:
//   2 spectrum evolution passes  (Dy+Dx, Dz)
//   2 × 16 butterfly IFFT passes (horizontal + vertical per texture)
//   1 copy pass                  (save first IFFT before second)
//   1 assembly pass              (merge Dy, Dx, Dz into displacement)
//   1 normal + Jacobian pass     (finite-difference)
// ────────────────────────────────────────────────────────────────────
//   Total: 37 render-target switches on 256×256 targets.
// ============================================================================

import * as THREE from 'three';

import phillipsCode from '../shaders/compute/phillipsSpectrum.glsl?raw';
import spectrumCode from '../shaders/compute/spectrum.glsl?raw';
import butterflyCode from '../shaders/compute/butterfly.glsl?raw';
import normalJacobianCode from '../shaders/compute/normalJacobian.glsl?raw';

const RESOLUTION = 256;
const NUM_STAGES = 8;          // log2(256)

/* Shared fullscreen-quad vertex shader */
const VERT = /* glsl */ `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export class GPUOcean {

    /**
     * @param {THREE.WebGLRenderer} renderer
     */
    constructor(renderer) {
        this.renderer  = renderer;
        this.N         = RESOLUTION;
        this.patchSize = 1000;

        /* ── Scene for fullscreen quad passes ─────────────────────────── */
        this._scene  = new THREE.Scene();
        this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._quad   = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
        this._scene.add(this._quad);

        /* ── Init-time Phillips spectrum ──────────────────────────────── */
        this._h0kRT = this._initPhillips();

        /* ── Runtime render targets ───────────────────────────────────── */
        this._specART         = this._rt();          // spectrum A output
        this._specBRT         = this._rt();          // spectrum B output
        this._pingRT          = this._rt();          // IFFT ping
        this._pongRT          = this._rt();          // IFFT pong
        this._displacementRT  = this._rt(THREE.LinearFilter);
        this._normalJacobianRT = this._rt(THREE.LinearFilter);

        /* ── Materials (reused every frame) ───────────────────────────── */
        this._specMat      = this._makeSpectrumMaterial();
        this._butterflyMat = this._makeButterflyMaterial();
        this._copyMat      = this._makeCopyMaterial();
        this._assembleMat  = this._makeAssembleMaterial();
        this._normalMat    = this._makeNormalMaterial();
    }

    /* ── Public API ───────────────────────────────────────────────────── */

    get primaryPatchSize() { return this.patchSize; }

    getDisplacementTexture()    { return this._displacementRT.texture; }
    getNormalJacobianTexture()  { return this._normalJacobianRT.texture; }

    /** Runs the entire compute pipeline for one frame. */
    update(time) {
        const prevRT = this.renderer.getRenderTarget();

        /* 1 ─ Spectrum time-evolution  (2 passes) */
        const sm = this._specMat;
        sm.uniforms.uTime.value = time;

        sm.uniforms.uOutputMode.value = 0;          // Dy+Dx
        this._pass(sm, this._specART);

        sm.uniforms.uOutputMode.value = 1;          // Dz
        this._pass(sm, this._specBRT);

        /* 2 ─ IFFT texture A  (16 passes) */
        const resA = this._ifft(this._specART);

        /* 3 ─ Save A's result  (1 copy pass) */
        this._copyMat.uniforms.uSource.value = resA.texture;
        this._pass(this._copyMat, this._specART);   // reuse specART as storage

        /* 4 ─ IFFT texture B  (16 passes) */
        const resB = this._ifft(this._specBRT);

        /* 5 ─ Assemble displacement  (1 pass) */
        this._assembleMat.uniforms.uTexA.value = this._specART.texture;  // saved A
        this._assembleMat.uniforms.uTexB.value = resB.texture;
        this._pass(this._assembleMat, this._displacementRT);

        /* 6 ─ Normal + Jacobian  (1 pass) */
        this._normalMat.uniforms.uDisplacementMap.value = this._displacementRT.texture;
        this._pass(this._normalMat, this._normalJacobianRT);

        this.renderer.setRenderTarget(prevRT);
    }

    /* ── Internal helpers ─────────────────────────────────────────────── */

    _rt(filter = THREE.NearestFilter) {
        return new THREE.WebGLRenderTarget(this.N, this.N, {
            type:      THREE.FloatType,
            format:    THREE.RGBAFormat,
            minFilter: filter,
            magFilter: filter,
            wrapS:     THREE.RepeatWrapping,
            wrapT:     THREE.RepeatWrapping,
            depthBuffer: false,
        });
    }

    _pass(material, target) {
        this._quad.material = material;
        this.renderer.setRenderTarget(target);
        this.renderer.render(this._scene, this._camera);
    }

    /* ── IFFT (8 horizontal + 8 vertical = 16 butterfly passes) ───── */

    _ifft(inputRT) {
        const bm = this._butterflyMat;
        let readRT = inputRT;

        /* Horizontal */
        for (let s = 0; s < NUM_STAGES; s++) {
            bm.uniforms.uInput.value     = readRT.texture;
            bm.uniforms.uStage.value     = s;
            bm.uniforms.uDirection.value = 0;
            bm.uniforms.uApplySign.value = 0;

            const writeRT = (readRT === this._pongRT) ? this._pingRT : this._pongRT;
            this._pass(bm, writeRT);
            readRT = writeRT;
        }

        /* Vertical */
        for (let s = 0; s < NUM_STAGES; s++) {
            bm.uniforms.uInput.value     = readRT.texture;
            bm.uniforms.uStage.value     = s;
            bm.uniforms.uDirection.value = 1;
            bm.uniforms.uApplySign.value = (s === NUM_STAGES - 1) ? 1 : 0;

            const writeRT = (readRT === this._pongRT) ? this._pingRT : this._pongRT;
            this._pass(bm, writeRT);
            readRT = writeRT;
        }

        return readRT;
    }

    /* ── One-shot Phillips spectrum generation ────────────────────────── */

    _initPhillips() {
        const mat = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: phillipsCode,
            uniforms: {
                uResolution:    { value: this.N },
                uPatchSize:     { value: this.patchSize },
                uWindSpeed:     { value: 20.0 },
                uWindDirection: { value: new THREE.Vector2(0.85, 0.53).normalize() },
                uAmplitude:     { value: 0.0004 },
                uSeed:          { value: 0.0 },
            },
        });
        const rt = this._rt();
        this._pass(mat, rt);
        mat.dispose();
        return rt;
    }

    /* ── Material factories ───────────────────────────────────────────── */

    _makeSpectrumMaterial() {
        return new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: spectrumCode,
            uniforms: {
                uH0k:         { value: this._h0kRT.texture },
                uResolution:  { value: this.N },
                uPatchSize:   { value: this.patchSize },
                uTime:        { value: 0 },
                uChoppiness:  { value: 1.8 },
                uOutputMode:  { value: 0 },
            },
        });
    }

    _makeButterflyMaterial() {
        return new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: butterflyCode,
            uniforms: {
                uInput:      { value: null },
                uStage:      { value: 0 },
                uResolution: { value: this.N },
                uDirection:  { value: 0 },
                uApplySign:  { value: 0 },
            },
        });
    }

    _makeCopyMaterial() {
        return new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: /* glsl */ `
                uniform sampler2D uSource;
                varying vec2 vUv;
                void main() { gl_FragColor = texture2D(uSource, vUv); }
            `,
            uniforms: { uSource: { value: null } },
        });
    }

    _makeAssembleMaterial() {
        return new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: /* glsl */ `
                uniform sampler2D uTexA;
                uniform sampler2D uTexB;
                varying vec2 vUv;
                void main() {
                    vec4 a = texture2D(uTexA, vUv);
                    vec4 b = texture2D(uTexB, vUv);
                    // a = IFFT of (Dy_re,Dy_im, Dx_re,Dx_im) → real parts in .x and .z
                    // b = IFFT of (Dz_re,Dz_im,    0,    0 ) → real part  in .x
                    gl_FragColor = vec4(a.x, a.z, b.x, 0.0);
                }
            `,
            uniforms: {
                uTexA: { value: null },
                uTexB: { value: null },
            },
        });
    }

    _makeNormalMaterial() {
        return new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: normalJacobianCode,
            uniforms: {
                uDisplacementMap: { value: null },
                uResolution:      { value: this.N },
                uPatchSize:       { value: this.patchSize },
            },
        });
    }

    /* ── Cleanup ──────────────────────────────────────────────────────── */

    dispose() {
        [this._h0kRT, this._specART, this._specBRT, this._pingRT,
         this._pongRT, this._displacementRT, this._normalJacobianRT]
            .forEach(rt => rt.dispose());
        [this._specMat, this._butterflyMat, this._copyMat,
         this._assembleMat, this._normalMat]
            .forEach(m => m.dispose());
        this._quad.geometry.dispose();
    }
}
