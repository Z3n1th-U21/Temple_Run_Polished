/* ==========================================================================
   NEON RUINS — a lightweight Temple Run–style endless runner (Three.js r128)

   Sections
     1.  Config & utilities
     2.  Persistent storage
     3.  Audio (Web Audio SFX + procedural synthwave music)
     4.  Renderer, scene, lights & sky
     5.  Procedural textures & shared materials
     6.  Track segments (recycled ring of causeway blocks)
     7.  Obstacles & coins (pooled)
     8.  Level generator (procedural patterns + difficulty)
     9.  Player (model, physics, animation)
     10. Particles (single GPU point cloud)
     11. Input (keyboard + swipe / drag)
     12. Camera rig
     13. UI layer (DOM)
     14. Game state, main loop, adaptive quality
   ========================================================================== */
(function () {
  'use strict';

  // Bail out gracefully if Three.js failed to load (offline, blocked CDN…)
  if (typeof THREE === 'undefined') {
    document.getElementById('load-error').classList.add('visible');
    document.getElementById('screen-start').classList.remove('visible');
    return;
  }

  /* ========================================================================
     1. CONFIG & UTILITIES
     ======================================================================== */
  const CFG = {
    laneW: 2.2,            // distance between lane centres
    trackW: 7.2,           // causeway width
    segLen: 6,             // length of one track segment
    segCount: 24,          // segments alive at once (≈144 units of track)
    despawnZ: 11,          // anything past this z (behind camera) is recycled

    startSpeed: 15,
    maxSpeed: 40,
    speedRamp: 105,        // seconds — time constant of the exponential speed curve
    menuSpeed: 9,

    gravity: 44,
    jumpVel: 14.8,         // → ~2.5 units high, ~0.67 s airtime
    fastFallVel: -26,
    slideTime: 0.72,

    standH: 1.75,          // player hitbox heights
    slideH: 0.85,
    playerHW: 0.34,
    playerHD: 0.3,

    coinValue: 10,
    gapInset: 0.55,        // forgiveness at both edges of a gap
    milestone: 500,
  };

  const LANES = [-1, 0, 1];
  const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (IS_TOUCH) document.body.classList.add('is-touch');

  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  /** Frame-rate independent exponential smoothing. */
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  /** Pick a key from [[key, weight], …]. */
  const weighted = (list) => {
    let total = 0;
    for (const [, w] of list) total += w;
    let r = Math.random() * total;
    for (const [k, w] of list) {
      if ((r -= w) <= 0) return k;
    }
    return list[0][0];
  };
  const vibrate = (ms) => {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* unsupported */ }
  };

  /* ========================================================================
     2. PERSISTENT STORAGE (localStorage, fail-safe)
     ======================================================================== */
  const Store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('neonruins.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem('neonruins.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
  };

  /* ========================================================================
     3. AUDIO — everything is synthesized, no audio files needed
     ======================================================================== */
  const Sound = (() => {
    let ctx = null;
    let master, sfxBus, musicBus, musicFilter, delayIn, noiseBuf;
    let sfxOn = Store.get('sfx', true);
    let musicOn = Store.get('music', true);
    let muffled = false;

    // ---- music sequencer state ----
    const BPM = 112;
    const STEP = 60 / BPM / 4; // 16th note
    // Am – F – C – G, as MIDI triads
    const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    let step = 0;
    let nextTime = 0;
    let timer = null;

    const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

    function init() {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();

      master = ctx.createGain();
      master.gain.value = 0.85;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp);
      comp.connect(ctx.destination);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = sfxOn ? 1 : 0;
      sfxBus.connect(master);

      musicFilter = ctx.createBiquadFilter();
      musicFilter.type = 'lowpass';
      musicFilter.frequency.value = 16000;
      musicBus = ctx.createGain();
      musicBus.gain.value = 0;
      musicBus.connect(musicFilter);
      musicFilter.connect(master);

      // Feedback delay for the arpeggio — cheap "space"
      delayIn = ctx.createDelay(1);
      delayIn.delayTime.value = STEP * 3;
      const fb = ctx.createGain();
      fb.gain.value = 0.32;
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      delayIn.connect(fb);
      fb.connect(delayIn);
      delayIn.connect(wet);
      wet.connect(musicBus);

      // 2 s of white noise, reused by every noise-based sound
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      if (musicOn) startMusic();
    }

    // ---------- primitive voices ----------
    function tone(freq, dur, type = 'sine', vol = 0.2, freqEnd = null, delay = 0, dest = sfxBus) {
      if (!ctx) return;
      const t = ctx.currentTime + delay;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    function noise(dur, vol, freq, ftype = 'lowpass', delay = 0, q = 1, freqEnd = null, dest = sfxBus) {
      if (!ctx) return;
      const t = ctx.currentTime + delay;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = ftype;
      f.frequency.setValueAtTime(freq, t);
      f.Q.value = q;
      if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(dest);
      src.start(t, Math.random() * 0.8);
      src.stop(t + dur + 0.05);
    }

    // ---------- music voices (scheduled at absolute time t) ----------
    function kick(t) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(0.6, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.connect(g);
      g.connect(musicBus);
      o.start(t);
      o.stop(t + 0.35);
    }
    function hat(t, vol) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.connect(f);
      f.connect(g);
      g.connect(musicBus);
      src.start(t, Math.random());
      src.stop(t + 0.06);
    }
    function clap(t) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1600;
      f.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      src.connect(f);
      f.connect(g);
      g.connect(musicBus);
      src.start(t, Math.random());
      src.stop(t + 0.18);
    }
    function bass(freq, t, dur) {
      const o = ctx.createOscillator();
      const f = ctx.createBiquadFilter();
      const g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      f.type = 'lowpass';
      f.Q.value = 6;
      f.frequency.setValueAtTime(1300, t);
      f.frequency.exponentialRampToValueAtTime(220, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.17, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f);
      f.connect(g);
      g.connect(musicBus);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    function arp(freq, t) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g);
      g.connect(musicBus);
      g.connect(delayIn);
      o.start(t);
      o.stop(t + 0.16);
    }
    function pad(chord, t, dur) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.028, t + 0.5);
      g.gain.linearRampToValueAtTime(0.02, t + dur - 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      f.connect(g);
      g.connect(musicBus);
      for (const n of chord) {
        for (const det of [-8, 8]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = midi(n);
          o.detune.value = det;
          o.connect(f);
          o.start(t);
          o.stop(t + dur + 0.05);
        }
      }
    }

    function scheduleStep(s, t) {
      const i = s % 16;
      const chord = CHORDS[Math.floor(s / 16) % CHORDS.length];
      if (i % 4 === 0) kick(t);
      if (i === 4 || i === 12) clap(t);
      if (i % 2 === 1) hat(t, i % 4 === 3 ? 0.06 : 0.035);
      if (i % 2 === 0) bass(midi(chord[0] - 24 + (i % 4 === 2 ? 12 : 0)), t, STEP * 1.8);
      const arpSeq = [chord[0], chord[1], chord[2], chord[1] + 12, chord[2], chord[0] + 12, chord[1], chord[2] + 12];
      arp(midi(arpSeq[i % 8] + 12), t);
      if (i === 0) pad(chord, t, STEP * 16);
    }

    function scheduler() {
      if (!ctx) return;
      // After a suspended tab the clock jumps; don't burst-schedule missed notes
      if (nextTime < ctx.currentTime - 0.2) nextTime = ctx.currentTime + 0.05;
      while (nextTime < ctx.currentTime + 0.12) {
        scheduleStep(step, nextTime);
        nextTime += STEP;
        step++;
      }
    }

    function startMusic() {
      if (!ctx || timer) return;
      nextTime = ctx.currentTime + 0.08;
      step = 0;
      timer = setInterval(scheduler, 30);
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.setTargetAtTime(0.5, ctx.currentTime, 0.4);
    }
    function stopMusic() {
      if (!ctx) return;
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      clearInterval(timer);
      timer = null;
    }

    return {
      init,
      get sfxOn() { return sfxOn; },
      get musicOn() { return musicOn; },
      toggleSfx() {
        sfxOn = !sfxOn;
        Store.set('sfx', sfxOn);
        if (ctx) sfxBus.gain.setTargetAtTime(sfxOn ? 1 : 0, ctx.currentTime, 0.02);
        return sfxOn;
      },
      toggleMusic() {
        musicOn = !musicOn;
        Store.set('music', musicOn);
        if (musicOn) startMusic();
        else stopMusic();
        return musicOn;
      },
      /** Muffle music while paused (lowpass sweep). */
      setMuffled(on) {
        muffled = on;
        if (!ctx) return;
        musicFilter.frequency.setTargetAtTime(on ? 600 : 16000, ctx.currentTime, 0.15);
      },
      suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
      resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); },

      // ---------- game sound effects ----------
      jump() {
        tone(340, 0.2, 'square', 0.06, 760);
        tone(520, 0.18, 'triangle', 0.08, 1150);
      },
      land() { noise(0.09, 0.12, 700); },
      slide() { noise(0.34, 0.18, 2800, 'bandpass', 0, 1.2, 500); },
      whoosh() { noise(0.14, 0.07, 3200, 'bandpass', 0, 0.9, 1400); },
      coin(combo) {
        const base = 988 * Math.pow(2, Math.min(combo, 12) / 24);
        tone(base, 0.08, 'square', 0.05);
        tone(base * 1.5, 0.16, 'square', 0.05, null, 0.055);
      },
      crash() {
        noise(0.7, 0.55, 2200, 'lowpass', 0, 1, 90);
        tone(170, 0.5, 'sawtooth', 0.22, 35);
        tone(70, 0.6, 'sine', 0.45, 28);
      },
      stumble() {
        tone(220, 0.16, 'square', 0.08, 90);
        noise(0.16, 0.22, 900);
      },
      fall() { tone(620, 1.1, 'triangle', 0.14, 70); },
      rumble() { noise(0.9, 0.28, 220, 'lowpass', 0, 2, 80); },
      click() { tone(700, 0.06, 'triangle', 0.08); },
      beep(high) { tone(high ? 1320 : 660, high ? 0.3 : 0.14, 'square', 0.06); },
      milestone() {
        [0, 0.08, 0.16].forEach((d, i) => tone([784, 988, 1319][i], 0.2, 'triangle', 0.09, null, d));
      },
      newBest() {
        [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.28, 'square', 0.06, null, i * 0.1));
      },
      gameOver() {
        [392, 330, 262].forEach((f, i) => tone(f, 0.3, 'triangle', 0.1, null, i * 0.14));
      },
    };
  })();

  /* ========================================================================
     4. RENDERER, SCENE, LIGHTS & SKY
     ======================================================================== */
  const canvas = document.getElementById('game');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_TOUCH, powerPreference: 'high-performance' });
  } catch (e) {
    document.getElementById('load-error-msg').textContent = 'WebGL is not available on this device or browser.';
    document.getElementById('load-error').classList.add('visible');
    document.getElementById('screen-start').classList.remove('visible');
    return;
  }

  let pixelRatio = Math.min(window.devicePixelRatio || 1, IS_TOUCH ? 1.75 : 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const MAX_ANISO = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  const FOG_COLOR = new THREE.Color(0x35145a);
  const scene = new THREE.Scene();
  scene.background = FOG_COLOR.clone();
  scene.fog = new THREE.Fog(FOG_COLOR, 38, 138);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
  camera.position.set(0, 4, 8);

  // --- Lights: soft hemisphere + one shadow-casting key light following the player ---
  const hemi = new THREE.HemisphereLight(0xa596ff, 0x2a1036, 0.9);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffc6ec, 0.95);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
  const sc = keyLight.shadow.camera;
  sc.left = -11; sc.right = 11; sc.top = 11; sc.bottom = -11; sc.near = 1; sc.far = 50;
  keyLight.shadow.bias = -0.0008;
  scene.add(keyLight, keyLight.target);

  const fillLight = new THREE.DirectionalLight(0x22e4ff, 0.35);
  fillLight.position.set(-8, 5, -6);
  scene.add(fillLight);

  // --- Sky: gradient dome, synthwave sun, pyramid silhouettes, stars ---
  const skyGroup = new THREE.Group();
  scene.add(skyGroup);

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x05031a) },
      horizon: { value: new THREE.Color(0x5a1c72) },
      bottom: { value: new THREE.Color(0x0a0418) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = h > 0.0
          ? mix(horizon, top, pow(clamp(h * 2.4, 0.0, 1.0), 0.55))
          : mix(horizon, bottom, pow(clamp(-h * 5.0, 0.0, 1.0), 0.5));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(450, 24, 16), skyMat);
  skyDome.renderOrder = -10;
  skyGroup.add(skyDome);

  // Striped retro sun, clipped at the horizon (world y < 0)
  const sunMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying float vY;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv; varying float vY;
      void main() {
        if (vY < -1.0) discard;
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        float y = vUv.y;
        vec3 col = mix(vec3(1.0, 0.16, 0.55), vec3(1.0, 0.86, 0.36), smoothstep(0.15, 0.95, y));
        float disc = smoothstep(1.0, 0.985, r);
        float band = 1.0;
        if (y < 0.55) {
          float f = fract(y * 16.0 - uTime * 0.25);
          band = step((0.55 - y) * 1.3, f);
        }
        gl_FragColor = vec4(col, disc * band);
      }`,
  });
  const sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), sunMat);
  sunMesh.position.set(0, 36, -410);
  skyGroup.add(sunMesh);

  // Additive glow behind the sun
  const glowMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - r), 2.2) * 0.55;
        gl_FragColor = vec4(1.0, 0.3, 0.65, a);
      }`,
  });
  const sunGlow = new THREE.Mesh(new THREE.PlaneGeometry(380, 380), glowMat);
  sunGlow.position.set(0, 30, -415);
  skyGroup.add(sunGlow);

  // Pyramid silhouettes with neon edges
  const pyrFill = new THREE.MeshBasicMaterial({ color: 0x12082a, fog: false });
  const pyrEdge = new THREE.LineBasicMaterial({ color: 0xff3fd0, transparent: true, opacity: 0.4, fog: false });
  [
    { x: -150, z: -360, r: 72, h: 82 },
    { x: -70, z: -335, r: 44, h: 52 },
    { x: 34, z: -385, r: 36, h: 40 },
    { x: 105, z: -350, r: 80, h: 96 },
    { x: 190, z: -380, r: 56, h: 62 },
  ].forEach((p) => {
    const geo = new THREE.ConeGeometry(p.r, p.h, 4, 1);
    geo.rotateY(Math.PI / 4);
    const m = new THREE.Mesh(geo, pyrFill);
    m.position.set(p.x, p.h / 2 - 3, p.z);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), pyrEdge);
    e.position.copy(m.position);
    skyGroup.add(m, e);
  });

  // Stars
  {
    const n = 500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const y = rand(0.08, 1);
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(theta) * r * 400;
      pos[i * 3 + 1] = y * 400;
      pos[i * 3 + 2] = Math.sin(theta) * r * 400;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8,
    }));
    skyGroup.add(stars);
  }

  /* ========================================================================
     5. PROCEDURAL TEXTURES & SHARED MATERIALS
     ======================================================================== */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')];
  }

  /** Stone-tile floor (colour map) + neon edge lines (emissive map). */
  function makeFloorTextures() {
    const W = 256, H = 256;
    const [c, g] = makeCanvas(W, H);
    g.fillStyle = '#1c1638';
    g.fillRect(0, 0, W, H);
    const cols = 6, rows = 4;
    const tw = W / cols, th = H / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * tw * 0.5;
      for (let i = -1; i <= cols; i++) {
        const x = i * tw + off;
        const l = 21 + Math.random() * 9;
        g.fillStyle = `hsl(${248 + Math.random() * 16}, 26%, ${l}%)`;
        g.fillRect(x + 2, r * th + 2, tw - 4, th - 4);
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(x + 2, r * th + 2, tw - 4, 3);
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.fillRect(x + 2, r * th + th - 5, tw - 4, 3);
      }
    }
    // grit
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.04)';
      g.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
    }
    // cracks
    g.strokeStyle = 'rgba(8,4,20,0.55)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) {
      let x = Math.random() * W, y = Math.random() * H;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += rand(-14, 14);
        y += rand(-14, 14);
        g.lineTo(x, y);
      }
      g.stroke();
    }
    // lane grooves + dark rim
    const laneU = (CFG.laneW / 2) / CFG.trackW;
    g.fillStyle = 'rgba(6,3,18,0.6)';
    [0.5 - laneU, 0.5 + laneU].forEach((u) => g.fillRect(u * W - 1.5, 0, 3, H));
    g.fillRect(0, 0, 10, H);
    g.fillRect(W - 10, 0, 10, H);

    // Emissive map: neon rails at both edges, soft violet lane lines, studs
    const [e, ge] = makeCanvas(W, H);
    ge.fillStyle = '#000';
    ge.fillRect(0, 0, W, H);
    const rail = (x0, dir) => {
      const grd = ge.createLinearGradient(x0, 0, x0 + dir * 18, 0);
      grd.addColorStop(0, 'rgba(34,228,255,0.55)');
      grd.addColorStop(1, 'rgba(34,228,255,0)');
      ge.fillStyle = grd;
      ge.fillRect(Math.min(x0, x0 + dir * 18), 0, 18, H);
      ge.fillStyle = '#22e4ff';
      ge.fillRect(dir > 0 ? x0 + 3 : x0 - 7, 0, 4, H);
    };
    rail(0, 1);
    rail(W, -1);
    ge.fillStyle = 'rgba(139,92,255,0.35)';
    [0.5 - laneU, 0.5 + laneU].forEach((u) => ge.fillRect(u * W - 1, 0, 2, H));
    ge.fillStyle = '#ff3fd0';
    for (let k = 0; k < 2; k++) {
      const y = H * (0.25 + k * 0.5);
      ge.beginPath(); ge.arc(16, y, 3, 0, Math.PI * 2); ge.fill();
      ge.beginPath(); ge.arc(W - 16, y, 3, 0, Math.PI * 2); ge.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    const etex = new THREE.CanvasTexture(e);
    tex.anisotropy = etex.anisotropy = MAX_ANISO;
    return { tex, etex };
  }

  /** Causeway side wall: dark masonry with a glowing magenta band at the top. */
  function makeSideTextures() {
    const W = 128, H = 256;
    const [c, g] = makeCanvas(W, H);
    g.fillStyle = '#140f2a';
    g.fillRect(0, 0, W, H);
    const bh = 20;
    for (let r = 0; r * bh < H; r++) {
      const off = (r % 2) * 20;
      for (let x = -40; x < W; x += 40) {
        g.fillStyle = `hsl(255, 22%, ${11 + Math.random() * 7}%)`;
        g.fillRect(x + off + 1.5, r * bh + 1.5, 37, bh - 3);
      }
    }
    // fade to black towards the bottom (abyss)
    const fade = g.createLinearGradient(0, H * 0.2, 0, H);
    fade.addColorStop(0, 'rgba(5,2,14,0)');
    fade.addColorStop(1, 'rgba(5,2,14,0.95)');
    g.fillStyle = fade;
    g.fillRect(0, 0, W, H);

    const [e, ge] = makeCanvas(W, H);
    ge.fillStyle = '#000';
    ge.fillRect(0, 0, W, H);
    ge.fillStyle = '#ff3fd0';
    ge.fillRect(0, 4, W, 3);
    const grd = ge.createLinearGradient(0, 7, 0, 30);
    grd.addColorStop(0, 'rgba(255,63,208,0.35)');
    grd.addColorStop(1, 'rgba(255,63,208,0)');
    ge.fillStyle = grd;
    ge.fillRect(0, 7, W, 23);

    return { tex: new THREE.CanvasTexture(c), etex: new THREE.CanvasTexture(e) };
  }

  /** Soft radial sprite (used for glows / blob shadow / pit glow). */
  function makeRadialTexture(inner, outer) {
    const [c, g] = makeCanvas(128, 128);
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, inner);
    grd.addColorStop(1, outer);
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  const floorTex = makeFloorTextures();
  const sideTex = makeSideTextures();
  const glowTex = makeRadialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
  const shadowTex = makeRadialTexture('rgba(0,0,0,0.75)', 'rgba(0,0,0,0)');

  const MAT = {
    floorTop: new THREE.MeshLambertMaterial({ map: floorTex.tex, emissive: 0xffffff, emissiveMap: floorTex.etex }),
    floorSide: new THREE.MeshLambertMaterial({ map: sideTex.tex, emissive: 0xffffff, emissiveMap: sideTex.etex }),
    stone: new THREE.MeshLambertMaterial({ color: 0x40367a }),
    stoneDark: new THREE.MeshLambertMaterial({ color: 0x271f4d }),
    ruin: new THREE.MeshLambertMaterial({ color: 0x1f1840 }),
    pillar: new THREE.MeshLambertMaterial({ color: 0x2c2458 }),
    wood: new THREE.MeshLambertMaterial({ color: 0x5c3947 }),
    boulder: new THREE.MeshLambertMaterial({ color: 0x51457e, emissive: 0x1c0a24, flatShading: true }),
    cyan: new THREE.MeshBasicMaterial({ color: 0x22e4ff }),
    magenta: new THREE.MeshBasicMaterial({ color: 0xff3fd0 }),
    orange: new THREE.MeshBasicMaterial({ color: 0xffa53a }),
    coin: new THREE.MeshPhongMaterial({ color: 0xf0a81c, emissive: 0x5a3000, specular: 0xffffff, shininess: 80 }),
    coinRim: new THREE.MeshBasicMaterial({ color: 0xffe27a }),
    orbGlow: new THREE.SpriteMaterial({ map: glowTex, color: 0xff3fd0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }),
    pitGlow: new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff2fa8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 }),
  };

  /* ========================================================================
     6. TRACK SEGMENTS
     The player stays near z = 0; the world moves towards +z. Segments that
     pass behind the camera are recycled to the far end and re-populated.
     ======================================================================== */
  const SEG_GEO = new THREE.BoxGeometry(CFG.trackW, 8, CFG.segLen);
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const SEG_MATS = [MAT.floorSide, MAT.floorSide, MAT.floorTop, MAT.floorSide, MAT.floorSide, MAT.floorSide];
  const PILLAR_GEO = new THREE.BoxGeometry(1.1, 18, 1.1);
  const CAP_GEO = new THREE.BoxGeometry(1.5, 0.4, 1.5);
  const RING_GEO = new THREE.BoxGeometry(1.16, 0.14, 1.16);
  const ORB_GEO = new THREE.SphereGeometry(0.3, 12, 10);
  const RUIN_GEO = new THREE.BoxGeometry(1, 1, 1);
  const PIT_GEO = new THREE.PlaneGeometry(CFG.trackW * 1.6, CFG.segLen * 1.6);

  class Segment {
    constructor() {
      this.group = new THREE.Group();
      this.z = 0;
      this.gap = false;

      this.floor = new THREE.Mesh(SEG_GEO, SEG_MATS);
      this.floor.position.y = -4;
      this.floor.receiveShadow = true;
      this.group.add(this.floor);

      // Decorative pillars rising out of the abyss on both sides
      this.pillars = new THREE.Group();
      for (const side of [-1, 1]) {
        const x = side * (CFG.trackW / 2 + 2.3);
        const p = new THREE.Mesh(PILLAR_GEO, MAT.pillar);
        p.position.set(x, -5, 0);
        const cap = new THREE.Mesh(CAP_GEO, MAT.stoneDark);
        cap.position.set(x, 4.2, 0);
        const ring = new THREE.Mesh(RING_GEO, MAT.cyan);
        ring.position.set(x, 2.8, 0);
        const orb = new THREE.Mesh(ORB_GEO, MAT.magenta);
        orb.position.set(x, 4.75, 0);
        const glow = new THREE.Sprite(MAT.orbGlow);
        glow.position.copy(orb.position);
        glow.scale.set(2.6, 2.6, 1);
        this.pillars.add(p, cap, ring, orb, glow);
      }
      this.group.add(this.pillars);

      // Distant ruin blocks for parallax & depth
      this.ruin = new THREE.Mesh(RUIN_GEO, MAT.ruin);
      this.group.add(this.ruin);

      // Glow deep in a gap so pits read clearly from afar
      this.pit = new THREE.Mesh(PIT_GEO, MAT.pitGlow);
      this.pit.rotation.x = -Math.PI / 2;
      this.pit.position.y = -3.2;
      this.pit.visible = false;
      this.group.add(this.pit);

      scene.add(this.group);
    }
    setZ(z) {
      this.z = z;
      this.group.position.z = z;
    }
    setGap(v) {
      this.gap = v;
      this.floor.visible = !v;
      this.pit.visible = v;
    }
    decorate(index) {
      this.pillars.visible = index % 3 === 0;
      this.ruin.visible = Math.random() < 0.55;
      if (this.ruin.visible) {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.ruin.scale.set(rand(3, 9), rand(5, 16), rand(3, 9));
        this.ruin.position.set(side * rand(13, 34), rand(-12, -3), rand(-2, 2));
        this.ruin.rotation.y = rand(0, Math.PI);
      }
    }
  }

  const segments = [];
  let tailZ = 0;       // z of the furthest segment centre
  let segCounter = 0;
  for (let i = 0; i < CFG.segCount; i++) {
    const s = new Segment();
    s.setZ(6 - i * CFG.segLen);
    s.decorate(segCounter++);
    segments.push(s);
    tailZ = s.z;
  }

  /** True when world-z `z` is above a hole in the causeway. */
  function isOverGap(z) {
    const half = CFG.segLen / 2 - CFG.gapInset;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.gap && z > s.z - half && z < s.z + half) return true;
    }
    return false;
  }

  /* ========================================================================
     7. OBSTACLES & COINS (object pools — no allocation during play)
     ======================================================================== */
  const GEO = {
    lowBlock: new THREE.BoxGeometry(1.9, 0.9, 0.7),
    lowStripe: new THREE.BoxGeometry(1.94, 0.1, 0.74),
    log: new THREE.CylinderGeometry(0.42, 0.42, CFG.trackW - 0.2, 14).rotateZ(Math.PI / 2),
    logRing: new THREE.CylinderGeometry(0.45, 0.45, 0.12, 14).rotateZ(Math.PI / 2),
    slabFull: new THREE.BoxGeometry(CFG.trackW + 0.6, 2.1, 0.45),
    stripFull: new THREE.BoxGeometry(CFG.trackW + 0.6, 0.12, 0.5),
    post: new THREE.BoxGeometry(0.45, 3.7, 0.45),
    slabLane: new THREE.BoxGeometry(2.0, 2.1, 0.45),
    stripLane: new THREE.BoxGeometry(2.0, 0.12, 0.5),
    postThin: new THREE.BoxGeometry(0.16, 3.5, 0.3),
    wall: new THREE.BoxGeometry(1.9, 3.1, 1.0),
    wallCap: new THREE.BoxGeometry(2.1, 0.25, 1.15),
    wallStripe: new THREE.BoxGeometry(0.1, 2.4, 0.04),
    drum: new THREE.CylinderGeometry(0.55, 0.55, 1.0, 18).rotateX(Math.PI / 2),
    drumRing: new THREE.TorusGeometry(0.56, 0.06, 6, 24),
    boulder: new THREE.IcosahedronGeometry(0.95, 1),
    coin: new THREE.CylinderGeometry(0.34, 0.34, 0.08, 20).rotateX(Math.PI / 2),
    coinRim: new THREE.TorusGeometry(0.34, 0.05, 6, 20),
    coinFace: new THREE.BoxGeometry(0.12, 0.3, 0.11),
  };

  function mesh(geo, mat, x = 0, y = 0, z = 0, shadow = false) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    return m;
  }

  /**
   * Obstacle definitions. Hitboxes are axis-aligned: half-width (x),
   * half-depth (z) and a vertical [yMin, yMax] band.
   */
  const OBS = {
    low: {                   // knee-high block — jump
      hw: 0.95, hd: 0.36, yMin: 0, yMax: 0.9,
      make() {
        const g = new THREE.Group();
        g.add(mesh(GEO.lowBlock, MAT.stone, 0, 0.45, 0, true), mesh(GEO.lowStripe, MAT.orange, 0, 0.78, 0));
        return g;
      },
    },
    log: {                   // fallen log across all lanes — jump
      hw: CFG.trackW / 2, hd: 0.42, yMin: 0, yMax: 0.84,
      make() {
        const g = new THREE.Group();
        g.add(mesh(GEO.log, MAT.wood, 0, 0.42, 0, true));
        for (const x of [-2.9, -1.1, 1.1, 2.9]) g.add(mesh(GEO.logRing, MAT.orange, x, 0.42, 0));
        return g;
      },
    },
    high: {                  // hanging slab across all lanes — slide
      hw: CFG.trackW / 2, hd: 0.25, yMin: 1.3, yMax: 3.5,
      make() {
        const g = new THREE.Group();
        g.add(mesh(GEO.slabFull, MAT.stone, 0, 2.4, 0, true), mesh(GEO.stripFull, MAT.cyan, 0, 1.36, 0));
        for (const s of [-1, 1]) g.add(mesh(GEO.post, MAT.stoneDark, s * (CFG.trackW / 2 + 0.35), 1.85, 0, true));
        return g;
      },
    },
    gate: {                  // single-lane hanging slab — slide or dodge
      hw: 1.0, hd: 0.25, yMin: 1.3, yMax: 3.5,
      make() {
        const g = new THREE.Group();
        g.add(mesh(GEO.slabLane, MAT.stone, 0, 2.4, 0, true), mesh(GEO.stripLane, MAT.cyan, 0, 1.36, 0));
        for (const s of [-1, 1]) g.add(mesh(GEO.postThin, MAT.stoneDark, s * 0.92, 1.75, 0));
        return g;
      },
    },
    wall: {                  // tall block — change lane
      hw: 0.95, hd: 0.5, yMin: 0, yMax: 3.1,
      make() {
        const g = new THREE.Group();
        g.add(mesh(GEO.wall, MAT.stone, 0, 1.55, 0, true), mesh(GEO.wallCap, MAT.stoneDark, 0, 3.2, 0, true));
        for (const x of [-0.5, 0.5]) g.add(mesh(GEO.wallStripe, MAT.magenta, x, 1.55, 0.51));
        return g;
      },
    },
    sweeper: {               // drum rolling side to side across lanes — dodge or jump
      hw: 0.58, hd: 0.52, yMin: 0, yMax: 1.1,
      make() {
        const g = new THREE.Group();
        const spin = new THREE.Group();
        spin.position.y = 0.56;
        spin.add(mesh(GEO.drum, MAT.stoneDark, 0, 0, 0, true));
        for (const z of [-0.46, 0.46]) spin.add(mesh(GEO.drumRing, MAT.magenta, 0, 0, z));
        g.add(spin);
        g.userData.spin = spin;
        return g;
      },
    },
    boulder: {               // boulder rolling towards the player — dodge
      hw: 0.85, hd: 0.85, yMin: 0, yMax: 1.8,
      make() {
        const g = new THREE.Group();
        const spin = new THREE.Group();
        spin.position.y = 0.95;
        spin.add(mesh(GEO.boulder, MAT.boulder, 0, 0, 0, true));
        g.add(spin);
        g.userData.spin = spin;
        return g;
      },
    },
  };

  const obstaclePools = {};
  const activeObs = [];

  function spawnObstacle(type, x, z) {
    const pool = obstaclePools[type] || (obstaclePools[type] = []);
    let o = pool.pop();
    if (!o) {
      o = { type, def: OBS[type], mesh: OBS[type].make() };
      scene.add(o.mesh);
    }
    o.x = x;
    o.z = z;
    o.prevZ = z;
    o.t = 0;
    o.phase = rand(0, Math.PI * 2);
    o.omega = 1.7 + Gen.difficulty() * 0.9;
    o.rolling = false;
    o.mesh.visible = true;
    o.mesh.position.set(x, 0, z);
    activeObs.push(o);
    return o;
  }

  function releaseObstacle(i) {
    const o = activeObs[i];
    o.mesh.visible = false;
    obstaclePools[o.type].push(o);
    activeObs[i] = activeObs[activeObs.length - 1];
    activeObs.pop();
  }

  function updateObstacles(dz, dt) {
    for (let i = activeObs.length - 1; i >= 0; i--) {
      const o = activeObs[i];
      o.prevZ = o.z;
      o.z += dz;

      if (o.type === 'sweeper') {
        o.t += dt;
        o.x = Math.sin(o.phase + o.t * o.omega) * CFG.laneW;
        o.mesh.userData.spin.rotation.z = -o.x / 0.55;
      } else if (o.type === 'boulder') {
        // Sits still until close, then starts rolling at the player
        if (!o.rolling && Game.state === 'running' && o.z > -1.7 * (Game.speed + 7)) {
          o.rolling = true;
          Sound.rumble();
          Cam.shake = Math.max(Cam.shake, 0.12);
        }
        let roll = dz;
        if (o.rolling) {
          const extra = 7 * dt;
          o.z += extra;
          roll += extra;
          if (Math.random() < 0.5) {
            Particles.emit(o.x + rand(-0.6, 0.6), 0.1, o.z - 0.6, rand(-1, 1), rand(1, 3), rand(-2, 0),
              COL.dust, rand(0.25, 0.45), rand(0.4, 0.7), 2, 1.5);
          }
        }
        o.mesh.userData.spin.rotation.x += roll / 0.95;
      }

      o.mesh.position.set(o.x, 0, o.z);
      if (o.z - o.def.hd > CFG.despawnZ) releaseObstacle(i);
    }
  }

  // ---- Coins ----
  const coinPool = [];
  const activeCoins = [];
  let coinSpin = 0;

  function spawnCoin(x, y, z) {
    let c = coinPool.pop();
    if (!c) {
      // Disc + bright rim + embossed bar so the coin reads clearly at speed
      const m = new THREE.Mesh(GEO.coin, MAT.coin);
      m.add(new THREE.Mesh(GEO.coinRim, MAT.coinRim), new THREE.Mesh(GEO.coinFace, MAT.coinRim));
      c = { mesh: m };
      scene.add(m);
    }
    c.x = x;
    c.y = y;
    c.z = z;
    c.mesh.visible = true;
    c.mesh.position.set(x, y, z);
    activeCoins.push(c);
  }

  function releaseCoin(i) {
    const c = activeCoins[i];
    c.mesh.visible = false;
    coinPool.push(c);
    activeCoins[i] = activeCoins[activeCoins.length - 1];
    activeCoins.pop();
  }

  function updateCoins(dz, dt) {
    coinSpin += dt * 3.2;
    for (let i = activeCoins.length - 1; i >= 0; i--) {
      const c = activeCoins[i];
      c.z += dz;
      c.mesh.position.set(c.x, c.y + Math.sin(coinSpin * 1.3 + c.z * 0.4) * 0.08, c.z);
      c.mesh.rotation.y = coinSpin + c.z * 0.15;
      if (c.z > CFG.despawnZ) releaseCoin(i);
    }
  }

  function clearObjects() {
    while (activeObs.length) releaseObstacle(activeObs.length - 1);
    while (activeCoins.length) releaseCoin(activeCoins.length - 1);
  }

  /* ========================================================================
     8. LEVEL GENERATOR
     Every recycled segment either stays empty (spacing / coin trails) or
     receives one obstacle "pattern". Spacing is expressed in *seconds of
     reaction time*, so faster speeds don't make the game unfair.
     ======================================================================== */
  const Gen = {
    enabled: false,
    safe: 0,
    cooldown: 0,
    coinLane: 0,
    coinRun: 0,
    last: '',

    reset() {
      this.safe = 2;
      this.cooldown = 0;
      this.coinLane = 0;
      this.coinRun = 0;
      this.last = '';
    },

    difficulty() {
      return clamp((Game.speed - CFG.startSpeed) / (CFG.maxSpeed - CFG.startSpeed), 0, 1);
    },

    populate(seg) {
      if (!this.enabled) return;
      if (this.safe > 0) {
        this.safe--;
        this.coinTrail(seg);
        return;
      }
      if (this.cooldown > 0) {
        this.cooldown--;
        this.coinTrail(seg);
        return;
      }
      const d = this.difficulty();
      this.pattern(seg, d);
      // Minimum reaction time between obstacles shrinks as the game speeds up
      const minTime = lerp(1.15, 0.62, d);
      this.cooldown = Math.max(1, Math.ceil((Game.speed * minTime) / CFG.segLen) - 1);
      if (Math.random() < 0.3 - 0.2 * d) this.cooldown++;
    },

    pattern(seg, d) {
      const z = seg.z;
      const L = CFG.laneW;
      const table = [
        ['walls', 3],
        ['low', 2],
        ['log', 1.4],
        ['high', 1.5],
        ['gap', 1.2],
        ['mixed', 1 + 2 * d],
        ['sweeper', d > 0.08 ? 1.1 : 0],
        ['boulder', d > 0.16 ? 1.0 : 0],
      ];
      let type = weighted(table);
      if (type === this.last && Math.random() < 0.65) type = weighted(table);
      this.last = type;

      switch (type) {
        case 'walls': {
          const free = pick(LANES);
          let blocked = LANES.filter((l) => l !== free);
          if (Math.random() > 0.25 + 0.5 * d) blocked = [pick(blocked)];
          blocked.forEach((l) => spawnObstacle('wall', l * L, z));
          this.coinLane = free;
          this.coinLine(free, z, 0.7);
          break;
        }
        case 'low': {
          const lanes = shuffle(LANES).slice(0, Math.random() < 0.45 + 0.3 * d ? 2 : 1);
          lanes.forEach((l) => spawnObstacle('low', l * L, z));
          this.coinLane = lanes[0];
          this.coinArc(lanes[0], z);
          break;
        }
        case 'log':
          spawnObstacle('log', 0, z);
          this.coinArc(this.coinLane, z);
          break;
        case 'high':
          spawnObstacle('high', 0, z);
          this.coinLine(this.coinLane, z, 0.5);
          break;
        case 'gap':
          seg.setGap(true);
          this.coinArc(this.coinLane, z);
          break;
        case 'mixed': {
          const kinds = LANES.map(() => pick(['low', 'gate', 'wall', 'none', 'low', 'gate']));
          if (kinds.every((k) => k === 'wall')) kinds[randInt(0, 2)] = 'low';
          if (kinds.every((k) => k === 'none')) kinds[randInt(0, 2)] = 'wall';
          kinds.forEach((k, i) => { if (k !== 'none') spawnObstacle(k, LANES[i] * L, z); });
          // Guide the player with coins through a passable lane
          let idx = kinds.indexOf('none');
          if (idx < 0) idx = kinds.findIndex((k) => k !== 'wall');
          const lane = LANES[idx];
          if (kinds[idx] === 'low') this.coinArc(lane, z);
          else this.coinLine(lane, z, kinds[idx] === 'gate' ? 0.5 : 0.7);
          this.coinLane = lane;
          break;
        }
        case 'sweeper':
          spawnObstacle('sweeper', 0, z);
          break;
        case 'boulder': {
          const l = pick(LANES);
          spawnObstacle('boulder', l * L, z);
          const other = pick(LANES.filter((x) => x !== l));
          this.coinLane = other;
          this.coinLine(other, z, 0.7);
          break;
        }
      }
      this.coinRun = 0;
    },

    /** Occasional straight coin runs through empty segments. */
    coinTrail(seg) {
      if (this.coinRun <= 0) {
        if (Math.random() > 0.45) return;
        this.coinRun = randInt(2, 5);
        if (Math.random() < 0.5) this.coinLane = clamp(this.coinLane + pick([-1, 1]), -1, 1);
      }
      this.coinRun--;
      this.coinLine(this.coinLane, seg.z, 0.7);
    },

    coinLine(lane, zc, y) {
      for (let k = -2; k <= 2; k++) spawnCoin(lane * CFG.laneW, y, zc + k * 1.2);
    },

    /** Arc of coins that matches a jump over an obstacle / gap. */
    coinArc(lane, zc) {
      for (let k = -3; k <= 3; k++) {
        const off = k * 1.5;
        const y = 0.8 + 1.9 * (1 - Math.pow(off / 5, 2));
        spawnCoin(lane * CFG.laneW, y, zc + off);
      }
    },
  };

  /* ========================================================================
     9. PLAYER — stylised low-poly runner built from primitives
     ======================================================================== */
  const Player = (() => {
    const root = new THREE.Group();
    scene.add(root);
    const body = new THREE.Group(); // pivot at the hips
    root.add(body);

    const M = {
      suit: new THREE.MeshLambertMaterial({ color: 0xeef0ff }),
      pants: new THREE.MeshLambertMaterial({ color: 0x2b2a5e }),
      dark: new THREE.MeshLambertMaterial({ color: 0x17132e }),
      skin: new THREE.MeshLambertMaterial({ color: 0xf0c3a0 }),
      hair: new THREE.MeshLambertMaterial({ color: 0x1a1030 }),
      shoe: new THREE.MeshLambertMaterial({ color: 0xff3fd0, emissive: 0x3a0030 }),
      cyan: MAT.cyan,
      magenta: MAT.magenta,
    };
    const part = (geo, mat, x, y, z, parent) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);

    // Torso & backpack (the backpack faces the camera, so it gets detail)
    part(B(0.5, 0.62, 0.3), M.suit, 0, 0.34, 0, body);
    part(B(0.52, 0.07, 0.32), M.dark, 0, 0.06, 0, body);
    part(B(0.51, 0.06, 0.31), M.cyan, 0, 0.46, 0, body);
    part(B(0.36, 0.42, 0.16), M.dark, 0, 0.38, 0.22, body);
    part(B(0.26, 0.05, 0.02), M.cyan, 0, 0.47, 0.305, body);
    part(B(0.05, 0.22, 0.02), M.magenta, 0, 0.3, 0.305, body);

    // Head
    const head = new THREE.Group();
    head.position.y = 0.8;
    body.add(head);
    part(new THREE.SphereGeometry(0.21, 16, 12), M.skin, 0, 0, 0, head);
    const hair = part(new THREE.SphereGeometry(0.228, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), M.hair, 0, 0.02, 0.02, head);
    hair.rotation.x = 0.35;
    part(B(0.3, 0.07, 0.08), M.cyan, 0, 0.02, -0.18, head); // visor

    // Scarf streaming behind
    const scarfPivot = new THREE.Group();
    scarfPivot.position.set(0, 0.64, 0.12);
    body.add(scarfPivot);
    part(B(0.12, 0.04, 0.55), M.magenta, 0, 0, 0.27, scarfPivot);

    function makeArm(side) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.32, 0.6, 0);
      body.add(shoulder);
      part(B(0.13, 0.32, 0.13), M.suit, 0, -0.16, 0, shoulder);
      const elbow = new THREE.Group();
      elbow.position.y = -0.32;
      shoulder.add(elbow);
      part(B(0.12, 0.3, 0.12), M.skin, 0, -0.15, 0, elbow);
      part(B(0.13, 0.08, 0.13), M.dark, 0, -0.31, 0, elbow);
      return { shoulder, elbow };
    }
    function makeLeg(side) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.13, 0, 0);
      body.add(hip);
      part(B(0.18, 0.42, 0.18), M.pants, 0, -0.21, 0, hip);
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      hip.add(knee);
      part(B(0.16, 0.38, 0.16), M.pants, 0, -0.19, 0, knee);
      part(B(0.19, 0.11, 0.32), M.shoe, 0, -0.4, -0.05, knee);
      part(B(0.2, 0.03, 0.33), M.cyan, 0, -0.46, -0.05, knee);
      return { hip, knee };
    }
    const armL = makeArm(-1), armR = makeArm(1);
    const legL = makeLeg(-1), legR = makeLeg(1);

    // Blob shadow — keeps the runner grounded even if shadow maps are disabled
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 1.3),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    scene.add(blob);

    // Pose state (current values, smoothly damped towards per-frame targets)
    const pose = { bodyY: 0.9, bodyRX: 0, hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, armL: 0, armR: 0, armZ: 0, elbL: 0, elbR: 0 };
    const target = Object.assign({}, pose);

    const P = {
      root,
      lane: 0, prevLane: 0,
      x: 0, y: 0, vy: 0,
      grounded: true,
      sliding: false, slideT: 0,
      queueSlide: false,
      jumpBuffer: 0,
      falling: false,
      dead: false,
      stumbleCD: 0,
      runPhase: 0,
      lastStep: 0,
      knockZ: 0,
      time: 0,

      reset() {
        this.lane = this.prevLane = 0;
        this.x = this.y = this.vy = 0;
        this.grounded = true;
        this.sliding = this.falling = this.dead = this.queueSlide = false;
        this.slideT = this.jumpBuffer = this.stumbleCD = 0;
        this.knockZ = 0;
        root.position.set(0, 0, 0);
        root.rotation.set(0, 0, 0);
        Object.assign(pose, { bodyY: 0.9, bodyRX: 0 });
      },

      height() { return this.sliding ? CFG.slideH : CFG.standH; },
      isChanging() { return Math.abs(this.x - this.lane * CFG.laneW) > 0.08; },

      // ---------- actions ----------
      move(dir) {
        if (this.dead || this.falling) return;
        const nl = clamp(this.lane + dir, -1, 1);
        if (nl === this.lane) return;
        this.prevLane = this.lane;
        this.lane = nl;
        Sound.whoosh();
      },
      jump() {
        if (this.dead || this.falling) return;
        if (this.grounded) {
          this.vy = CFG.jumpVel;
          this.grounded = false;
          this.sliding = false;
          this.queueSlide = false;
          Sound.jump();
          burst(this.x, 0.1, 0.1, 8, COL.dust, 2.5, 0.45);
        } else {
          this.jumpBuffer = 0.14; // pressed just before landing — jump on touchdown
          this.queueSlide = false;
        }
      },
      slide() {
        if (this.dead || this.falling) return;
        if (this.grounded) {
          if (!this.sliding) Sound.slide();
          this.sliding = true;
          this.slideT = CFG.slideTime;
        } else {
          // Slam down from a jump, then slide on landing
          this.vy = Math.min(this.vy, CFG.fastFallVel);
          this.queueSlide = true;
          this.jumpBuffer = 0;
        }
      },
      /** Side-swipe into an obstacle: bounce back to the previous lane. */
      stumble() {
        this.lane = this.prevLane;
        this.stumbleCD = 0.4;
        Sound.stumble();
        Cam.shake = Math.max(Cam.shake, 0.35);
        UI.flash('bump');
        vibrate(30);
        burst(this.x, 1, 0, 10, COL.orange, 4, 0.4);
      },

      // ---------- physics ----------
      update(dt) {
        this.time += dt;
        this.stumbleCD = Math.max(0, this.stumbleCD - dt);
        this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

        if (!this.dead) this.x = damp(this.x, this.lane * CFG.laneW, 16, dt);

        if (this.sliding) {
          this.slideT -= dt;
          if (this.slideT <= 0) this.sliding = false;
        }

        if (this.grounded) {
          if (!this.dead && isOverGap(0)) {
            this.grounded = false;
            this.vy = 0;
            this.sliding = false;
          }
        } else {
          this.vy -= CFG.gravity * dt;
          this.y += this.vy * dt;
          if (this.y <= 0 && !this.falling) {
            if (isOverGap(0)) {
              // A little ledge-grab forgiveness before committing to the fall
              if (this.y < -0.35) {
                this.falling = true;
                this.sliding = false;
                if (!this.dead) Sound.fall();
              }
            } else {
              this.y = 0;
              this.vy = 0;
              this.grounded = true;
              this.onLand();
            }
          }
        }
        if (this.falling && this.y < -3.5 && Game.state === 'running') die('fall');
      },

      onLand() {
        if (this.dead) return;
        Sound.land();
        burst(this.x, 0.08, 0.1, 10, COL.dust, 3, 0.5);
        if (this.queueSlide) {
          this.queueSlide = false;
          this.slide();
        } else if (this.jumpBuffer > 0) {
          this.jumpBuffer = 0;
          this.jump();
        }
      },

      // ---------- animation ----------
      animate(dt, runSpeed) {
        const T = target;
        const t = this.time;

        if (this.dead && !this.falling) {
          // knocked flat on the back
          Object.assign(T, { bodyY: 0.32, bodyRX: 1.45, hipL: 0.5, hipR: 0.2, kneeL: -0.3, kneeR: -0.6, armL: 2.6, armR: 2.2, armZ: 0.5, elbL: 0.3, elbR: 0.5 });
          this.knockZ = damp(this.knockZ, 1.2, 6, dt);
        } else if (this.falling) {
          const f = Math.sin(t * 22);
          Object.assign(T, { bodyY: 0.9, bodyRX: -0.2, hipL: f * 0.8, hipR: -f * 0.8, kneeL: -0.8, kneeR: -0.8, armL: 2.8 + f * 0.4, armR: 2.8 - f * 0.4, armZ: 0.6, elbL: 0.3, elbR: 0.3 });
        } else if (this.sliding) {
          Object.assign(T, { bodyY: 0.42, bodyRX: 1.2, hipL: 0.3, hipR: 0.1, kneeL: -0.2, kneeR: -0.5, armL: -0.3, armR: -0.3, armZ: 0.35, elbL: 0.4, elbR: 0.4 });
        } else if (!this.grounded) {
          // tuck on the way up, extend on the way down
          const up = this.vy > 0 ? 1 : 0;
          Object.assign(T, {
            bodyY: 0.9, bodyRX: -0.15,
            hipL: up ? 1.2 : 0.6, hipR: up ? 0.2 : -0.2,
            kneeL: up ? -1.6 : -0.6, kneeR: up ? -1.4 : -0.4,
            armL: 2.4, armR: -0.6, armZ: 0.25, elbL: 0.4, elbR: 1.0,
          });
        } else {
          // run cycle — cadence scales with speed
          this.runPhase += dt * (runSpeed * 0.42 + 4);
          const s = Math.sin(this.runPhase);
          const c = Math.cos(this.runPhase);
          Object.assign(T, {
            bodyY: 0.9 + Math.abs(c) * 0.07,
            bodyRX: -0.14,
            hipL: s * 0.95, hipR: -s * 0.95,
            kneeL: -Math.max(0, -c) * 1.5 - 0.15, kneeR: -Math.max(0, c) * 1.5 - 0.15,
            armL: -s * 0.85, armR: s * 0.85, armZ: 0.12,
            elbL: 1.2 + s * 0.2, elbR: 1.2 - s * 0.2,
          });
          // footfall dust
          const step = Math.sign(s);
          if (step !== this.lastStep) {
            this.lastStep = step;
            const fx = this.x + (step > 0 ? 0.13 : -0.13);
            for (let k = 0; k < 2; k++) {
              Particles.emit(fx, 0.06, 0.2, rand(-0.6, 0.6), rand(0.6, 1.6), rand(0.5, 2), COL.dust, rand(0.2, 0.34), rand(0.35, 0.6), 1, 2);
            }
          }
        }

        const k = 20;
        for (const key in pose) pose[key] = damp(pose[key], T[key], k, dt);

        body.position.y = pose.bodyY;
        body.rotation.x = pose.bodyRX;
        legL.hip.rotation.x = pose.hipL;
        legR.hip.rotation.x = pose.hipR;
        legL.knee.rotation.x = pose.kneeL;
        legR.knee.rotation.x = pose.kneeR;
        armL.shoulder.rotation.x = pose.armL;
        armR.shoulder.rotation.x = pose.armR;
        armL.shoulder.rotation.z = -pose.armZ;
        armR.shoulder.rotation.z = pose.armZ;
        armL.elbow.rotation.x = pose.elbL;
        armR.elbow.rotation.x = pose.elbR;
        scarfPivot.rotation.x = -0.25 - Math.sin(t * 16) * 0.12;
        scarfPivot.rotation.y = Math.sin(t * 9) * 0.15;

        // Lean into lane changes
        const dx = this.lane * CFG.laneW - this.x;
        root.rotation.z = damp(root.rotation.z, this.dead ? 0 : -dx * 0.12, 12, dt);
        root.rotation.y = damp(root.rotation.y, this.dead ? 0 : dx * 0.1, 12, dt);
        root.position.set(this.x, this.y, this.knockZ);

        // Blob shadow shrinks with height, hidden over pits
        const overPit = isOverGap(0) || this.falling;
        blob.visible = !overPit;
        const sh = clamp(1 - this.y * 0.22, 0.35, 1);
        blob.scale.set(sh * (this.sliding ? 1.4 : 1), sh * (this.sliding ? 1.9 : 1), 1);
        blob.position.set(this.x, 0.02, this.knockZ + (this.sliding ? -0.2 : 0));
        blob.material.opacity = 0.55 * sh;
      },
    };
    return P;
  })();

  /* ========================================================================
     10. PARTICLES — one Points object, CPU-simulated ring buffer
     ======================================================================== */
  const COL = {
    dust: new THREE.Color(0x9a86ff),
    gold: new THREE.Color(0xffc933),
    white: new THREE.Color(0xffffff),
    cyan: new THREE.Color(0x22e4ff),
    magenta: new THREE.Color(0xff3fd0),
    orange: new THREE.Color(0xffa53a),
  };

  const Particles = (() => {
    const MAX = IS_TOUCH ? 450 : 700;
    const pos = new Float32Array(MAX * 3);
    const col = new Float32Array(MAX * 3);
    const size = new Float32Array(MAX);
    const alpha = new Float32Array(MAX);
    const vel = new Float32Array(MAX * 3);
    const life = new Float32Array(MAX);
    const maxLife = new Float32Array(MAX);
    const baseSize = new Float32Array(MAX);
    const grav = new Float32Array(MAX);
    const drag = new Float32Array(MAX);
    let cursor = 0;

    const geo = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    const aAlpha = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos);
    geo.setAttribute('pcolor', aCol);
    geo.setAttribute('size', aSize);
    geo.setAttribute('alpha', aAlpha);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 400 } },
      vertexShader: /* glsl */ `
        attribute float size; attribute float alpha; attribute vec3 pcolor;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = pcolor; vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * vAlpha;
          gl_FragColor = vec4(vColor, a);
        }`,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    return {
      material: mat,
      emit(x, y, z, vx, vy, vz, color, sz, lf, gravity = 0, dragK = 0) {
        const i = cursor;
        cursor = (cursor + 1) % MAX;
        const i3 = i * 3;
        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
        vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
        col[i3] = color.r; col[i3 + 1] = color.g; col[i3 + 2] = color.b;
        baseSize[i] = sz;
        life[i] = maxLife[i] = lf;
        grav[i] = gravity;
        drag[i] = dragK;
      },
      /** dz: how far the world moved this frame (particles live in world space). */
      update(dt, dz) {
        for (let i = 0; i < MAX; i++) {
          if (life[i] <= 0) continue;
          life[i] -= dt;
          if (life[i] <= 0) {
            alpha[i] = 0;
            size[i] = 0;
            continue;
          }
          const i3 = i * 3;
          const dk = Math.max(0, 1 - drag[i] * dt);
          vel[i3] *= dk;
          vel[i3 + 1] = vel[i3 + 1] * dk - grav[i] * dt;
          vel[i3 + 2] *= dk;
          pos[i3] += vel[i3] * dt;
          pos[i3 + 1] += vel[i3 + 1] * dt;
          pos[i3 + 2] += vel[i3 + 2] * dt + dz;
          const t = life[i] / maxLife[i];
          alpha[i] = Math.min(1, t * 2);
          size[i] = baseSize[i] * (0.4 + 0.6 * t);
        }
        aPos.needsUpdate = aCol.needsUpdate = aSize.needsUpdate = aAlpha.needsUpdate = true;
      },
    };
  })();

  /** Radial burst helper. */
  function burst(x, y, z, n, color, power, lifeT, gravity = 6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const p = power * rand(0.4, 1);
      Particles.emit(x, y, z, Math.cos(a) * p, rand(0.3, 1) * p, Math.sin(a) * p, color, rand(0.18, 0.4), lifeT * rand(0.7, 1.2), gravity, 1.5);
    }
  }

  /* ========================================================================
     11. INPUT — keyboard + swipe (touch and mouse drag via Pointer Events)
     ======================================================================== */
  function action(name) {
    if (Game.state !== 'running') return;
    switch (name) {
      case 'left': Player.move(-1); break;
      case 'right': Player.move(1); break;
      case 'up': Player.jump(); break;
      case 'down': Player.slide(); break;
    }
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(k)) e.preventDefault();
    if (e.repeat) return;
    switch (k) {
      case 'ArrowLeft': case 'a': case 'A': action('left'); break;
      case 'ArrowRight': case 'd': case 'D': action('right'); break;
      case 'ArrowUp': case 'w': case 'W': case ' ':
        if (Game.state === 'menu' && k === ' ') startRun();
        else action('up');
        break;
      case 'ArrowDown': case 's': case 'S': action('down'); break;
      case 'p': case 'P': case 'Escape':
        if (Game.state === 'running' || Game.state === 'countdown') pause();
        else if (Game.state === 'paused') resume();
        break;
      case 'm': case 'M': toggleMusic(); break;
      case 'Enter':
        if (Game.state === 'menu' || Game.state === 'over') startRun();
        else if (Game.state === 'paused') resume();
        break;
    }
  });

  // Swipe detection: fires as soon as the finger travels past the threshold
  // (not on release), which feels much more responsive.
  const Swipe = { id: null, x: 0, y: 0, fired: false };
  const touchLayer = document.getElementById('touch-layer');
  const swipeThreshold = () => Math.max(22, Math.min(window.innerWidth, window.innerHeight) * 0.045);

  touchLayer.addEventListener('pointerdown', (e) => {
    Swipe.id = e.pointerId;
    Swipe.x = e.clientX;
    Swipe.y = e.clientY;
    Swipe.fired = false;
    try { touchLayer.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  touchLayer.addEventListener('pointermove', (e) => {
    if (e.pointerId !== Swipe.id || Swipe.fired) return;
    const dx = e.clientX - Swipe.x;
    const dy = e.clientY - Swipe.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < swipeThreshold()) return;
    Swipe.fired = true;
    if (Math.abs(dx) > Math.abs(dy)) action(dx > 0 ? 'right' : 'left');
    else action(dy > 0 ? 'down' : 'up');
  });
  const endSwipe = (e) => {
    if (e.pointerId === Swipe.id) Swipe.id = null;
  };
  touchLayer.addEventListener('pointerup', endSwipe);
  touchLayer.addEventListener('pointercancel', endSwipe);
  // Block pinch/scroll gestures leaking to the page on iOS
  document.addEventListener('touchmove', (e) => { if (e.target === touchLayer) e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  /* ========================================================================
     12. CAMERA RIG — attract-mode orbit on the menu, chase cam in-game
     ======================================================================== */
  const Cam = {
    blend: 0,           // 0 = menu shot, 1 = chase shot
    shake: 0,
    portrait: false,
    baseFov: 62,
    look: new THREE.Vector3(0, 1.2, -8),
    _pos: new THREE.Vector3(),
    _menuPos: new THREE.Vector3(),
    _chasePos: new THREE.Vector3(),
    _menuLook: new THREE.Vector3(),
    _chaseLook: new THREE.Vector3(),
    _targetLook: new THREE.Vector3(),
    time: 0,

    update(dt, rawDt) {
      this.time += rawDt;
      const p = Player;
      const toChase = Game.state !== 'menu';
      this.blend = clamp(this.blend + (toChase ? rawDt / 1.1 : -rawDt / 1.1), 0, 1);
      const b = easeInOut(this.blend);

      // Menu: slow sweeping 3/4 front shot of the runner
      const sway = Math.sin(this.time * 0.35);
      this._menuPos.set(2.8 + sway * 1.4, 1.9 + Math.sin(this.time * 0.5) * 0.25, -5.2);
      // On wide screens aim off-centre so the runner sits beside the title panel
      this._menuLook.set(this.portrait ? 0 : -3.3, this.portrait ? 1.6 : 1.3, 0.5);

      // Chase: behind and above, follows lane & jump height
      const back = this.portrait ? 9.2 : 7.4;
      const up = this.portrait ? 5.0 : 4.0;
      const follow = this.portrait ? 0.7 : 0.55;
      const camY = p.falling ? up : up + Math.max(0, p.y) * 0.35 - (p.sliding ? 0.45 : 0);
      this._chasePos.set(p.x * follow, camY, back);
      const lookY = p.falling ? Math.max(-2, p.y) : 1.3 + Math.max(0, p.y) * 0.3;
      this._chaseLook.set(p.x * 0.75, lookY, -8);

      this._pos.lerpVectors(this._menuPos, this._chasePos, b);
      this._targetLook.lerpVectors(this._menuLook, this._chaseLook, b);

      const lambda = this.blend < 1 ? 30 : 9;
      camera.position.x = damp(camera.position.x, this._pos.x, lambda, rawDt);
      camera.position.y = damp(camera.position.y, this._pos.y, lambda, rawDt);
      camera.position.z = damp(camera.position.z, this._pos.z, lambda, rawDt);
      this.look.x = damp(this.look.x, this._targetLook.x, lambda, rawDt);
      this.look.y = damp(this.look.y, this._targetLook.y, lambda, rawDt);
      this.look.z = damp(this.look.z, this._targetLook.z, lambda, rawDt);

      // Screen shake
      if (this.shake > 0) {
        const s = this.shake * this.shake;
        camera.position.x += rand(-1, 1) * s * 0.6;
        camera.position.y += rand(-1, 1) * s * 0.6;
        this.shake = Math.max(0, this.shake - rawDt * 1.6);
      }
      camera.lookAt(this.look);

      // Widen FOV with speed for a stronger sense of velocity
      const speedT = Gen.difficulty();
      const fov = this.baseFov + (toChase ? speedT * 10 : 0);
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = damp(camera.fov, fov, 3, rawDt);
        camera.updateProjectionMatrix();
      }
      Particles.material.uniforms.uScale.value =
        renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

      // Sky follows the camera horizontally; key light follows the player
      skyGroup.position.set(camera.position.x, 0, camera.position.z);
      keyLight.position.set(p.x - 5, 14, 7);
      keyLight.target.position.set(p.x, 0, -4);
    },
  };

  /* ========================================================================
     13. UI LAYER
     ======================================================================== */
  const $ = (id) => document.getElementById(id);
  const UI = {
    screens: { start: $('screen-start'), pause: $('screen-pause'), over: $('screen-over') },
    hud: $('hud'),
    scoreEl: $('score'),
    distEl: $('distance'),
    coinsEl: $('coins'),
    coinPill: $('coin-pill'),
    toastEl: $('toast'),
    countEl: $('countdown'),
    flashEl: $('flash'),
    _score: -1, _dist: -1, _coins: -1, _toastTimer: 0,

    show(name) {
      for (const k in this.screens) this.screens[k].classList.toggle('visible', k === name);
    },
    setHud(visible) { this.hud.classList.toggle('visible', visible); },

    updateHUD() {
      const s = score();
      const d = Math.floor(Game.distance);
      if (s !== this._score) { this._score = s; this.scoreEl.textContent = s.toLocaleString(); }
      if (d !== this._dist) { this._dist = d; this.distEl.textContent = d.toLocaleString(); }
      if (Game.coins !== this._coins) {
        const bumped = Game.coins > this._coins && this._coins >= 0;
        this._coins = Game.coins;
        this.coinsEl.textContent = Game.coins;
        if (bumped) {
          this.coinPill.classList.remove('bump');
          void this.coinPill.offsetWidth; // restart animation
          this.coinPill.classList.add('bump');
        }
      }
    },

    toast(text, variant = '') {
      const el = this.toastEl;
      el.textContent = text;
      el.className = 'toast show ' + variant;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => el.classList.remove('show'), 1500);
    },

    countdown(text) {
      const el = this.countEl;
      el.textContent = text;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    },

    flash(kind) {
      const el = this.flashEl;
      el.className = '';
      void el.offsetWidth;
      el.className = kind;
    },

    refreshMenuStats() {
      $('best-score').textContent = Game.best.toLocaleString();
      $('total-coins').textContent = Game.totalCoins.toLocaleString();
    },

    refreshToggles() {
      const sfx = $('toggle-sfx'), mus = $('toggle-music'), hudMus = $('btn-music');
      sfx.querySelector('b').textContent = Sound.sfxOn ? 'On' : 'Off';
      sfx.classList.toggle('off', !Sound.sfxOn);
      sfx.setAttribute('aria-pressed', Sound.sfxOn);
      mus.querySelector('b').textContent = Sound.musicOn ? 'On' : 'Off';
      mus.classList.toggle('off', !Sound.musicOn);
      mus.setAttribute('aria-pressed', Sound.musicOn);
      hudMus.classList.toggle('off', !Sound.musicOn);
    },

    /** Animated count-up for the final score. */
    countUp(el, to, ms = 900) {
      const start = performance.now();
      const tick = (now) => {
        const t = clamp((now - start) / ms, 0, 1);
        el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3))).toLocaleString();
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
  };

  function toggleMusic() {
    Sound.init();
    Sound.toggleMusic();
    UI.refreshToggles();
  }

  // Button wiring (Sound.init() on first gesture unlocks audio on iOS/Chrome)
  const onTap = (id, fn) => $(id).addEventListener('click', (e) => { e.stopPropagation(); Sound.init(); fn(); });
  onTap('btn-play', startRun);
  onTap('btn-again', startRun);
  onTap('btn-restart', startRun);
  onTap('btn-pause', pause);
  onTap('btn-resume', resume);
  onTap('btn-home', goToMenu);
  onTap('btn-menu', goToMenu);
  onTap('btn-music', toggleMusic);
  onTap('toggle-music', toggleMusic);
  onTap('toggle-sfx', () => { Sound.toggleSfx(); Sound.click(); UI.refreshToggles(); });
  // Unlock audio on the very first interaction anywhere (music on the menu)
  window.addEventListener('pointerdown', () => Sound.init(), { once: true });

  /* ========================================================================
     14. GAME STATE & MAIN LOOP
     ======================================================================== */
  const Game = {
    state: 'menu',      // menu | running | paused | countdown | dying | over
    speed: CFG.startSpeed,
    distance: 0,
    coins: 0,
    elapsed: 0,
    deathT: 0,
    deathCause: '',
    countdownT: 0,
    countdownN: 0,
    timeScale: 1,
    nextMilestone: CFG.milestone,
    combo: 0,
    comboT: 0,
    ambientT: 0,
    best: Store.get('best', 0),
    totalCoins: Store.get('totalCoins', 0),
  };

  const score = () => Math.floor(Game.distance) + Game.coins * CFG.coinValue;

  /** Put far segments back into generation order and populate them. */
  function regenerateAhead() {
    const ordered = segments.slice().sort((a, b) => b.z - a.z);
    for (const s of ordered) {
      s.setGap(false);
      if (s.z < -34) Gen.populate(s);
    }
  }

  function startRun() {
    Sound.init();
    Sound.click();
    clearObjects();
    Player.reset();
    Object.assign(Game, {
      speed: CFG.startSpeed, distance: 0, coins: 0, elapsed: 0, timeScale: 1,
      nextMilestone: CFG.milestone, combo: 0, comboT: 0, deathT: 0,
    });
    Gen.reset();
    Gen.enabled = true;
    regenerateAhead();

    Game.state = 'running';
    UI.show(null);
    UI.setHud(true);
    UI._coins = -1;
    UI.updateHUD();
    Sound.setMuffled(false);

    if (!Store.get('tutorialSeen', false)) {
      UI.toast(IS_TOUCH ? 'Swipe ← → to dodge · ↑ jump · ↓ slide' : 'Arrows / WASD — dodge, jump & slide', '');
      Store.set('tutorialSeen', true);
    } else {
      UI.toast('GO!');
    }
  }

  function goToMenu() {
    clearObjects();
    Gen.enabled = false;
    for (const s of segments) s.setGap(false);
    Player.reset();
    Game.state = 'menu';
    Game.timeScale = 1;
    UI.setHud(false);
    UI.show('start');
    UI.refreshMenuStats();
    Sound.setMuffled(false);
  }

  function pause() {
    if (Game.state !== 'running' && Game.state !== 'countdown') return;
    Game.state = 'paused';
    UI.show('pause');
    Sound.setMuffled(true);
  }

  function resume() {
    if (Game.state !== 'paused') return;
    UI.show(null);
    Sound.setMuffled(false);
    Game.state = 'countdown';
    Game.countdownN = 3;
    Game.countdownT = 0;
    UI.countdown('3');
    Sound.beep(false);
  }

  function die(cause) {
    if (Game.state !== 'running') return;
    Game.state = 'dying';
    Game.deathT = 0;
    Game.deathCause = cause;
    Player.dead = true;
    Player.sliding = false;
    if (cause === 'crash') {
      Sound.crash();
      Cam.shake = 0.8;
      Game.timeScale = 0.3; // brief slow-motion
      UI.flash('hit');
      vibrate([60, 40, 80]);
      burst(Player.x, 1, 0, 26, COL.magenta, 6, 0.9);
      burst(Player.x, 1, 0, 18, COL.cyan, 5, 0.8);
      burst(Player.x, 0.5, 0, 14, COL.orange, 4, 0.7);
    } else {
      vibrate(40);
    }
  }

  function gameOver() {
    Game.state = 'over';
    UI.setHud(false);
    const s = score();
    const isBest = s > Game.best;
    if (isBest) {
      Game.best = s;
      Store.set('best', s);
    }
    Game.totalCoins += Game.coins;
    Store.set('totalCoins', Game.totalCoins);

    $('over-title').textContent = Game.deathCause === 'fall' ? 'Into the abyss' : 'Wiped out';
    $('stat-distance').textContent = Math.floor(Game.distance).toLocaleString() + ' m';
    $('stat-coins').textContent = Game.coins.toLocaleString();
    $('stat-best').textContent = Game.best.toLocaleString();
    const nb = $('new-best');
    nb.classList.remove('show');
    if (isBest && s > 0) {
      void nb.offsetWidth;
      nb.classList.add('show');
      setTimeout(() => Sound.newBest(), 450);
    } else {
      Sound.gameOver();
    }
    UI.show('over');
    UI.countUp($('final-score'), s);
  }

  /** Move everything in the world towards the camera by dz. */
  function advanceWorld(dz, dt) {
    tailZ += dz;
    for (let i = 0; i < segments.length; i++) segments[i].setZ(segments[i].z + dz);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.z - CFG.segLen / 2 > CFG.despawnZ) {
        s.setZ(tailZ - CFG.segLen);
        tailZ = s.z;
        s.setGap(false);
        s.decorate(segCounter++);
        Gen.populate(s);
      }
    }
    updateObstacles(dz, dt);
    updateCoins(dz, dt);
  }

  function checkCollisions() {
    const p = Player;
    if (p.falling || p.dead) return;
    const h = p.height();
    const pyMin = p.y, pyMax = p.y + h;

    for (let i = 0; i < activeObs.length; i++) {
      const o = activeObs[i];
      const d = o.def;
      const reachZ = d.hd + CFG.playerHD;
      if (Math.abs(o.z) >= reachZ) continue;
      if (Math.abs(o.x - p.x) >= d.hw + CFG.playerHW) continue;
      if (pyMax <= d.yMin || pyMin >= d.yMax) continue;

      // Already alongside it last frame → we moved into its side, not its face
      const wasAlongside = Math.abs(o.prevZ) < reachZ;
      if (wasAlongside && p.stumbleCD > 0) continue;
      if (wasAlongside && p.isChanging()) {
        p.stumble();
        continue;
      }
      die('crash');
      return;
    }
  }

  function checkCoins() {
    const p = Player;
    if (p.dead || p.falling) return;
    const top = p.y + p.height() + 0.2;
    for (let i = activeCoins.length - 1; i >= 0; i--) {
      const c = activeCoins[i];
      if (Math.abs(c.z) > 0.8 || Math.abs(c.x - p.x) > 0.85) continue;
      if (c.y < p.y - 0.3 || c.y > top) continue;
      releaseCoin(i);
      Game.coins++;
      Game.combo = Game.comboT > 0 ? Game.combo + 1 : 0;
      Game.comboT = 0.6;
      Sound.coin(Game.combo);
      for (let k = 0; k < 10; k++) {
        const a = Math.random() * Math.PI * 2;
        Particles.emit(c.x, c.y, c.z, Math.cos(a) * 3, rand(1, 4), Math.sin(a) * 3, k < 7 ? COL.gold : COL.white, rand(0.18, 0.32), rand(0.3, 0.5), 5, 2);
      }
    }
  }

  /** Floating embers + speed streaks for atmosphere. */
  function ambient(dt) {
    Game.ambientT -= dt;
    if (Game.ambientT > 0) return;
    Game.ambientT = 0.06;
    Particles.emit(rand(-14, 14), rand(0.5, 7), -rand(20, 80), rand(-0.3, 0.3), rand(0.1, 0.5), 0,
      Math.random() < 0.5 ? COL.cyan : COL.magenta, rand(0.12, 0.22), rand(3, 5), 0, 0);
    if (Game.state === 'running') {
      const n = Math.floor(Gen.difficulty() * 3);
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        Particles.emit(side * rand(4.5, 8), rand(0.4, 5), -rand(10, 30), 0, 0, 25, COL.white, rand(0.08, 0.14), 0.7, 0, 0);
      }
    }
  }

  function update(dt, rawDt) {
    let dz = 0;

    switch (Game.state) {
      case 'menu':
        dz = CFG.menuSpeed * dt;
        advanceWorld(dz, dt);
        Player.update(dt);
        Player.animate(dt, CFG.menuSpeed);
        break;

      case 'running': {
        Game.elapsed += dt;
        Game.speed = CFG.startSpeed + (CFG.maxSpeed - CFG.startSpeed) * (1 - Math.exp(-Game.elapsed / CFG.speedRamp));
        dz = Game.speed * dt;
        Game.distance += dz;
        advanceWorld(dz, dt);
        Player.update(dt);
        checkCollisions();
        checkCoins();
        if (Game.state === 'running' || Game.state === 'dying') Player.animate(dt, Game.speed);
        Game.comboT -= dt;

        if (Game.distance >= Game.nextMilestone) {
          UI.toast(`${Game.nextMilestone.toLocaleString()} m`, 'gold');
          Sound.milestone();
          Game.nextMilestone += CFG.milestone;
        }
        UI.updateHUD();
        break;
      }

      case 'countdown':
        Game.countdownT += rawDt;
        if (Game.countdownT >= 0.6) {
          Game.countdownT -= 0.6;
          Game.countdownN--;
          if (Game.countdownN <= 0) {
            UI.countdown('GO');
            Sound.beep(true);
            Game.state = 'running';
          } else {
            UI.countdown(String(Game.countdownN));
            Sound.beep(false);
          }
        }
        break;

      case 'dying':
        Game.deathT += rawDt;
        Game.timeScale = damp(Game.timeScale, 1, 2.5, rawDt);
        Game.speed = damp(Game.speed, 0, Game.deathCause === 'fall' ? 1.5 : 6, dt);
        dz = Game.speed * dt;
        advanceWorld(dz, dt);
        Player.update(dt);
        Player.animate(dt, 0);
        if (Game.deathT > 1.4) gameOver();
        break;

      case 'over':
        Player.animate(dt, 0);
        break;

      case 'paused':
        return; // freeze everything
    }

    ambient(dt);
    Particles.update(dt, dz);
    sunMat.uniforms.uTime.value += dt;
  }

  /* ---------- Resize & adaptive quality ---------- */
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    Cam.portrait = camera.aspect < 0.9;
    // Taller portrait screens need a wider vertical FOV to keep all 3 lanes in view
    Cam.baseFov = Cam.portrait ? clamp(62 + (0.9 - camera.aspect) * 30, 62, 78) : 62;
    camera.fov = Cam.baseFov;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));
  resize();

  /** Drops resolution, then shadows, if the device can't hold ~45 fps. */
  const Perf = {
    acc: 0, frames: 0, strikes: 0,
    sample(rawDt) {
      if (Game.state !== 'running' || rawDt > 0.25) return;
      this.acc += rawDt;
      this.frames++;
      if (this.acc < 2) return;
      const avg = this.acc / this.frames;
      this.acc = this.frames = 0;
      if (avg > 1 / 45) {
        if (++this.strikes >= 2) {
          this.strikes = 0;
          this.degrade();
        }
      } else {
        this.strikes = 0;
      }
    },
    degrade() {
      if (pixelRatio > 1) {
        pixelRatio = Math.max(1, pixelRatio - 0.25);
        renderer.setPixelRatio(pixelRatio);
        resize();
      } else if (renderer.shadowMap.enabled) {
        renderer.shadowMap.enabled = false;
        keyLight.castShadow = false;
        scene.traverse((o) => {
          if (!o.material) return;
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
        });
      } else if (pixelRatio > 0.75) {
        pixelRatio = 0.75;
        renderer.setPixelRatio(pixelRatio);
        resize();
      }
    },
  };

  // Auto-pause when the tab is hidden / the window loses focus
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pause();
      Sound.suspend();
    } else {
      Sound.resume();
    }
  });
  window.addEventListener('blur', pause);

  /* ---------- Main loop ---------- */
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const elapsedMs = now - last;
    last = now;
    Perf.sample(elapsedMs / 1000);
    const rawDt = Math.min(0.05, Math.max(0, elapsedMs / 1000));
    const dt = rawDt * Game.timeScale;

    update(dt, rawDt);
    Cam.update(dt, rawDt);
    renderer.render(scene, camera);
  }

  // Boot
  UI.refreshMenuStats();
  UI.refreshToggles();
  Player.reset();
  requestAnimationFrame(frame);
})();
