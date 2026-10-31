// Cycloidal QDD scroll scene. The drive is Jamal's SolidWorks assembly (exported read-only, see portfolio/tools).
// Like the ARES-4 scene, the active step sets targets and everything glides there with critically damped smoothing.
// Kinematics are the real ones, measured on the CAD: the eccentric shaft turns by theta, each disc centre orbits
// the axis at e = 2 mm and the disc turns back by theta / 15 (15 lobes on a 16-lobe housing profile); the output
// pins follow the discs, so the carrier turns at theta / 15. Disc B runs 180 deg behind disc A.
// Step 2 explodes the stack vertically (camera still, so the callouts stay put): the top comes off first and each part
// only moves into space the part above has already left, so nothing passes through anything; reassembly reverses it.
// Steps 1 and 4 cut a fixed quarter out of the housing and lid, so the turning parts inside stay visible.
// Debug: ?qstep=n (frozen), ?qtheta=deg (input angle), ?qexplode=0..1, ?qcam=az,el,dist,lx,ly,lz.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const section = document.querySelector('[data-qdd3d]');
let canvas = section?.querySelector('canvas');
const labelLayer = section?.querySelector('.ares3d-labels');
const dotsEl = section?.querySelector('.ares3d-dots');
const hud = section?.querySelector('.qdd-hud');
const steps = [...(section?.querySelectorAll('.ares3d-step') ?? [])];
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Per step: camera [azimuth, elevation deg, distance m], look-at, explode 0..1, input speed (turns/s),
// orbit speed (deg/s), units faded out, quarter cutaway of the shell (0..1), callouts.
const KEYS = [
  { cam: [38, 30, 0.40], look: [0, 0.016, 0], explode: 0, speed: 0.45, orbit: 0, hide: [], cut: 1, labels: [], phone: { cam: [38, 30, 0.34], look: [0, 0.012, 0] } },
  { cam: [38, 16, 0.74], look: [0, 0.122, 0], explode: 1, speed: 0.12, orbit: 0, hide: [], cut: 0, labels: ['housing', 'shaft', 'discs', 'output'], phone: { cam: [38, 16, 0.68], look: [0, 0.12, 0] } },
  { cam: [24, 64, 0.38], look: [0, 0.006, 0], explode: 0, speed: 0.55, orbit: 0, hide: ['top', 'bearingTop', 'carrier', 'bearingOut', 'outputHub'], cut: 0, labels: ['discs'], hud: true },
  { cam: [62, 22, 0.44], look: [0, 0.016, 0], explode: 0, speed: 0.3, orbit: 0, hide: [], cut: 1, labels: ['ratio'], phone: { cam: [62, 24, 0.55], look: [0, 0.07, 0] } },
];
const LABELS = {
  housing: ['Printed housing', 'The discs roll directly on its lobed profile: no ring pins'],
  shaft: ['Eccentric shaft', 'Swings both discs around the housing'],
  discs: ['Two cycloidal discs', 'Half a turn apart, so they balance each other'],
  output: ['Output', 'Pins through the discs turn it once per 15 motor turns'],
  ratio: ['15 : 1', 'reduction, inside the 12–16:1 target'],
};
// where each callout sits on each step: [dx, dy] from its part, in px (negative dx: label to the left; false: hidden)
const PLACE = {
  wide: [{},
    { output: [-100, -10], shaft: [-125, -20], discs: [-105, 15], housing: [-105, 15] },
    { discs: [130, -40] },
    { ratio: [-80, -150] }],
  phone: [{},
    { output: [16, -12], shaft: [-68, -14], discs: [18, 20], housing: [-20, 28] },
    { discs: false },                  // no room beside the housing on a phone; the card says it
    { ratio: [1, -75] }],
};
const CUT_AZ = 42;                        // the cutaway faces this azimuth (deg) and never moves
const ANCHOR_UNIT = { housing: 'housing', shaft: 'discHub', discs: 'discA', output: 'carrier', ratio: 'carrier' };

const D2R = THREE.MathUtils.degToRad;
const damp = (x, target, lambda, dt) => x + (target - x) * (1 - Math.exp(-lambda * dt));
// critically damped spring: eases in and out between steps (no snap at the start, no overshoot); v holds velocities
// transition rates (1/s) for glide(): lower is slower; a step change is 90 % done in about 5.3 / w seconds
const SPRING_CAM = 1.6, SPRING_EXPLODE = 1.7;
// two stages: the target itself eases towards the step's value and a spring follows it, so a move
// builds up from rest (no kick on the first frame) and still settles softly; ts holds the eased target
const glide = (xs, vs, ts, goals, w, dt) => { goals.forEach((g, i) => { ts[i] = damp(ts[i], g, w, dt); }); return spring(xs, vs, ts, w, dt); };
const spring = (xs, vs, targets, w, dt) => xs.map((x, i) => { vs[i] += (w * w * (targets[i] - x) - 2 * w * vs[i]) * dt; return x + vs[i] * dt; });

const smooth = t => t * t * (3 - 2 * t);
// WebGL 2 at all? No test context: on phones every context counts against a small budget
const webglOK = () => 'WebGL2RenderingContext' in window;
let live = null;                                            // the renderer of the current attempt

async function init() {
  if (!section || !canvas) return;
  if (!webglOK() || reduced) { section.classList.add('ares3d-static'); return; }
  if (labelLayer) labelLayer.textContent = '';             // a retry starts from a clean slate
  if (dotsEl) dotsEl.textContent = '';

  const renderer = live = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const phone = innerWidth < 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.5 : 2));    // lighter on phones
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.005, 10);
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.5, 1.4, 0.7);
  key.castShadow = true; key.shadow.mapSize.set(phone ? 1024 : 2048, phone ? 1024 : 2048); key.shadow.bias = -0.0003; key.shadow.radius = 6;
  Object.assign(key.shadow.camera, { left: -0.2, right: 0.2, top: 0.2, bottom: -0.2, near: 0.1, far: 3 });
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc9d3d9, 0.7));

  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const [rig, gltf] = await Promise.all([
    fetch('assets/3d/qdd-rig.json').then(r => r.json()),
    loader.loadAsync('assets/3d/qdd.glb'),
  ]);

  const MAT = {
    housing: new THREE.MeshStandardMaterial({ color: 0x33434d, roughness: 0.66, metalness: 0.04 }),
    discA: new THREE.MeshStandardMaterial({ color: 0xe8892f, roughness: 0.5, metalness: 0.04 }),
    discB: new THREE.MeshStandardMaterial({ color: 0xf2b264, roughness: 0.5, metalness: 0.04 }),
    shaft: new THREE.MeshStandardMaterial({ color: 0x1f8a84, roughness: 0.5, metalness: 0.04 }),
    input: new THREE.MeshStandardMaterial({ color: 0xcf4a3c, roughness: 0.5, metalness: 0.04 }),
    carrier: new THREE.MeshStandardMaterial({ color: 0x8aa3b0, roughness: 0.55, metalness: 0.06 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb9c0c6, roughness: 0.28, metalness: 0.95 }),
  };

  // ---- units: explode group (lift) -> motion group (role) -> meshes in assembly coordinates ----
  const V = a => new THREE.Vector3(...a);
  const drive = new THREE.Group(); scene.add(drive);
  const units = {};
  rig.order.forEach((name, i) => {
    const lift = new THREE.Group(), motion = new THREE.Group(), u = rig.units[name];
    // disc pivots sit on the disc centres; everything else turns about the axis
    const pivot = u.role === 'discA' ? V(rig.discA) : u.role === 'discB' ? V(rig.discB) : new THREE.Vector3();
    pivot.y = 0; motion.position.copy(pivot);
    const holder = new THREE.Group(); holder.position.copy(pivot).negate(); motion.add(holder);
    lift.add(motion); drive.add(lift);
    units[name] = { lift, motion, holder, pivot, role: u.role, liftM: u.lift, i, fade: 1, mats: [] };
  });
  // quarter cutaway of the outer shell (two planes, clipped where both cut)
  const SHELL = ['housing', 'top', 'bearingTop'];
  const cutPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 1), new THREE.Plane(new THREE.Vector3(0, 0, 1), 1)];
  function setCut(azimuth, amount) {
    const s = (1 - amount) * 0.08;                                   // plane offset: 0.08 m = closed, 0 = a full quarter open
    [-45, 45].forEach((d, i) => { const a = D2R(azimuth + d); cutPlanes[i].normal.set(-Math.cos(a), 0, -Math.sin(a)); cutPlanes[i].constant = s; });
  }
  const meshes = []; gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    const [unit, kind] = (m.name.includes('__') ? m.name : m.parent?.name || '').split('__');
    const u = units[unit]; if (!u) continue;
    m.updateWorldMatrix(true, false);
    const wm = m.matrixWorld.clone();
    u.holder.add(m); wm.decompose(m.position, m.quaternion, m.scale);
    m.material = (MAT[kind] || MAT.steel).clone(); u.mats.push(m.material);   // per unit, so units can fade alone
    if (SHELL.includes(unit)) { m.material.clippingPlanes = cutPlanes; m.material.clipIntersection = true; m.material.side = THREE.DoubleSide; }
    m.castShadow = true; m.receiveShadow = true;
  }
  const base = new THREE.Box3().setFromObject(drive);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.ShadowMaterial({ opacity: 0.14 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = base.min.y - 0.0005; ground.receiveShadow = true; scene.add(ground);

  const n = rig.order.length, R = rig.ratio;
  const Y = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();
  function setDrive(theta, explode, fades) {
    for (const u of Object.values(units)) {
      // staggered lift, top first: a part starts once everything above it is on its way, and parts higher up
      // travel further in the same time, so every gap only grows (reassembly runs the same curve backwards)
      const S = 0.62, start = S * (n - 1 - u.i) / (n - 1);
      const k = smooth(THREE.MathUtils.clamp((explode - start) / (1 - S), 0, 1));
      u.lift.position.y = u.liftM * k;
      if (u.role === 'input') u.motion.quaternion.setFromAxisAngle(Y, theta);
      else if (u.role === 'output') u.motion.quaternion.setFromAxisAngle(Y, -theta / R);
      else if (u.role === 'discA' || u.role === 'discB') {
        u.motion.position.copy(u.pivot).applyAxisAngle(Y, theta);       // centre orbits at e with the shaft
        u.motion.quaternion.setFromAxisAngle(Y, -theta / R);           // and the disc walks back one lobe per turn
      }
      const f = fades[u.i];
      if (f !== u.fade) {
        u.fade = f; u.lift.visible = f > 0.01;
        for (const m of u.mats) { m.transparent = f < 0.999; m.opacity = f; m.depthWrite = f > 0.5; }
      }
    }
  }


  // ---- callouts (same layout rules as the ARES-4 scene) ----
  const SVG = 'http://www.w3.org/2000/svg';
  const leaders = document.createElementNS(SVG, 'svg'); leaders.classList.add('ares3d-leaders'); labelLayer.appendChild(leaders);
  const anchors = {};
  for (const name of Object.keys(LABELS)) {
    const o = new THREE.Object3D(), u = units[ANCHOR_UNIT[name]];
    o.position.copy(V(name === 'ratio' ? rig.anchors.top : rig.anchors[name]));
    u.lift.add(o);
    const rim = name === 'ratio' ? 0 : name === 'shaft' ? 0.008 : Math.hypot(o.position.x, o.position.z) * 0.95, ly = o.position.y;   // radius of the part's edge
    const el = document.createElement('div');
    el.className = 'ares3d-label' + (name === 'ratio' ? ' big' : '');
    el.innerHTML = `<b>${LABELS[name][0]}</b><span>${LABELS[name][1]}</span>`;
    const g = document.createElementNS(SVG, 'g');
    g.innerHTML = '<polyline/><circle class="halo" r="8"/><circle r="4"/>';
    labelLayer.appendChild(el); leaders.appendChild(g);
    o.userData = { name, el, g, line: g.querySelector('polyline'), dots: g.querySelectorAll('circle'), a: 0, y: null, h: 0, rim, ly, lift: u.lift };
    anchors[name] = o;
  }
  const layout = { row: false, vo: null };

  // ---- state & input ----
  const fixedStep = params.has('qstep') ? Number(params.get('qstep')) : null;
  let active = fixedStep ?? 0;
  const cur = { cam: [...KEYS[active].cam], look: [...KEYS[active].look], camV: [0, 0, 0], lookV: [0, 0, 0], explode: KEYS[active].explode, explodeV: [0], explodeT: [KEYS[active].explode], camT: [...KEYS[active].cam], lookT: [...KEYS[active].look], speed: KEYS[active].speed, cut: KEYS[active].cut,
                fades: rig.order.map(name => KEYS[active].hide.includes(name) ? 0 : 1) };
  let theta = 0, theta0 = 0, orbit = 0;
  const dots = steps.map((s, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', `Step ${i + 1}: ${s.querySelector('h3')?.textContent ?? ''}`);
    b.addEventListener('click', () => s.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    dotsEl?.appendChild(b); return b;
  });
  function setActive(i) {
    if (fixedStep !== null || i < 0 || i === active) return;
    active = i; theta0 = theta;                    // turn counters start from zero on each step
    steps.forEach((s, k) => s.classList.toggle('active', k === i));
    dots.forEach((d, k) => { d.classList.toggle('on', k === i); d.toggleAttribute('aria-current', k === i); });
  }
  // the active step is the one under the middle of the screen, measured every frame (scroll events can be skipped)
  function pickStep() {
    const mid = innerHeight / 2;
    steps.forEach((s, i) => { const r = s.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) setActive(i); });
  }
  steps.forEach((s, k) => s.classList.toggle('active', k === active)); dots[active]?.classList.add('on');

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    layout.row = w / h <= 1.2;           // narrow screens: card below, model above it, compact callouts
    for (const o of Object.values(anchors)) o.userData.h = 0;
    layout.vo = null;
    if (layout.row) { camera.setViewOffset(w, h, 0, h * 0.24, w, h); camera.updateProjectionMatrix(); }
  }
  // wide screens: the model sits in the middle of the space the active card leaves free (cards alternate sides);
  // the callouts find their own spots around it
  function placeView(dt, snap) {
    if (layout.row) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const right = !!steps[active]?.classList.contains('right');
    const pad = Math.max(28, w / 2 - 600), card = Math.min(460, w - 2 * pad);
    const mid = ((right ? (w - pad - card) / 2 : (pad + card + w) / 2) + w / 2) / 2;   // halfway to the centre: room for callouts
    layout.vo = layout.vo == null || snap ? w / 2 - mid : damp(layout.vo, w / 2 - mid, 1.4, dt);
    camera.setViewOffset(w, h, layout.vo, 0, w, h); camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  const v = new THREE.Vector3(), lookV = new THREE.Vector3();
  const camRight = new THREE.Vector3(), toCam = new THREE.Vector3(), rimDir = new THREE.Vector3(), axisV = new THREE.Vector3();
  const hudIn = hud?.querySelector('[data-in]'), hudOut = hud?.querySelector('[data-out]');
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.12, (now - last) / 1000); last = now;
    pickStep();
    let k = KEYS[active];
    if (layout.row && k.phone) k = { ...k, ...k.phone };   // phones: a framing of its own for this step
    const frozen = fixedStep !== null;
    if (params.has('qcam')) { const a = params.get('qcam').split(',').map(Number); k = { ...k, cam: a.slice(0, 3), look: a.slice(3, 6) }; }

    cur.speed = damp(cur.speed, k.speed, 2, dt);
    theta = params.has('qtheta') ? D2R(Number(params.get('qtheta'))) : theta + cur.speed * 2 * Math.PI * dt;
    const ex = params.has('qexplode') ? Number(params.get('qexplode')) : k.explode;
    cur.explode = frozen ? ex : THREE.MathUtils.clamp(glide([cur.explode], cur.explodeV, cur.explodeT, [ex], SPRING_EXPLODE, dt)[0], 0, 1);   // eases in and out, no hard start or stop
    cur.fades = rig.order.map((name, i) => { const t = k.hide.includes(name) ? 0 : 1; return frozen ? t : damp(cur.fades[i], t, 4, dt); });
    setDrive(theta, cur.explode, cur.fades);
    cur.cut = frozen ? k.cut : damp(cur.cut, k.cut, 1.4, dt);

    // camera: orbit around a damped look point; steps with orbit > 0 revolve slowly
    // steps without orbit ease back to the nearest whole turn, so the camera ends where the step frames it
    orbit = frozen ? 0 : k.orbit ? orbit + k.orbit * dt : damp(orbit, Math.round(orbit / 360) * 360, 1.4, dt);
    cur.cam = frozen ? [...k.cam] : glide(cur.cam, cur.camV, cur.camT, k.cam, SPRING_CAM, dt);
    cur.look = frozen ? [...k.look] : glide(cur.look, cur.lookV, cur.lookT, k.look, SPRING_CAM, dt);
    const [az, el, dist] = cur.cam, portrait = camera.aspect < 1 ? 1.8 : 1;
    lookV.set(...cur.look);
    const sway = frozen ? 0 : Math.sin(now / 8000) * 3;   // slow ambient sway; callouts move with their parts
    const A = D2R(az + orbit + sway), E = D2R(el);
    setCut(CUT_AZ, cur.cut);
    camera.position.set(Math.cos(E) * Math.cos(A), Math.sin(E), Math.cos(E) * Math.sin(A)).multiplyScalar(dist * portrait).add(lookV);
    camera.lookAt(lookV);
    placeView(dt, frozen);
    renderer.render(scene, camera);

    // turn counters on the cycloid step: input turns, output turns (1/15 of them)
    if (hud) {
      hud.classList.toggle('on', !!k.hud);
      const turns = (theta - theta0) / (2 * Math.PI);
      hudIn.textContent = turns.toFixed(1); hudOut.textContent = (turns / R).toFixed(2);
    }

    // callouts once the stack has settled
    const settled = Math.abs(cur.explode - k.explode) < 0.08 && Math.abs(cur.cam[2] - k.cam[2]) < 0.05;
    const w = canvas.clientWidth, h = canvas.clientHeight, shown = [];
    const small = layout.row, LW = small ? 124 : 210, sc = h / (small ? 844 : 900), place = PLACE[small ? 'phone' : 'wide'][active] ?? {};
    // each dot sits on its part's rim on the side facing its label (a little towards the camera),
    // so the leader stops at the near edge instead of crossing the model
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
    toCam.subVectors(camera.position, lookV).setY(0).normalize();
    for (const [name, o] of Object.entries(anchors)) {
      const d = o.userData;
      if (d.rim) {
        const side = (place[name] || [60])[0] < 0 ? -1 : 1;
        rimDir.copy(camRight).multiplyScalar(side * 0.8).addScaledVector(toCam, 0.6).normalize();
        d.lift.localToWorld(axisV.set(0, d.ly, 0)).addScaledVector(rimDir, d.rim);
        o.position.copy(d.lift.worldToLocal(axisV));
      }
      o.getWorldPosition(v).project(camera);
      d.ax = (v.x + 1) / 2 * w; d.ay = (1 - v.y) / 2 * h;
      const on = settled && k.labels.includes(name) && v.z < 1;
      d.a = frozen ? (on ? 1 : 0) : damp(d.a, on ? 1 : 0, on ? 6 : 10, dt);
      d.on = on;
      if (d.a > 0.01) shown.push(d); else { d.el.style.opacity = 0; d.g.style.opacity = 0; d.x = d.y = null; }
    }
    // Callouts: each has a set place per step (PLACE), an offset from its part, so it follows the part when that moves
    // (the lifted tool, the turning discs). Offsets are px at a 900 px (phone: 844 px) tall view and scale with it.
    if (params.has('debug')) section.dataset.anchors = JSON.stringify(Object.fromEntries(shown.map(d => [d.name, [Math.round(d.ax), Math.round(d.ay)]])));
    const placed = [];
    for (const d of shown) {
      const a = place[d.name] === false ? 0 : d.a;
      d.el.style.opacity = a; d.g.style.opacity = a;
      if (!d.on) continue;                                    // fading out: stays exactly where it was
      if (!d.h || d.small !== small) {
        d.el.classList.toggle('compact', small); d.el.style.width = LW + 'px';
        d.h = d.el.offsetHeight; d.bh = d.el.firstChild.offsetHeight; d.small = small;
      }
      let [ox, oy] = (place[d.name] || [60, -40]).map(t => t * sc); const flip = ox < 0;
      // phones: the callout docks against its screen edge (PLACE only picks the side and height), so it never runs off screen
      if (small) ox = flip ? 10 + LW - d.ax : w - 10 - LW - d.ax;
      placed.push({ d, ox, flip, y: d.ay + oy - d.bh / 2 });          // the leader meets the middle of the title
    }
    // phones: docked callouts on one side share a column, so a lower one moves down clear of the one above
    if (small) for (const side of [true, false]) {
      const col = placed.filter(p => p.flip === side).sort((p, q) => p.y - q.y);
      for (let i = 1; i < col.length; i++) col[i].y = Math.max(col[i].y, col[i - 1].y + col[i - 1].d.h + 10);
    }
    for (const { d, ox, flip, y } of placed) {
      const x = d.ax + ox - (flip ? LW : 0), ly = y + d.bh / 2;
      d.el.classList.toggle('flip', flip);
      d.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      d.line.setAttribute('points', `${d.ax.toFixed(1)},${d.ay.toFixed(1)} ${(d.ax + ox + (flip ? 6 : -6)).toFixed(1)},${ly.toFixed(1)}`);
      for (const c of d.dots) { c.setAttribute('cx', d.ax.toFixed(1)); c.setAttribute('cy', d.ay.toFixed(1)); }
    }
  }

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { rootMargin: '200px' }).observe(section);
  function loop(now) { if (visible) frame(now); requestAnimationFrame(loop); }
  section.classList.add('ares3d-ready');
  requestAnimationFrame(loop);
}

// Load three.js work only when the section is about 1.5 screens away, so it doesn't compete with the page above.
// Phones sometimes refuse a WebGL context for a moment (the other 3D scene still loading, memory pressure), so the
// scenes on the page start one at a time, and a failed start is cleaned up and tried again with longer pauses
// before falling back to the still and the cards. ?debug shows why it fell back.
function fail(err) {
  console.error(err);
  if (!section) return;
  section.classList.add('ares3d-static');
  if (params.has('debug')) { const p = document.createElement('p'); p.style.color = '#c0392b'; p.textContent = '3D failed: ' + (err?.message || err); section.prepend(p); }
}
function teardown() {                                       // release the failed context and start over on a fresh canvas
  if (live) { try { live.dispose(); live.forceContextLoss(); } catch {} live = null; }
  const fresh = canvas.cloneNode(); canvas.replaceWith(fresh); canvas = fresh;
}
const RETRY = [700, 1800, 4000];                            // ms before each further try
const queue = fn => (window.__start3d = (window.__start3d || Promise.resolve()).then(fn, fn));
const start = (n = 0) => queue(init).catch(err => {
  teardown();
  if (n >= RETRY.length) return fail(err);
  console.warn('3D start failed, retrying', err);
  setTimeout(() => start(n + 1), RETRY[n]);
});
if (section && 'IntersectionObserver' in window) {
  const near = new IntersectionObserver(([e]) => { if (e.isIntersecting) { near.disconnect(); start(); } }, { rootMargin: '150% 0px' });
  near.observe(section);
} else start();
