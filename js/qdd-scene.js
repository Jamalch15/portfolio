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
const canvas = section?.querySelector('canvas');
const labelLayer = section?.querySelector('.ares3d-labels');
const dotsEl = section?.querySelector('.ares3d-dots');
const hud = section?.querySelector('.qdd-hud');
const steps = [...(section?.querySelectorAll('.ares3d-step') ?? [])];
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Per step: camera [azimuth, elevation deg, distance m], look-at, explode 0..1, input speed (turns/s),
// orbit speed (deg/s), units faded out, quarter cutaway of the shell (0..1), callouts.
const KEYS = [
  { cam: [38, 30, 0.40], look: [0, 0.016, 0], explode: 0, speed: 0.45, orbit: 0, hide: [], cut: 1, labels: [] },
  { cam: [38, 16, 0.74], look: [0, 0.122, 0], explode: 1, speed: 0.12, orbit: 0, hide: [], cut: 0, labels: ['housing', 'shaft', 'discs', 'output'] },
  { cam: [24, 64, 0.38], look: [0, 0.006, 0], explode: 0, speed: 0.55, orbit: 0, hide: ['top', 'bearingTop', 'carrier', 'bearingOut', 'outputHub'], cut: 0, labels: ['discs'], hud: true },
  { cam: [62, 22, 0.44], look: [0, 0.016, 0], explode: 0, speed: 0.3, orbit: 0, hide: [], cut: 1, labels: ['ratio'] },
];
const LABELS = {
  housing: ['Printed housing', 'The discs roll directly on its lobed profile: no ring pins'],
  shaft: ['Eccentric shaft', 'Three pieces clamped with M3 screws; 2 mm offset'],
  discs: ['Two cycloidal discs', '15 lobes each, 180° apart, on 6803 bearings'],
  output: ['Output', 'Pins through the discs drive the carrier, on 6805 and 61806 bearings'],
  ratio: ['15 : 1', 'reduction, inside the 12–16:1 target'],
};
const CUT_AZ = 42;                        // the cutaway faces this azimuth (deg) and never moves
const EXPLODE_S = 3;                      // seconds for the full explode or reassembly
const ANCHOR_UNIT = { housing: 'housing', shaft: 'discHub', discs: 'discA', output: 'carrier', ratio: 'carrier' };

const D2R = THREE.MathUtils.degToRad;
const damp = (x, target, lambda, dt) => x + (target - x) * (1 - Math.exp(-lambda * dt));
const smooth = t => t * t * (3 - 2 * t);
function webglOK() { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } }

async function init() {
  if (!section || !canvas) return;
  if (!webglOK() || reduced) { section.classList.add('ares3d-static'); return; }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const phone = innerWidth < 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.5 : 2));    // lighter on phones
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
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

  // a sparse point cloud of the model: callouts sit just past its silhouette, at their own height
  const cloud = [];
  {
    let total = 0; drive.traverse(m => { if (m.isMesh) total += m.geometry.attributes.position.count; });
    const every = Math.max(1, Math.floor(total / 900));
    drive.traverse(m => {
      if (!m.isMesh) return; const pos = m.geometry.attributes.position;
      for (let k = 0; k < pos.count; k += every) cloud.push([m, new THREE.Vector3().fromBufferAttribute(pos, k)]);
    });
  }
  const cloudX = new Float32Array(cloud.length), cloudY = new Float32Array(cloud.length);

  // ---- callouts (same layout rules as the ARES-4 scene) ----
  const SVG = 'http://www.w3.org/2000/svg';
  const leaders = document.createElementNS(SVG, 'svg'); leaders.classList.add('ares3d-leaders'); labelLayer.appendChild(leaders);
  const anchors = {};
  for (const name of Object.keys(LABELS)) {
    const o = new THREE.Object3D(), u = units[ANCHOR_UNIT[name]];
    o.position.copy(V(name === 'ratio' ? rig.anchors.top : rig.anchors[name]));
    u.lift.add(o);
    const el = document.createElement('div');
    el.className = 'ares3d-label' + (name === 'ratio' ? ' big' : '');
    el.innerHTML = `<b>${LABELS[name][0]}</b><span>${LABELS[name][1]}</span>`;
    const g = document.createElementNS(SVG, 'g');
    g.innerHTML = '<polyline/><circle class="halo" r="8"/><circle r="4"/><text class="n" text-anchor="middle" dy="3.6"></text>';
    labelLayer.appendChild(el); leaders.appendChild(g);
    o.userData = { el, g, line: g.querySelector('polyline'), dots: g.querySelectorAll('circle'), num: g.querySelector('text'), a: 0, y: null, h: 0 };
    anchors[name] = o;
  }
  const layout = { row: false, colX: 0, colW: 0, yMin: 0, yMax: 0 };

  // ---- state & input ----
  const fixedStep = params.has('qstep') ? Number(params.get('qstep')) : null;
  let active = fixedStep ?? 0;
  const cur = { cam: [...KEYS[active].cam], look: [...KEYS[active].look], explode: KEYS[active].explode, speed: KEYS[active].speed, cut: KEYS[active].cut,
                fades: rig.order.map(name => KEYS[active].hide.includes(name) ? 0 : 1) };
  let theta = 0, theta0 = 0, orbit = 0, drag = 0, dragVel = 0, dragging = false, lastX = 0;
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
  canvas.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => { if (!dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; drag += dx * 0.25; dragVel = dx * 0.25; });
  canvas.addEventListener('pointerup', () => { dragging = false; });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    const wide = w / h > 1.2;
    layout.row = !wide;
    layout.colW = Math.min(250, w * 0.2);
    layout.colX = w - layout.colW - 60;
    [layout.yMin, layout.yMax] = [h * 0.14, h * 0.86];
    for (const o of Object.values(anchors)) { o.userData.el.style.width = wide ? '220px' : ''; o.userData.h = 0; }
    layout.vo = null;                    // wide: placeView() places the model every frame
    if (!wide) { camera.setViewOffset(w, h, 0, h * 0.15, w, h); camera.updateProjectionMatrix(); }
  }
  // the active card's side (cards alternate) decides where the model sits; callouts take the other side
  function placeView(dt, snap) {
    if (layout.row) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const right = !!steps[active]?.classList.contains('right');
    const pad = Math.max(28, w / 2 - 600), card = Math.min(460, w - 2 * pad);
    layout.flip = right;
    layout.colX = right ? 60 : w - layout.colW - 60;
    const mid = right ? (layout.colW + 110 + w - pad - card - 30) / 2 : (pad + card + 30 + layout.colX - 50) / 2;
    layout.vo = layout.vo == null || snap ? w / 2 - mid : damp(layout.vo, w / 2 - mid, 2.4, dt);
    camera.setViewOffset(w, h, layout.vo, 0, w, h); camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  const v = new THREE.Vector3(), lookV = new THREE.Vector3();
  const hudIn = hud?.querySelector('[data-in]'), hudOut = hud?.querySelector('[data-out]');
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.12, (now - last) / 1000); last = now;
    pickStep();
    let k = KEYS[active];
    const frozen = fixedStep !== null;
    if (params.has('qcam')) { const a = params.get('qcam').split(',').map(Number); k = { ...k, cam: a.slice(0, 3), look: a.slice(3, 6) }; }

    cur.speed = damp(cur.speed, k.speed, 2, dt);
    theta = params.has('qtheta') ? D2R(Number(params.get('qtheta'))) : theta + cur.speed * 2 * Math.PI * dt;
    const ex = params.has('qexplode') ? Number(params.get('qexplode')) : k.explode;
    cur.explode = frozen ? ex : cur.explode + THREE.MathUtils.clamp(ex - cur.explode, -dt / EXPLODE_S, dt / EXPLODE_S);
    cur.fades = rig.order.map((name, i) => { const t = k.hide.includes(name) ? 0 : 1; return frozen ? t : damp(cur.fades[i], t, 4, dt); });
    setDrive(theta, cur.explode, cur.fades);
    cur.cut = frozen ? k.cut : damp(cur.cut, k.cut, 2.4, dt);

    // camera: orbit around a damped look point; steps with orbit > 0 revolve slowly; drag adds azimuth and eases back
    // steps without orbit ease back to the nearest whole turn, so the camera ends where the step frames it
    orbit = frozen ? 0 : k.orbit ? orbit + k.orbit * dt : damp(orbit, Math.round(orbit / 360) * 360, 1.4, dt);
    cur.cam = cur.cam.map((x, i) => frozen ? k.cam[i] : damp(x, k.cam[i], 2.4, dt));
    cur.look = cur.look.map((x, i) => frozen ? k.look[i] : damp(x, k.look[i], 2.4, dt));
    if (!dragging) { dragVel *= Math.exp(-6 * dt); drag = damp(drag + dragVel, 0, 0.6, dt); }
    const [az, el, dist] = cur.cam, portrait = camera.aspect < 1 ? 2.25 : 1;
    lookV.set(...cur.look);
    const A = D2R(az + orbit + drag), E = D2R(el);
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
    const settled = Math.abs(cur.explode - k.explode) < 0.04 && Math.abs(cur.cam[2] - k.cam[2]) < 0.04;
    const w = canvas.clientWidth, h = canvas.clientHeight, shown = [];
    for (const [name, o] of Object.entries(anchors)) {
      const d = o.userData;
      o.getWorldPosition(v).project(camera);
      d.ax = (v.x + 1) / 2 * w; d.ay = (1 - v.y) / 2 * h;
      const on = settled && k.labels.includes(name) && v.z < 1;
      d.a = frozen ? (on ? 1 : 0) : damp(d.a, on ? 1 : 0, on ? 6 : 10, dt);
      d.on = on;
      if (d.a > 0.01) shown.push(d); else { d.el.style.opacity = 0; d.g.style.opacity = 0; d.x = d.y = null; }
    }
    if (layout.row) {
      // narrow: one row along the top, in the anchors' left-to-right order; leaders drop to the parts
      const live = shown.filter(d => d.on).sort((p, q) => p.ax - q.ax);
      const x0 = 16, cw = (w - x0 - 12) / Math.max(1, live.length), top = k.hud ? 64 : 58;
      for (const d of shown) { d.el.style.opacity = d.a; d.g.style.opacity = d.a; }   // fading ones stay where they were
      live.forEach((d, i) => {
        d.el.classList.toggle('compact', live.length > 3);   // four in a row: titles only
        // phones: a numbered dot on the part and the same number on its label, no leader lines to cross
        d.el.style.width = (cw - 12) + 'px';
        d.el.firstChild.dataset.n = i + 1; d.num.textContent = i + 1;
        d.el.classList.remove('flip');
        d.el.style.transform = `translate(${(x0 + i * cw).toFixed(1)}px, ${top}px)`;
        d.line.setAttribute('points', '');
        d.dots[0].setAttribute('r', 13); d.dots[1].setAttribute('r', 9);
        for (const c of d.dots) { c.setAttribute('cx', d.ax.toFixed(1)); c.setAttribute('cy', d.ay.toFixed(1)); }
        d.num.setAttribute('x', d.ax.toFixed(1)); d.num.setAttribute('y', d.ay.toFixed(1));
      });
      return;
    }
    // wide: callouts go on the side away from the card, each just past the model's silhouette at its own height
    // (from a sparse point cloud of the model), so text never covers the model or the card; callouts on the same
    // side are then nudged apart. Fading callouts stay put, so nothing jumps as it fades.
    const live = shown.filter(d => d.on), LW = 220, GAP = 14, side = layout.flip ? -1 : 1;
    if (live.length) {
      const vis = new Map();
      for (let i = 0; i < cloud.length; i++) {
        const m = cloud[i][0];
        if (!vis.has(m)) { let o = m, ok = true; for (; o; o = o.parent) if (!o.visible) { ok = false; break; } vis.set(m, ok); }
        if (!vis.get(m)) { cloudX[i] = NaN; continue; }
        v.copy(cloud[i][1]).applyMatrix4(m.matrixWorld).project(camera); cloudX[i] = (v.x + 1) / 2 * w; cloudY[i] = (1 - v.y) / 2 * h;
      }
    }
    for (const d of live) {
      if (!d.h) { d.el.style.width = LW + 'px'; d.h = d.el.offsetHeight; d.mid = d.el.firstChild.offsetHeight / 2; }
      let edge = d.ax;
      for (let i = 0; i < cloud.length; i++) {
        if (Math.abs(cloudY[i] - d.ay) < 46) edge = side > 0 ? Math.max(edge, cloudX[i]) : Math.min(edge, cloudX[i]);
      }
      d.side = side;
      d.tx = THREE.MathUtils.clamp(side > 0 ? edge + 24 : edge - 24 - LW, 16, w - 40 - LW);
      d.ty = d.ay - d.mid;
    }
    for (const s of [-1, 1]) {           // no overlaps within a side: push down in order, then back up if off-screen
      const col = live.filter(d => d.side === s).sort((p, q) => p.ty - q.ty);
      let prev = -Infinity;
      for (const d of col) { d.ty = Math.max(d.ty, prev + GAP, h * 0.08); prev = d.ty + d.h; }
      let next = h * 0.94;
      for (let i = col.length - 1; i >= 0; i--) { const d = col[i]; d.ty = Math.min(d.ty, next - d.h); next = d.ty - GAP; }
    }
    for (const d of shown) {
      d.el.style.opacity = d.a; d.g.style.opacity = d.a;
      if (!d.on) continue;
      const snap = d.x == null || frozen;
      d.x = snap ? d.tx : damp(d.x, d.tx, 8, dt); d.y = snap ? d.ty : damp(d.y, d.ty, 8, dt);
      const ly = d.y + d.mid, ex = d.side > 0 ? d.x - 8 : d.x + LW + 8, kx = ex - d.side * 16;
      d.el.classList.toggle('flip', d.side < 0);
      if (d.el.firstChild.dataset.n) { delete d.el.firstChild.dataset.n; d.num.textContent = ''; d.dots[0].setAttribute('r', 8); d.dots[1].setAttribute('r', 4); }
      d.el.style.transform = `translate(${d.x.toFixed(1)}px, ${d.y.toFixed(1)}px)`;
      d.line.setAttribute('points', `${d.ax.toFixed(1)},${d.ay.toFixed(1)} ${kx.toFixed(1)},${ly.toFixed(1)} ${ex.toFixed(1)},${ly.toFixed(1)}`);
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
const start = () => init().catch(err => { console.error(err); section?.classList.add('ares3d-static'); });
if (section && 'IntersectionObserver' in window) {
  const near = new IntersectionObserver(([e]) => { if (e.isIntersecting) { near.disconnect(); start(); } }, { rootMargin: '150% 0px' });
  near.observe(section);
} else start();
