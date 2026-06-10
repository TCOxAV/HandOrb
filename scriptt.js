/* ══════════════════════════════════════════════════════════════
   Hand Orb — scriptt.js
   • Teachable Machine: open hand / closed hand / idle
   • MediaPipe Hands: palm tracking (drag) + sphere gesture detect
   • Three.js: skeleton wireframe sphere
   • Canvas: galaxy explosion on break
══════════════════════════════════════════════════════════════ */

const MODEL_URL = "./my_model/";

/* ── state ── */
let tmModel = null, webcam = null, maxPredictions = 0;
let mpHands = null, mpCamera = null;
let animationId = null;
let predictionInFlight = false;
let lastPredictionTime = 0;
const PREDICTION_INTERVAL_MS = 300; // TM prediction rate (3/sec is plenty)

let orbVisible   = false;   // solid orb shown
let orbSkeleton  = false;   // skeleton mode
let exploding    = false;   // galaxy explosion in progress
let sphereHoldStart = 0;    // when sphere gesture started
const SPHERE_HOLD_MS = 350; // hold this long before activating

/* orb position on screen (transform-based — absolute screen coords) */
let orbX = window.innerWidth/2 + 160;
let orbY = window.innerHeight/2;
let orbTargetX = orbX, orbTargetY = orbY;

/* last palm position from MediaPipe (normalised 0-1) */
let palmNX = null, palmNY = null; // null = no hand seen
let sphereGestureActive = false;
let sphereProgress = 0; // 0-1 charge-up progress
let indexFingerActive = false; // true if exactly 1 finger is up
let sphereCooldown = false; // prevents auto-explosion from looping until hand opens

/* ── DOM refs ── */
const statusEl   = document.getElementById("status");
const orbWrapper = document.getElementById("orb-wrapper");
const orbEl      = document.getElementById("orb");
const orbLabel   = document.getElementById("orbLabel");
const labelCont  = document.getElementById("label-container");
const webcamCont = document.getElementById("webcam-container");
const galaxyCvs  = document.getElementById("galaxyCanvas");
const galaxyCtx  = galaxyCvs.getContext("2d");

/* ══════════════════════════════════════════
   FULLSCREEN
══════════════════════════════════════════ */
function requestFullScreen() {
    const docEl = document.documentElement;
    if (docEl.requestFullscreen) {
        docEl.requestFullscreen().catch(err => console.log("Fullscreen request failed:", err));
    } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
    } else if (docEl.mozRequestFullScreen) {
        docEl.mozRequestFullScreen();
    } else if (docEl.msRequestFullscreen) {
        docEl.msRequestFullscreen();
    }
}

/* ══════════════════════════════════════════
   RESIZE
══════════════════════════════════════════ */
function resizeGalaxyCanvas() {
    galaxyCvs.width  = window.innerWidth;
    galaxyCvs.height = window.innerHeight;
}
resizeGalaxyCanvas();
window.addEventListener("resize", resizeGalaxyCanvas);

/* ══════════════════════════════════════════
   ORB POSITION LERP
══════════════════════════════════════════ */
(function positionLoop(){
    orbX += (orbTargetX - orbX) * 0.12;
    orbY += (orbTargetY - orbY) * 0.12;
    // transform is GPU-composited — no layout, no paint, silky smooth
    orbWrapper.style.transform =
        `translate(${orbX}px,${orbY}px) translate(-50%,-50%)`;
    requestAnimationFrame(positionLoop);
})();

/* ══════════════════════════════════════════
   THREE.JS SKELETON SPHERE
══════════════════════════════════════════ */
let skRenderer = null, skScene = null, skCamera = null, skSphere = null;
let skAnimId = null;
const skCanvas = document.getElementById("skeletonCanvas");

function initSkeletonSphere() {
    const size = 260; // skCanvas is inset:-60px on a 140px wrapper → 260px
    skCanvas.width  = size;
    skCanvas.height = size;

    skRenderer = new THREE.WebGLRenderer({ canvas: skCanvas, alpha: true, antialias: true });
    skRenderer.setSize(size, size);
    skRenderer.setClearColor(0x000000, 0);

    skScene  = new THREE.Scene();
    skCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    skCamera.position.set(0, 0, 3.5);

    buildSkeleton(1.0);
}

function buildSkeleton(scale) {
    // remove old
    if (skSphere) { skScene.remove(skSphere); skSphere.geometry.dispose(); skSphere.material.dispose(); }

    const geo = new THREE.SphereGeometry(scale, 16, 12);
    // wireframe via EdgesGeometry for cleaner lines
    const edges = new THREE.EdgesGeometry(geo);
    const mat   = new THREE.LineBasicMaterial({
        color: 0x88aaff,
        transparent: true,
        opacity: 0.85,
        linewidth: 1
    });
    skSphere = new THREE.LineSegments(edges, mat);
    skScene.add(skSphere);

    // add equatorial circle glow
    const rings = [0, Math.PI/3, Math.PI*2/3];
    rings.forEach(angle => {
        const rGeo = new THREE.TorusGeometry(scale, 0.008, 4, 64);
        const rMat = new THREE.MeshBasicMaterial({ color: 0xaaccff, transparent: true, opacity: 0.4 });
        const torus = new THREE.Mesh(rGeo, rMat);
        torus.rotation.x = angle;
        skScene.add(torus);
    });
}

let skScale = 1.0;
let skTargetScale = 1.0;
function animateSkeleton() {
    if (!skRenderer) return;
    skAnimId = requestAnimationFrame(animateSkeleton);

    // scale lerp
    skScale += (skTargetScale - skScale) * 0.08;
    if (skSphere) {
        skSphere.scale.setScalar(skScale);
        skScene.children.forEach(c => { if (c !== skSphere) c.scale.setScalar(skScale); });
        skSphere.rotation.y += 0.008;
        skSphere.rotation.x += 0.003;

            // dynamic colour pulse — reuse color object to avoid GC churn
        const t = Date.now() * 0.001;
        const h = (t * 0.1) % 1;
        if (!animateSkeleton._col) animateSkeleton._col = new THREE.Color();
        animateSkeleton._col.setHSL(0.6 + h * 0.1, 0.9, 0.65);
        skSphere.material.color = animateSkeleton._col;
    }
    skRenderer.render(skScene, skCamera);
}

/* ══════════════════════════════════════════
   CHARGE RING — visual feedback while gesture builds
   Draws a pulsing arc on the galaxy canvas showing hold progress
══════════════════════════════════════════ */
let chargeRingX = 0.5, chargeRingY = 0.5;
function updateChargeRing(progress) {
    if (progress <= 0.02) return;
    const cx = chargeRingX * window.innerWidth;
    const cy = chargeRingY * window.innerHeight;
    const radius = 48 + progress * 22;
    const alpha = 0.25 + progress * 0.65;

    // draw a short-lived arc (doesn't persist — cleared each frame by galaxy or next call)
    galaxyCtx.beginPath();
    galaxyCtx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    galaxyCtx.strokeStyle = `hsla(${220 + progress * 60}, 100%, ${60 + progress * 30}%, ${alpha})`;
    galaxyCtx.lineWidth = 3 + progress * 4;
    galaxyCtx.lineCap = 'round';
    galaxyCtx.stroke();

    // inner glow dot
    if (progress > 0.5) {
        const grd = galaxyCtx.createRadialGradient(cx, cy, 0, cx, cy, 12);
        grd.addColorStop(0, `hsla(200, 100%, 80%, ${(progress - 0.5) * 0.8})`);
        grd.addColorStop(1, 'transparent');
        galaxyCtx.beginPath();
        galaxyCtx.arc(cx, cy, 12, 0, Math.PI * 2);
        galaxyCtx.fillStyle = grd;
        galaxyCtx.fill();
    }
}

function showSkeleton() {
    if (orbSkeleton) return;
    orbSkeleton = true;
    if (!skRenderer) initSkeletonSphere();
    skTargetScale = 1.0;
    skScale = 0.2;
    orbWrapper.classList.add("skeleton");
    if (!skAnimId) animateSkeleton();
    orbLabel.textContent = "Sphere gesture — skeleton orb";
    orbLabel.className = "sphere";
}

/* ══════════════════════════════════════════
   GALAXY EXPLOSION
══════════════════════════════════════════ */
let galaxyParticles = [];

function triggerGalaxyExplosion(cx, cy) {
    exploding = true;
    galaxyParticles = [];
    const count = 280;
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 6 + 1.5;
        const hue   = Math.random() * 80 + 200; // blue-purple range
        const sat   = 60 + Math.random() * 40;
        const lit   = 50 + Math.random() * 35;
        galaxyParticles.push({
            x: cx, y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: Math.random() * 3 + 0.5,
            alpha: 1,
            decay: Math.random() * 0.012 + 0.006,
            trail: [],
            color: `hsl(${hue},${sat}%,${lit}%)`,
            spin: (Math.random() - 0.5) * 0.3,
            isGalaxyArm: Math.random() < 0.25
        });
    }
    // extra bright core burst
    for (let i = 0; i < 40; i++) {
        const angle = Math.random() * Math.PI * 2;
        galaxyParticles.push({
            x: cx, y: cy,
            vx: Math.cos(angle) * (Math.random() * 2 + 0.5),
            vy: Math.sin(angle) * (Math.random() * 2 + 0.5),
            size: Math.random() * 5 + 2,
            alpha: 0.9,
            decay: Math.random() * 0.007 + 0.003,
            trail: [],
            color: `hsl(${200+Math.random()*60},90%,90%)`,
            spin: 0,
            isGalaxyArm: false
        });
    }
    runGalaxy();
}

function runGalaxy() {
    galaxyCtx.clearRect(0, 0, galaxyCvs.width, galaxyCvs.height);
    let alive = 0;
    galaxyParticles.forEach(p => {
        if (p.alpha <= 0) return;
        alive++;
        // gravity spiral for galaxy-arm particles
        if (p.isGalaxyArm) {
            p.vx += p.vy * 0.005;
            p.vy -= p.vx * 0.005;
        }
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= p.decay;

        // trail
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 8) p.trail.shift();

        // draw trail
        if (p.trail.length > 1) {
            galaxyCtx.beginPath();
            galaxyCtx.moveTo(p.trail[0].x, p.trail[0].y);
            p.trail.forEach(pt => galaxyCtx.lineTo(pt.x, pt.y));
            galaxyCtx.strokeStyle = p.color.replace('hsl', 'hsla').replace(')', `,${p.alpha * 0.3})`);
            galaxyCtx.lineWidth = p.size * 0.4;
            galaxyCtx.stroke();
        }

        // draw particle
        const grd = galaxyCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
        grd.addColorStop(0, p.color.replace('hsl','hsla').replace(')',`,${p.alpha})`));
        grd.addColorStop(1, 'transparent');
        galaxyCtx.beginPath();
        galaxyCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        galaxyCtx.fillStyle = grd;
        galaxyCtx.fill();
    });

    if (alive > 0) {
        requestAnimationFrame(runGalaxy);
    } else {
        galaxyCtx.clearRect(0, 0, galaxyCvs.width, galaxyCvs.height);
        exploding = false;
    }
}

/* ══════════════════════════════════════════
   BREAK SKELETON
══════════════════════════════════════════ */
function breakSkeleton() {
    if (!orbSkeleton) return;
    orbSkeleton = false;
    orbWrapper.classList.remove("skeleton");

    const cx = orbX;
    const cy = orbY;

    // stop three.js skeleton
    if (skAnimId) { cancelAnimationFrame(skAnimId); skAnimId = null; }
    if (skScene && skSphere) { skScene.clear(); skSphere = null; }
    if (skRenderer) { skRenderer.clear(); }

    // galaxy explosion from orb position
    triggerGalaxyExplosion(cx, cy);

    // orb stays hidden after break
    hideOrb();
    orbLabel.textContent = "Skeleton shattered — galaxy born";
    orbLabel.className = "";
}

/* ══════════════════════════════════════════
   ORB SHOW / HIDE
══════════════════════════════════════════ */
function showOrb() {
    if (orbVisible) return;
    orbVisible = true;
    orbEl.classList.add("show");
    orbWrapper.classList.add("show");
}

function hideOrb() {
    if (!orbVisible) return;
    orbVisible = false;
    orbEl.classList.remove("show");
    orbWrapper.classList.remove("show");
}

/* ══════════════════════════════════════════
   HAND SKELETON OVERLAY
   Draws a holographic hand skeleton on the full-screen playground canvas
   so users can see exactly where their hand is in the play space.
══════════════════════════════════════════ */

// MediaPipe Hands landmark connections (21 keypoints)
const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],           // thumb
    [0,5],[5,6],[6,7],[7,8],           // index
    [0,9],[9,10],[10,11],[11,12],      // middle
    [0,13],[13,14],[14,15],[15,16],    // ring
    [0,17],[17,18],[18,19],[19,20],    // pinky
    [5,9],[9,13],[13,17]               // palm knuckle bar
];
const FINGERTIP_IDX = new Set([4, 8, 12, 16, 20]);

function drawHandSkeleton(multiLandmarks) {
    if (!multiLandmarks || multiLandmarks.length === 0) return;

    const W = galaxyCvs.width;
    const H = galaxyCvs.height;

    multiLandmarks.forEach(landmarks => {
        // Map normalised MediaPipe coords → screen pixels
        // MediaPipe x is mirrored: 0 = right edge, 1 = left edge
        const sc = landmarks.map(lm => ({
            x: (1 - lm.x) * W,
            y: lm.y * H
        }));

        galaxyCtx.save();
        galaxyCtx.lineCap = 'round';
        galaxyCtx.lineJoin = 'round';

        /* ── Pass 1: wide glow (no shadowBlur for perf) ── */
        galaxyCtx.strokeStyle = 'rgba(60, 130, 255, 0.12)';
        galaxyCtx.lineWidth = 8;
        galaxyCtx.beginPath();
        HAND_CONNECTIONS.forEach(([a, b]) => {
            galaxyCtx.moveTo(sc[a].x, sc[a].y);
            galaxyCtx.lineTo(sc[b].x, sc[b].y);
        });
        galaxyCtx.stroke();

        /* ── Pass 2: crisp bone lines ── */
        galaxyCtx.strokeStyle = 'rgba(80, 160, 255, 0.55)';
        galaxyCtx.lineWidth = 1.6;
        galaxyCtx.beginPath();
        HAND_CONNECTIONS.forEach(([a, b]) => {
            galaxyCtx.moveTo(sc[a].x, sc[a].y);
            galaxyCtx.lineTo(sc[b].x, sc[b].y);
        });
        galaxyCtx.stroke();

        /* ── Pass 3: joint dots ── */
        sc.forEach((p, i) => {
            const isTip = FINGERTIP_IDX.has(i);
            const r = isTip ? 5.5 : (i === 0 ? 4 : 2.5);

            // When charging pinch gesture, fingertips shift blue → amber/white
            let fillColor, glowColor;
            if (isTip && sphereProgress > 0.05) {
                const hue  = 210 - sphereProgress * 150; // 210 blue → 60 amber
                const sat  = 100;
                const lit  = 55 + sphereProgress * 35;
                const a    = 0.75 + sphereProgress * 0.25;
                fillColor  = `hsla(${hue},${sat}%,${lit}%,${a})`;
                glowColor  = `hsla(${hue},${sat}%,${lit}%,0.4)`;
            } else if (isTip) {
                fillColor = 'rgba(130, 195, 255, 0.88)';
                glowColor = 'rgba(80, 160, 255, 0.3)';
            } else {
                fillColor = i === 0 ? 'rgba(100, 170, 255, 0.75)' : 'rgba(70, 130, 255, 0.6)';
                glowColor = null;
            }

            // Soft outer glow ring for tips
            if (glowColor) {
                galaxyCtx.beginPath();
                galaxyCtx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
                galaxyCtx.fillStyle = glowColor;
                galaxyCtx.fill();
            }

            // Main dot
            galaxyCtx.beginPath();
            galaxyCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
            galaxyCtx.fillStyle = fillColor;
            galaxyCtx.fill();
        });

        galaxyCtx.restore();
    });
}

/* ══════════════════════════════════════════
   MEDIAPIPE HANDS
══════════════════════════════════════════ */
let mpFrameCounter = 0;
function initMediaPipe(videoElement) {
    mpHands = new Hands({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });
    mpHands.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,          // lite model — much faster, still accurate
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5
    });
    mpHands.onResults(onMPResults);

    mpCamera = new Camera(videoElement, {
        onFrame: async () => {
            mpFrameCounter++;
            if (mpFrameCounter % 2 !== 0) return; // process every 2nd frame (~15 fps)
            await mpHands.send({ image: videoElement });
        },
        width: 160,   // hand detection doesn't need 224px
        height: 160,
        facingMode: 'user'
    });
    mpCamera.start();
}

/* ─────────────────────────────────────────────────────────
   detectSphereGesture — works with 1 OR 2 hands:

   • Single hand : all 5 fingertips bunched within 0.11 norm-dist
                   (think of closing all fingers into a gentle pinch)
   • Two hands   : all 10 fingertips within 0.20 norm-dist
                   (original "globe" gesture, threshold relaxed)

   Returns { detected: bool, confidence: 0-1, cx, cy }
───────────────────────────────────────────────────────── */
function detectSphereGesture(multiLandmarks) {
    const tips = [4, 8, 12, 16, 20]; // thumb, index, middle, ring, pinky

    if (!multiLandmarks || multiLandmarks.length === 0)
        return { detected: false, confidence: 0, cx: 0.5, cy: 0.5 };

    /* ── single-hand pinch-all ── */
    for (const hand of multiLandmarks) {
        const pts = tips.map(i => hand[i]);
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        const maxDist = Math.max(...pts.map(p =>
            Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2)
        ));
        const THRESHOLD_1 = 0.11;
        if (maxDist < THRESHOLD_1) {
            const confidence = Math.max(0, 1 - maxDist / THRESHOLD_1);
            return { detected: true, confidence, cx: 1 - cx, cy };
        }
        // partial progress for single hand (for charge ring)
        if (maxDist < THRESHOLD_1 * 2.2) {
            const confidence = Math.max(0, 1 - maxDist / (THRESHOLD_1 * 2.2));
            // return partial but not detected
            return { detected: false, confidence, cx: 1 - cx, cy };
        }
    }

    /* ── two-hand globe (original, threshold relaxed 0.15→0.20) ── */
    if (multiLandmarks.length >= 2) {
        const allTips = [];
        multiLandmarks.forEach(hand => tips.forEach(i => allTips.push(hand[i])));
        const cx = allTips.reduce((s, p) => s + p.x, 0) / allTips.length;
        const cy = allTips.reduce((s, p) => s + p.y, 0) / allTips.length;
        const maxDist = Math.max(...allTips.map(p =>
            Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2)
        ));
        const THRESHOLD_2 = 0.20;
        if (maxDist < THRESHOLD_2) {
            const confidence = Math.max(0, 1 - maxDist / THRESHOLD_2);
            return { detected: true, confidence, cx: 1 - cx, cy };
        }
        if (maxDist < THRESHOLD_2 * 1.8) {
            const confidence = Math.max(0, 1 - maxDist / (THRESHOLD_2 * 1.8));
            return { detected: false, confidence, cx: 1 - cx, cy };
        }
    }

    return { detected: false, confidence: 0, cx: 0.5, cy: 0.5 };
}

/* Get palm center from first hand (for dragging) */
function getPalmCenter(landmarks) {
    // use wrist (0) + MCP joints (5,9,13,17) average
    const refs = [0, 5, 9, 13, 17];
    const x = refs.reduce((s, i) => s + landmarks[i].x, 0) / refs.length;
    const y = refs.reduce((s, i) => s + landmarks[i].y, 0) / refs.length;
    // MediaPipe x is mirrored (0=right), we want it natural
    return { x: 1 - x, y };
}

/* Detect if a hand is making a fist (fingertips close to palm) */
function isFist(landmarks) {
    const tips = [8, 12, 16, 20]; // index-pinky fingertips
    const palm = landmarks[0]; // wrist
    const avgDist = tips.reduce((s, i) => {
        const dx = landmarks[i].x - palm.x;
        const dy = landmarks[i].y - palm.y;
        return s + Math.sqrt(dx*dx + dy*dy);
    }, 0) / tips.length;
    return avgDist < 0.15; // all fingers curled
}

/* Detect if only the index finger is up */
function isIndexFingerUp(landmarks) {
    const wrist = landmarks[0];
    const dist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
    
    const indexDist = dist(wrist, landmarks[8]);
    const middleDist = dist(wrist, landmarks[12]);
    const ringDist = dist(wrist, landmarks[16]);
    const pinkyDist = dist(wrist, landmarks[20]);
    
    const maxOther = Math.max(middleDist, ringDist, pinkyDist);
    
    // Index must be significantly more extended than the other three
    // and pointing generally upwards (tip y is less than wrist y)
    return indexDist > maxOther * 1.4 && indexDist > 0.15 && landmarks[8].y < wrist.y;
}

function onMPResults(results) {
    const hands = results.multiHandLandmarks;

    if (!hands || hands.length === 0) {
        palmNX = null;
        palmNY = null;
        sphereGestureActive = false;
        sphereHoldStart = 0;
        sphereProgress = 0;
        indexFingerActive = false;
        if (!exploding) galaxyCtx.clearRect(0, 0, galaxyCvs.width, galaxyCvs.height);
        return;
    }

    // clear + draw hand skeleton on playground (always, unless exploding)
    if (!exploding) {
        galaxyCtx.clearRect(0, 0, galaxyCvs.width, galaxyCvs.height);
        drawHandSkeleton(hands);
    }

    /* sphere gesture — single OR dual hand */
    const sphereResult = detectSphereGesture(hands);
    chargeRingX = sphereResult.cx;
    chargeRingY = sphereResult.cy;
    
    // Only update progress/rings if not in cooldown from an auto-explosion
    if (!sphereCooldown) {
        sphereProgress = sphereResult.confidence;
        updateChargeRing(sphereProgress);
    }

    if (sphereResult.detected) {
        if (!sphereCooldown) {
            if (sphereHoldStart === 0) sphereHoldStart = Date.now();
            const elapsed = Date.now() - sphereHoldStart;
            sphereProgress = Math.min(1, elapsed / SPHERE_HOLD_MS);
            updateChargeRing(sphereProgress);

            if (!orbSkeleton && elapsed > SPHERE_HOLD_MS) {
                // place orb at the gesture centroid
                orbTargetX = sphereResult.cx * window.innerWidth;
                orbTargetY = sphereResult.cy * window.innerHeight;
                showSkeleton();
            }
            sphereGestureActive = true;
            
            // Automatic explosion if held long enough (800ms after skeleton appears)
            if (orbSkeleton && elapsed > SPHERE_HOLD_MS + 800) {
                breakSkeleton();
                sphereCooldown = true; // wait for user to release pinch
                sphereGestureActive = false;
                sphereHoldStart = 0;
            }
        }
    } else {
        // user released the pinch
        sphereCooldown = false;
        if (sphereGestureActive && orbSkeleton) {
            breakSkeleton(); // explode on early release
        }
        sphereGestureActive = false;
        sphereHoldStart = 0;
        if (!sphereResult.confidence) sphereProgress = 0;
    }

    /* palm tracking for drag OR index finger tracking */
    if (!orbSkeleton && !exploding && hands.length >= 1) {
        indexFingerActive = isIndexFingerUp(hands[0]);
        if (indexFingerActive) {
            if (!orbVisible) {
                showOrb();
                orbLabel.textContent = "Summoned (1 finger)";
                orbLabel.className = "open";
            }
            // map index tip directly to screen
            orbTargetX = (1 - hands[0][8].x) * window.innerWidth;
            orbTargetY = hands[0][8].y * window.innerHeight;
        } else {
            const palm = getPalmCenter(hands[0]);
            palmNX = palm.x;
            palmNY = palm.y;
        }
    } else {
        indexFingerActive = false;
    }
}

/* ══════════════════════════════════════════
   TEACHABLE MACHINE
══════════════════════════════════════════ */
function setStatus(msg, cls = "") {
    statusEl.textContent = msg;
    statusEl.className = cls;
}

function buildBars(names) {
    labelCont.innerHTML = "";
    names.forEach((name, i) => {
        const row = document.createElement("div");
        row.className = "pred-row";
        row.innerHTML = `
            <div class="pred-header">
                <span class="pred-name">${name}</span>
                <span id="pct-${i}">0%</span>
            </div>
            <div class="pred-bar-bg"><div class="pred-bar-fill" id="bar-${i}"></div></div>`;
        labelCont.appendChild(row);
    });
}

function stopCamera() {
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    if (webcam) {
        try {
            webcam.pause();
        } catch (e) {
            console.warn("Unable to pause webcam", e);
        }
        if (webcam.canvas && webcam.canvas.parentNode) {
            webcam.canvas.parentNode.removeChild(webcam.canvas);
        }
        webcam = null;
    }
    webcamCont.classList.remove("active");
    orbEl.classList.remove("show");
    orbWrapper.classList.remove("skeleton");
    orbLabel.textContent = "Camera stopped.";
}

async function init() {
    stopCamera();
    requestFullScreen();
    setStatus("Starting camera…");
    const btn = document.getElementById("startButton");
    btn.disabled = true;
    btn.textContent = "Starting…";

    /* ── webcam via TM ── */
    try {
        webcam = new tmImage.Webcam(224, 224, true);
        await webcam.setup();
        await webcam.play();
        webcamCont.appendChild(webcam.canvas);
        webcamCont.classList.add("active");
        setStatus("Camera live. Loading model…", "live");
    } catch (err) {
        stopCamera();
        setStatus("Camera error: " + (err.message || err), "error");
        btn.disabled = false;
        btn.textContent = "◎ Retry";
        console.error(err);
        return;
    }

    /* ── MediaPipe on the same video ── */
    // webcam.canvas is a canvas, not a video — we need the actual video element
    // tmImage.Webcam exposes webcam.webcam (the HTMLVideoElement)
    try {
        const videoEl = webcam.webcam; // the underlying <video>
        if (videoEl) initMediaPipe(videoEl);
    } catch (e) {
        console.warn("MediaPipe init failed:", e);
    }

    /* ── TM model ── */
    try {
        tmModel = await tmImage.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
        maxPredictions = tmModel.getTotalClasses();
        const labels = tmModel.getClassLabels ? tmModel.getClassLabels() : Array.from({length:maxPredictions},(_,i)=>"Class "+i);
        buildBars(labels);
        btn.textContent = "◉ Live";
        setStatus("Ready — show your hand!", "live");
        orbLabel.textContent = "Waiting for gesture…";
    } catch (err) {
        setStatus("Model load failed: " + (err.message||err), "error");
        btn.disabled = false;
        btn.textContent = "◎ Retry";
        orbLabel.textContent = "Camera live — model not loaded.";
        console.error(err);
    }

    animationId = requestAnimationFrame(loop);
}

/* ══════════════════════════════════════════
   MAIN LOOP
══════════════════════════════════════════ */
async function loop() {
    if (!webcam) {
        return;
    }

    // throttle webcam canvas update to TM prediction rate — no need to draw 60fps
    if (tmModel && !predictionInFlight) {
        const now = performance.now();
        if (now - lastPredictionTime >= PREDICTION_INTERVAL_MS) {
            webcam.update(); // draw fresh frame only when we're about to predict
            predictionInFlight = true;
            lastPredictionTime = now;
            predict().finally(() => { predictionInFlight = false; });
        }
    }

    animationId = requestAnimationFrame(loop);
}

async function predict() {
    if (!tmModel || !webcam) return;

    try {
        const preds = await tmModel.predict(webcam.canvas);
        const best  = preds.reduce((a,b) => b.probability > a.probability ? b : a, preds[0]);
        const THRESH = 0.60;
        const cn = best.className.toLowerCase().trim();

        if (!orbSkeleton && !exploding && !indexFingerActive) {
            if (cn.includes("open") && best.probability > THRESH) {
                showOrb();
                if (palmNX !== null && palmNY !== null) {
                    const margin = 80;
                    orbTargetX = margin + palmNX * (window.innerWidth - margin*2);
                    orbTargetY = margin + palmNY * (window.innerHeight - margin*2);
                }
                orbLabel.textContent = "Palm open — orb follows your hand";
                orbLabel.className = "open";
            } else if (cn.includes("closed") && best.probability > THRESH) {
                hideOrb();
                orbLabel.textContent = "Hand closed — orb hidden";
                orbLabel.className = "closed";
            } else {
                orbLabel.textContent = "Idle…";
                orbLabel.className = "";
            }
        }

        let topIdx = 0;
        preds.forEach((p,i) => { if (p.probability > preds[topIdx].probability) topIdx = i; });
        preds.forEach((p,i) => {
            const pct = Math.round(p.probability * 100);
            const bar = document.getElementById("bar-"+i);
            const pctEl = document.getElementById("pct-"+i);
            if (bar) { bar.style.width = pct+"%"; bar.className = "pred-bar-fill"+(i===topIdx?" top":""); }
            if (pctEl) pctEl.textContent = pct+"%";
        });
    } catch (err) {
        setStatus("Prediction error: " + (err.message || err), "error");
        console.error(err);
        stopCamera();
        const btn = document.getElementById("startButton");
        btn.disabled = false;
        btn.textContent = "◎ Retry";
    }
}

document.getElementById("startButton").addEventListener("click", init);
