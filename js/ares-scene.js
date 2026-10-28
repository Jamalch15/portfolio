// ARES-4 scroll scene. The arm is Jamal's SolidWorks assembly (exported read-only, see portfolio/tools).
// The *active step* (the text block in the middle of the screen) sets a target; pose and camera glide to it
// with critically damped smoothing, so scroll speed, flicks and jumps never produce jerky motion.
// Step 4 plays the quick-swap (twist, lift off, show the pogo pins, refit, lock); step 5 plays a slow
// pick-and-place in which the gripper's real parallelogram linkage opens and closes the jaws.
// Debug: ?step=n (frozen, settled), ?t=s (timeline time), ?pose=a,b,c,d (deg), ?jaw=deg, ?swap=0..1, ?cam=x,y,z&look=x,y,z.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const section = document.querySelector('[data-ares3d]');
const canvas = section?.querySelector('canvas');
const labelLayer = section?.querySelector('.ares3d-labels');
const dotsEl = section?.querySelector('.ares3d-dots');
const steps = [...(section?.querySelectorAll('.ares3d-step') ?? [])];
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Poses: [base yaw, shoulder, elbow, wrist] in degrees; 0 = straight up.
const DESIGN = [-30, 35, 55, 0];          // pose of assembly drawing ARES-Arm-001: forearm and tool level
const TOOL_UP = [-30, 12, 30, -42];        // tool pointing straight up, for the quick-swap
// Camera per step: azimuth, elevation (deg), distance (m), look-at point (m).
const KEYS = [
  { pose: DESIGN,            cam: [150, 14, 1.24], look: [-0.10, 0.23, 0.0], labels: [] },
  { pose: [-30, 20, 40, 30], cam: [10, 12, 0.78], look: [-0.02, 0.11, 0.0], labels: ['base', 'shoulder', 'encoder'] },
  { pose: DESIGN,            cam: [110, 12, 1.05], look: [-0.14, 0.28, 0.0], labels: ['elbow', 'wrist'] },
  { pose: TOOL_UP,           cam: [62, 14, 0.62], look: 'ring', labels: ['quickswap', 'pogo'], swap: true },
  { pose: DESIGN,            cam: [170, 26, 1.38], look: [0.03, 0.17, 0.0], labels: ['result'], pick: true },
];
const LABELS = {
  base: ['Base yaw', 'PG5 geared stepper turns the whole arm'],
  shoulder: ['Shoulder', '27:1 geared stepper · ~4 Nm needed, ~7 Nm peak'],
  encoder: ['Encoder', 'AS5048A checks the real shoulder angle'],
  elbow: ['Elbow', 'DS3240 servo · light, so mass stays off the arm'],
  wrist: ['Wrist', 'DS3240 servo sets the tool angle'],
  quickswap: ['Quick-swap', 'Twist to unlock · lift off · refit · lock'],
  pogo: ['Pogo connector', 'Mounted sideways, so the locking twist presses the contacts together'],
  result: ['48 / 50', 'bricks picked and sorted in the final test'],
};
const ANCHOR_LINK = { base: 'base', shoulder: 'j1', encoder: 'j1', elbow: 'j2', wrist: 'j3', quickswap: 'j4', pogo: 'j4' };
const PICK_AT = [-0.10, 0.20], PLACE_AT = [0.13, -0.19];
const BRICK = [0.032, 0.019, 0.016];       // red test brick (m); the jaws close across its 16 mm side
const TRAY_FLOOR = 0.003;

const D2R = THREE.MathUtils.degToRad;
const damp = (x, target, lambda, dt) => x + (target - x) * (1 - Math.exp(-lambda * dt));
// critically damped spring: eases in and out between steps (no snap at the start, no overshoot); v holds velocities
const spring = (xs, vs, targets, w, dt) => xs.map((x, i) => { vs[i] += (w * w * (targets[i] - x) - 2 * w * vs[i]) * dt; return x + vs[i] * dt; });

// points spread evenly over a model's surfaces (by area, so big flat faces count as much as detailed ones);
// callouts look for a spot with none of them underneath
function surfacePoints(root, N) {
  const pts = [], A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const each = fn => root.traverse(m => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position, idx = m.geometry.index, n = (idx ? idx.count : pos.count) / 3, s2 = m.matrixWorld.getMaxScaleOnAxis() ** 2;
    const at = j => idx ? idx.getX(j) : j;
    for (let t = 0; t < n; t++) {
      A.fromBufferAttribute(pos, at(3 * t)); B.fromBufferAttribute(pos, at(3 * t + 1)); C.fromBufferAttribute(pos, at(3 * t + 2));
      fn(m, e1.subVectors(B, A).cross(e2.subVectors(C, A)).length() / 2 * s2);
    }
  });
  let total = 0; each((m, a) => { total += a; });
  const step = total / N; let acc = step / 2;
  each((m, a) => {
    for (acc -= a; acc < 0; acc += step) {
      let u = Math.random(), w = Math.random(); if (u + w > 1) { u = 1 - u; w = 1 - w; }
      pts.push([m, A.clone().addScaledVector(e1.subVectors(B, A), u).addScaledVector(e2.subVectors(C, A), w)]);
    }
  });
  return pts;
}
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function webglOK() { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } }

// A timeline is a list of [duration s, values]; sample(t) eases between consecutive values.
function timeline(keys) {
  const total = keys.reduce((s, k) => s + k[0], 0);
  return { total, sample(t) {
    t = ((t % total) + total) % total;
    for (let i = 0; i < keys.length; i++) {
      const [d, v] = keys[i], next = keys[(i + 1) % keys.length][1];
      if (t <= d) return { v: mix(v, next, ease(d ? t / d : 1)), i };
      t -= d;
    }
    return { v: keys[0][1], i: 0 };
  } };
}

async function init() {
  if (!section || !canvas) return;
  if (!webglOK() || reduced) { section.classList.add('ares3d-static'); return; }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const phone = innerWidth < 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.5 : 2));    // lighter on phones
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
  const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(0.8, 1.6, 1.0);
  key.castShadow = true; key.shadow.mapSize.set(phone ? 1024 : 2048, phone ? 1024 : 2048); key.shadow.bias = -0.0004;
  Object.assign(key.shadow.camera, { left: -0.5, right: 0.5, top: 0.5, bottom: -0.5, near: 0.1, far: 4 });
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9cc3d6, 2.4); rim.position.set(-1.4, 1.0, -1.2); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xd5e2e9, 0x0b1a21, 0.55));

  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const [rig, gltf] = await Promise.all([
    fetch('assets/3d/ares4-rig.json').then(r => r.json()),
    loader.loadAsync('assets/3d/ares4.glb'),
  ]);

  const MAT = {
    printed: new THREE.MeshStandardMaterial({ color: 0x24292e, roughness: 0.62, metalness: 0.04 }),
    knurl: new THREE.MeshStandardMaterial({ color: 0x1b1f23, roughness: 0.7, metalness: 0.04 }),
    alu: new THREE.MeshStandardMaterial({ color: 0xc7ced4, roughness: 0.3, metalness: 0.9 }),
    motor: new THREE.MeshStandardMaterial({ color: 0x2c3136, roughness: 0.4, metalness: 0.5 }),
    servo: new THREE.MeshStandardMaterial({ color: 0x8d959c, roughness: 0.48, metalness: 0.3 }),
    microservo: new THREE.MeshStandardMaterial({ color: 0x2a62b8, roughness: 0.5, metalness: 0.05 }),
    white: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa4aab0, roughness: 0.28, metalness: 0.95 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xd4a537, roughness: 0.25, metalness: 0.95 }),
    copper: new THREE.MeshStandardMaterial({ color: 0xc8743d, roughness: 0.3, metalness: 0.95 }),
    pogo: new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.35, metalness: 0.1 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe0b44a, roughness: 0.2, metalness: 1.0 }),
    magnet: new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.25, metalness: 0.95 }),
  };

  // ---- kinematic chain: base -> j1..j4, then the tool (quick-swap side) and its linkage ----
  const V = a => new THREE.Vector3(...a);
  const world = new THREE.Group();
  const links = { base: world }, pivots = { base: new THREE.Vector3() };
  let parent = world, parentPivot = new THREE.Vector3();
  for (const j of ['j1', 'j2', 'j3', 'j4']) {
    const g = new THREE.Group(), p = V(rig.pivots[j]);
    g.position.copy(p).sub(parentPivot); g.userData.axis = V(rig.axes[j]).normalize();
    parent.add(g); links[j] = g; pivots[j] = p; parent = g; parentPivot = p;
  }
  const toolPivot = V(rig.tool.center);
  const tool = new THREE.Group(); tool.position.copy(toolPivot).sub(pivots.j4); links.j4.add(tool);
  links.tool = tool; pivots.tool = toolPivot;
  const gr = rig.grip, GA = V(gr.axis).normalize();
  for (const [name, at] of [['toolgearR', gr.gearR], ['toolgearL', gr.gearL], ['toolupR', gr.upR], ['toolupL', gr.upL],
                            ['toolpinion', gr.pinion], ['toolfingerR', gr.gearR], ['toolfingerL', gr.gearL]]) {
    const g = new THREE.Group(), p = V(at);
    g.position.copy(p).sub(toolPivot); tool.add(g); links[name] = g; pivots[name] = p;
  }
  const meshes = []; gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    // three.js strips ':' etc. from node names, so 'tool:gearR__printed' arrives as 'toolgearR__printed'
    const tag = (m.name.includes('__') ? m.name : m.parent?.name || '').split('__');
    const link = tag[0].replace(/[^A-Za-z0-9]/g, '') in links ? tag[0].replace(/[^A-Za-z0-9]/g, '') : 'base';
    m.updateWorldMatrix(true, false);
    const wm = m.matrixWorld.clone();
    links[link].add(m);
    wm.decompose(m.position, m.quaternion, m.scale);
    m.position.sub(pivots[link]);
    m.material = MAT[tag[1]] || MAT.printed;
    m.castShadow = true; m.receiveShadow = true;
  }
  const box = new THREE.Box3().setFromObject(world);
  world.position.set(-pivots.j1.x, -box.min.y, -pivots.j1.z);
  scene.add(world);

  // Parallelogram jaws: gears + driven links and the idler links turn by the same angle; each finger
  // translates (no rotation) along the arc its lower pivot makes around the gear centre.
  const fpR = V(gr.fingerPivotR), fpL = V(gr.fingerPivotL), cR = V(gr.gearR), cL = V(gr.gearL);
  const q = new THREE.Quaternion(), tmp = new THREE.Vector3();
  function setJaw(deg) {
    const aR = D2R(deg) * gr.closeR, aL = D2R(deg) * gr.closeL;
    links['toolgearR'].quaternion.setFromAxisAngle(GA, aR); links['toolupR'].quaternion.setFromAxisAngle(GA, aR);
    links['toolgearL'].quaternion.setFromAxisAngle(GA, aL); links['toolupL'].quaternion.setFromAxisAngle(GA, aL);
    links['toolpinion'].quaternion.setFromAxisAngle(GA, -aR * 1.3);
    q.setFromAxisAngle(GA, aR); tmp.copy(fpR).sub(cR).applyQuaternion(q).add(cR).sub(fpR);
    links['toolfingerR'].position.copy(cR).sub(toolPivot).add(tmp);
    q.setFromAxisAngle(GA, aL); tmp.copy(fpL).sub(cL).applyQuaternion(q).add(cL).sub(fpL);
    links['toolfingerL'].position.copy(cL).sub(toolPivot).add(tmp);
  }
  function setSwap(twistDeg, lift) {
    tool.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), D2R(twistDeg));
    tool.position.copy(toolPivot).sub(pivots.j4).add(new THREE.Vector3(0, lift, 0));
  }

  // ---- table, bricks and an open sorting tray ----
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.012, 96),
    new THREE.MeshStandardMaterial({ color: 0x1b3542, roughness: 0.92 }));
  table.position.y = -0.006; table.receiveShadow = true; scene.add(table);
  const brick = c => { const b = new THREE.Mesh(new THREE.BoxGeometry(...BRICK), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 })); b.castShadow = true; b.receiveShadow = true; return b; };
  const carried = brick(0xd8342c); scene.add(carried);
  for (const [c, x, z, r] of [[0x2f6fd6, -0.17, 0.14, -0.2], [0xf2c230, -0.03, 0.26, 1.1]]) { const b = brick(c); b.position.set(x, BRICK[1] / 2, z); b.rotation.y = r; scene.add(b); }
  const tray = new THREE.Group(), trayMat = new THREE.MeshStandardMaterial({ color: 0x3f8f6b, roughness: 0.6 });
  for (const [sx, sy, sz, x, y, z] of [[0.09, TRAY_FLOOR, 0.09, 0, TRAY_FLOOR / 2, 0],
    [0.09, 0.024, 0.003, 0, 0.012, 0.0435], [0.09, 0.024, 0.003, 0, 0.012, -0.0435],
    [0.003, 0.024, 0.084, 0.0435, 0.012, 0], [0.003, 0.024, 0.084, -0.0435, 0.012, 0]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), trayMat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; tray.add(m);
  }
  tray.position.set(PLACE_AT[0], 0, PLACE_AT[1]); scene.add(tray);

  // ---- planar IK (real link lengths): tool straight down over a table point ----
  const lift = -box.min.y;
  const L2 = pivots.j3.distanceTo(pivots.j2), L3 = pivots.j4.distanceTo(pivots.j3);
  const tipY = rig.anchors.tip[1], Ltool = tipY - pivots.j4.y - 0.012, yShoulder = pivots.j2.y + lift;
  function ik(x, z, h) {
    const yaw = Math.atan2(z, -x), d = Math.hypot(x, z), e = h + Ltool - yShoulder;
    const c3 = THREE.MathUtils.clamp((d * d + e * e - L2 * L2 - L3 * L3) / (2 * L2 * L3), -1, 1);
    const t3 = Math.acos(c3), t2 = Math.atan2(d, e) - Math.atan2(L3 * Math.sin(t3), L2 + L3 * Math.cos(t3));
    return [yaw, t2, t3, Math.PI - t2 - t3].map(THREE.MathUtils.radToDeg);
  }
  function applyPose(p) { ['j1', 'j2', 'j3', 'j4'].forEach((j, i) => links[j].quaternion.setFromAxisAngle(links[j].userData.axis, D2R(p[i]))); }

  // ---- grip, measured on the model: the fingertips' inner faces close onto the brick's 16 mm sides ----
  const tipVerts = side => {             // world positions of the lowest 8 mm of one finger
    const pts = [], p = new THREE.Vector3(); let minY = Infinity;
    links['toolfinger' + side].traverse(m => {
      if (!m.isMesh) return; const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); pts.push(p.clone()); minY = Math.min(minY, p.y); }
    });
    return { pts: pts.filter(q => q.y < minY + 0.008), minY };
  };
  function jaws(pose, deg) {             // inner gap, closing direction, centre between the tips, tip height
    applyPose(pose); setJaw(deg); world.updateMatrixWorld(true);
    const R = tipVerts('R'), L = tipVerts('L'), avg = a => a.reduce((s, q) => s.add(q), new THREE.Vector3()).divideScalar(a.length);
    const cRw = avg(R.pts), cLw = avg(L.pts), u = cRw.clone().sub(cLw).setY(0).normalize();
    let rIn = Infinity, lIn = -Infinity;
    for (const q of R.pts) rIn = Math.min(rIn, q.dot(u));
    for (const q of L.pts) lIn = Math.max(lIn, q.dot(u));
    const c = cRw.add(cLw).multiplyScalar(0.5);
    return { gap: rIn - lIn, u, mid: c.addScaledVector(u, (rIn + lIn) / 2 - c.dot(u)), minY: Math.min(R.minY, L.minY) };
  }
  function solveJaw(pose, gap) {         // bisection: positive angles close the jaws
    let lo = -40, hi = 60;
    for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (jaws(pose, m).gap > gap) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  // fingertips 5 mm above the table, so they hold the brick across its middle; jaws touch its sides
  let atPick = ik(...PICK_AT, 0.012);
  const JAW_GRIP = solveJaw(atPick, BRICK[2] + 0.0003), JAW_OPEN = solveJaw(atPick, BRICK[2] + 0.014);
  const hPick = 0.012 + (0.005 - jaws(atPick, JAW_GRIP).minY);
  atPick = ik(...PICK_AT, hPick);
  const gripAt = jaws(atPick, JAW_GRIP);
  const brickHome = [gripAt.mid.x, BRICK[1] / 2, gripAt.mid.z], brickYaw = Math.atan2(gripAt.u.x, gripAt.u.z);
  const abovePick = ik(...PICK_AT, hPick + 0.09), abovePlace = ik(...PLACE_AT, hPick + 0.09);
  const atPlace = ik(...PLACE_AT, hPick + TRAY_FLOOR + 0.003);      // brick bottom just above the tray floor
  const dropAt = jaws(atPlace, JAW_GRIP).mid; tray.position.set(dropAt.x, 0, dropAt.z);
  carried.position.set(...brickHome); carried.rotation.set(0, brickYaw, 0);
  applyPose(atPick); world.updateMatrixWorld(true); carried.updateMatrixWorld(true);   // brick in the closed jaws, in the tool's frame
  const inJaws = new THREE.Matrix4().copy(tool.matrixWorld).invert().multiply(carried.matrixWorld);
  setJaw(0); applyPose(KEYS[0].pose); world.updateMatrixWorld(true);

  // [seconds, [j1, j2, j3, j4, jaw]]: reach, descend, grip, lift, carry, lower, release, rise, home, short rest
  const P = (pose, jaw) => [...pose, jaw];
  const PICK = timeline([
    [2.2, P(DESIGN, 0)], [1.3, P(abovePick, JAW_OPEN)], [0.8, P(atPick, JAW_OPEN)], [1.2, P(atPick, JAW_GRIP)],
    [2.6, P(abovePick, JAW_GRIP)], [1.3, P(abovePlace, JAW_GRIP)], [0.8, P(atPlace, JAW_GRIP)], [1.1, P(atPlace, JAW_OPEN)],
    [2.2, P(abovePlace, JAW_OPEN)], [1.2, P(DESIGN, 0)],
  ]);
  const HOLD_I = 3, RELEASE_I = 6;      // segment indices: held from the lift (3) until the jaws open (6)
  // [seconds, [twist deg, lift m]]: locked, twist to unlock, lift off, hold, lower, twist to lock
  // segment i runs from key i to key i+1: twist, lift, hold off, lower, twist to lock, a short rest locked
  const SWAP = timeline([[0.9, [0, 0]], [0.9, [rig.tool.twist_deg, 0]], [1.4, [rig.tool.twist_deg, 0.055]],
                         [1.1, [rig.tool.twist_deg, 0.055]], [0.9, [rig.tool.twist_deg, 0]], [0.35, [0, 0]]]);
  if (params.has('debug')) console.log('grip', { JAW_GRIP, JAW_OPEN, gapOpen: jaws(atPick, JAW_OPEN).gap, hPick, brickHome });
  setJaw(0); applyPose(KEYS[0].pose); world.updateMatrixWorld(true);

  const cloud = [...surfacePoints(world, 1800), ...surfacePoints(tray, 120)];
  const cloudX = new Float32Array(cloud.length), cloudY = new Float32Array(cloud.length);

  // ---- callouts: text beside the model, tied to each part by a leader line ----
  const SVG = 'http://www.w3.org/2000/svg';
  const leaders = document.createElementNS(SVG, 'svg'); leaders.classList.add('ares3d-leaders'); labelLayer.appendChild(leaders);
  const anchors = {};
  for (const name of Object.keys(LABELS)) {
    const o = new THREE.Object3D();
    if (name === 'result') { o.position.set(tray.position.x, 0.026, tray.position.z); scene.add(o); }
    else { const l = ANCHOR_LINK[name]; o.position.copy(V(rig.anchors[name])).sub(pivots[l]); links[l].add(o); }
    const el = document.createElement('div');
    el.className = 'ares3d-label' + (name === 'result' ? ' big' : '');
    el.innerHTML = `<b>${LABELS[name][0]}</b><span>${LABELS[name][1]}</span>`;
    const g = document.createElementNS(SVG, 'g');
    g.innerHTML = '<polyline/><circle class="halo" r="8"/><circle r="4"/>';
    labelLayer.appendChild(el); leaders.appendChild(g);
    o.userData = { el, g, line: g.querySelector('polyline'), dots: g.querySelectorAll('circle'), a: 0, y: null, h: 0 };
    anchors[name] = o;
  }
  const layout = { row: false, vo: null };

  // ---- state & input ----
  const fixedStep = params.has('step') ? Number(params.get('step')) : null;
  let active = fixedStep ?? 0, stepStart = performance.now();
  const lookOf = k => k.look === 'ring' ? anchors.pogo.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.05, 0)).toArray() : k.look;
  world.updateMatrixWorld(true);
  const cur = { pose: [...KEYS[active].pose, 0], cam: [...KEYS[active].cam], look: [...lookOf(KEYS[active])],
                poseV: [0, 0, 0, 0, 0], camV: [0, 0, 0], lookV: [0, 0, 0] };
  let drag = 0, dragVel = 0, dragging = false, lastX = 0;
  const dots = steps.map((s, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', `Step ${i + 1}: ${s.querySelector('h3')?.textContent ?? ''}`);
    b.addEventListener('click', () => s.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    dotsEl?.appendChild(b); return b;
  });
  function setActive(i) {
    if (fixedStep !== null || i < 0 || i === active) return;
    active = i; stepStart = performance.now();
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
    layout.row = w / h <= 1.2;           // narrow screens: card below, model above it, compact callouts
    for (const o of Object.values(anchors)) o.userData.h = 0;
    layout.vo = null;
    if (layout.row) { camera.setViewOffset(w, h, 0, h * 0.2, w, h); camera.updateProjectionMatrix(); }
  }
  // wide screens: the model sits in the middle of the space the active card leaves free (cards alternate sides);
  // the callouts find their own spots around it
  function placeView(dt, snap) {
    if (layout.row) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const right = !!steps[active]?.classList.contains('right');
    const pad = Math.max(28, w / 2 - 600), card = Math.min(460, w - 2 * pad);
    const mid = ((right ? (w - pad - card) / 2 : (pad + card + w) / 2) + w / 2) / 2;   // halfway to the centre: room for callouts
    layout.vo = layout.vo == null || snap ? w / 2 - mid : damp(layout.vo, w / 2 - mid, 2.4, dt);
    camera.setViewOffset(w, h, layout.vo, 0, w, h); camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  const v = new THREE.Vector3(), lookV = new THREE.Vector3();
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.12, (now - last) / 1000); last = now;
    pickStep();
    let k = KEYS[active]; const t = params.has('t') ? Number(params.get('t')) : (now - stepStart) / 1000;
    const frozen = fixedStep !== null;
    if (params.has('key')) { const a = params.get('key').split(',').map(Number); k = { ...k, cam: a.slice(0, 3), look: a.slice(3, 6) }; }   // ?key=az,el,dist,lx,ly,lz
    // targets
    let target = [...k.pose, 0], swap = [0, 0], seg = -1;
    if (k.pick && (!frozen || params.has('t'))) { const s = PICK.sample(t); target = s.v; seg = s.i; }
    if (k.swap && (!frozen || params.has('t'))) swap = SWAP.sample(t).v;
    if (params.has('pose')) target = [...params.get('pose').split(',').map(Number), target[4]];
    if (params.has('jaw')) target[4] = Number(params.get('jaw'));
    if (params.has('swap')) { const s = Number(params.get('swap')); swap = [rig.tool.twist_deg * Math.min(1, s * 2), 0.055 * Math.max(0, s * 2 - 1)]; }
    // the pick cycle follows its own timeline closely; between steps the arm eases over with a spring
    if (frozen || params.has('pose')) cur.pose = [...target];
    else if (k.pick) { cur.pose = cur.pose.map((x, i) => damp(x, target[i], 10, dt)); cur.poseV.fill(0); }
    else cur.pose = spring(cur.pose, cur.poseV, target, 2.3, dt);
    applyPose(cur.pose); setJaw(cur.pose[4]); setSwap(swap[0], swap[1]);
    world.updateMatrixWorld(true);

    // brick: waits across the jaws, rides in the gripper while held, then sits in the bin
    // gripped where it lies (attach keeps the world pose), dropped where it is released
    const holding = seg >= HOLD_I && seg < RELEASE_I;
    if (holding) { if (carried.parent !== tool) tool.add(carried); inJaws.decompose(carried.position, carried.quaternion, carried.scale); }
    if (!holding && carried.parent === tool) { scene.attach(carried); carried.position.y = TRAY_FLOOR + BRICK[1] / 2; carried.rotation.x = carried.rotation.z = 0; }
    if (seg < HOLD_I && carried.parent !== tool && (seg >= 0 || !k.pick)) { carried.position.set(...brickHome); carried.rotation.set(0, brickYaw, 0); }

    // camera: spherical orbit around a damped look point; drag adds azimuth and eases back
    const lk = lookOf(k);
    cur.cam = frozen ? [...k.cam] : spring(cur.cam, cur.camV, k.cam, 2.0, dt);
    cur.look = frozen ? [...lk] : spring(cur.look, cur.lookV, lk, 2.0, dt);
    if (!dragging) { dragVel *= Math.exp(-6 * dt); drag = damp(drag + dragVel, 0, 0.6, dt); }
    const sway = frozen ? 0 : Math.sin(now / 7000) * 3;
    const [az, el, dist] = cur.cam, portrait = camera.aspect < 1 ? 1.8 : 1;
    lookV.set(...cur.look);
    const A = D2R(az + sway + drag), E = D2R(el);
    camera.position.set(Math.cos(E) * Math.cos(A), Math.sin(E), Math.cos(E) * Math.sin(A)).multiplyScalar(dist * portrait).add(lookV);
    if (params.has('focus')) {           // close-up of one anchor: ?focus=pogo&orbit=az,el,dist
      (params.get('focus') === 'brick' ? carried : anchors[params.get('focus')]).getWorldPosition(lookV);
      const [fa, fe, fd] = (params.get('orbit') || '40,20,0.25').split(',').map(Number);
      camera.position.set(Math.cos(D2R(fe)) * Math.cos(D2R(fa)), Math.sin(D2R(fe)), Math.cos(D2R(fe)) * Math.sin(D2R(fa))).multiplyScalar(fd).add(lookV);
    }
    if (params.has('cam')) camera.position.set(...params.get('cam').split(',').map(Number));
    camera.lookAt(params.has('look') ? new THREE.Vector3(...params.get('look').split(',').map(Number)) : lookV);
    placeView(dt, frozen);
    renderer.render(scene, camera);

    // labels once settled; on the quick-swap step the pin label shows while the tool is lifted
    const err = Math.max(...cur.pose.slice(0, 4).map((x, i) => Math.abs(x - k.pose[i])), Math.abs(cur.cam[2] - k.cam[2]) * 60);
    const settled = k.pick || err < 6;
    const w = canvas.clientWidth, h = canvas.clientHeight, shown = [];
    for (const [name, o] of Object.entries(anchors)) {
      const d = o.userData;
      o.getWorldPosition(v).project(camera);
      d.ax = (v.x + 1) / 2 * w; d.ay = (1 - v.y) / 2 * h;
      let on = settled && k.labels.includes(name) && v.z < 1;
      if (name === 'pogo') on = on && swap[1] > 0.03;
      d.a = frozen ? (on ? 1 : 0) : damp(d.a, on ? 1 : 0, on ? 6 : 10, dt);
      d.on = on;
      if (d.a > 0.01) shown.push(d); else { d.el.style.opacity = 0; d.g.style.opacity = 0; d.x = d.y = null; }
    }
    // Callouts sit next to their part, in whichever nearby spot is freest: few model points under the label (from
    // the projected point cloud), no other label, not the active card and not off-screen. Leaders stay short. A
    // label keeps its spot until another one is clearly better, so labels don't jump around as the model moves.
    const live = shown.filter(d => d.on), small = layout.row, LW = small ? 108 : 210;
    const cardEl = steps[active]?.querySelector('.step-card'), cr = cardEl?.getBoundingClientRect(), sr = canvas.getBoundingClientRect();
    const card = cr && cr.width ? [cr.left - sr.left, cr.top - sr.top, cr.right - sr.left, cr.bottom - sr.top] : null;
    if (live.length) {
      const vis = new Map();
      for (let i = 0; i < cloud.length; i++) {
        const m = cloud[i][0];
        if (!vis.has(m)) { let o = m, ok = true; for (; o; o = o.parent) if (!o.visible) { ok = false; break; } vis.set(m, ok); }
        if (!vis.get(m)) { cloudX[i] = NaN; continue; }
        v.copy(cloud[i][1]).applyMatrix4(m.matrixWorld).project(camera); cloudX[i] = (v.x + 1) / 2 * w; cloudY[i] = (1 - v.y) / 2 * h;
      }
    }
    const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const placed = [];
    const DIRS = [[1, -1], [-1, -1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]];
    for (const d of live.sort((p, q) => p.ay - q.ay)) {
      d.el.classList.toggle('compact', small);
      if (!d.h || d.small !== small) { d.el.style.width = LW + 'px'; d.h = d.el.offsetHeight; d.small = small; }
      let best = null;
      for (const R of small ? [30, 60, 95, 130] : [44, 100, 160, 230]) for (let k = 0; k < DIRS.length; k++) {
        const [dx, dy] = DIRS[k], n = Math.hypot(dx, dy), px = d.ax + dx / n * R, py = d.ay + dy / n * R;
        const x = dx < 0 ? px - LW : dx > 0 ? px : px - LW / 2, y = dy < 0 ? py - d.h : dy > 0 ? py : py - d.h / 2;
        const box = [x, y, x + LW, y + d.h];
        let cost = R * 0.4;
        // the leader runs from the part to the nearest point of the label; it may cross the model a little
        const ex = Math.min(Math.max(d.ax, box[0]), box[2]) - d.ax, ey = Math.min(Math.max(d.ay, box[1]), box[3]) - d.ay, ll = ex * ex + ey * ey || 1;
        for (let i = 0; i < cloud.length; i++) {
          const cx = cloudX[i], cy = cloudY[i];         // a little clearance around the text, too
          if (cx >= box[0] - 10 && cx <= box[2] + 10 && cy >= box[1] - 8 && cy <= box[3] + 8) { cost += 4; continue; }
          const u = Math.min(1, Math.max(0, ((cx - d.ax) * ex + (cy - d.ay) * ey) / ll));
          if (u > 0.25 && Math.hypot(cx - d.ax - u * ex, cy - d.ay - u * ey) < 5) cost += 1;
        }
        for (const b of placed) cost += overlap(box, b) * 0.5;
        if (card) cost += overlap(box, [card[0] - 12, card[1] - 12, card[2] + 12, card[3] + 12]) * 0.5;
        cost += (Math.max(0, 12 - box[0]) + Math.max(0, box[2] - (w - (small ? 12 : 48))) + Math.max(0, (small ? 64 : 56) - box[1]) + Math.max(0, box[3] - (h - 12))) * 40;
        const key = R * 10 + k;
        if (key === d.key) cost -= 60;                       // stickiness: stay unless clearly better elsewhere
        if (!best || cost < best.cost) best = { cost, key, box, dx };
      }
      d.key = best.key; d.tx = best.box[0]; d.ty = best.box[1]; d.flip = best.dx < 0;
      placed.push(best.box);
    }
    for (const d of shown) {
      d.el.style.opacity = d.a; d.g.style.opacity = d.a;
      if (!d.on) continue;                                    // fading out: stays exactly where it was
      const snap = d.x == null || frozen;
      d.x = snap ? d.tx : damp(d.x, d.tx, 7, dt); d.y = snap ? d.ty : damp(d.y, d.ty, 7, dt);
      d.el.classList.toggle('flip', d.flip);
      d.el.style.transform = `translate(${d.x.toFixed(1)}px, ${d.y.toFixed(1)}px)`;
      // leader: from the part to the nearest point of the label, stopping just short of the text
      const ex = Math.min(Math.max(d.ax, d.x - 6), d.x + LW + 6), ey = Math.min(Math.max(d.ay, d.y + 9), d.y + d.h - 6);
      d.line.setAttribute('points', `${d.ax.toFixed(1)},${d.ay.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
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
