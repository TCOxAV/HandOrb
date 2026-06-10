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
const PREDICTION_INTERVAL_MS = 140;

let orbVisible   = false;   // solid orb shown
let orbSkeleton  = false;   // skeleton mode
let exploding    = false;   // galaxy explosion in progress
let sphereHoldStart = 0;    // when sphere gesture started
const SPHERE_HOLD_MS = 600; // hold this long before activating

/* orb position on screen (center of wrapper) */
let orbX = window.innerWidth/2 + 160;
let orbY = window.innerHeight/2;
let orbTargetX = orbX, orbTargetY = orbY;

/* last palm position from MediaPipe (normalised 0-1) */
let palmNX = null, palmNY = null; // null = no hand seen
let sphereGestureActive = false;

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
    orbWrapper.style.left = orbX + "px";
    orbWrapper.style.top  = orbY + "px";
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

        // dynamic colour pulse
        const t = Date.now() * 0.001;
        const h = (t * 0.1) % 1;
        const col = new THREE.Color().setHSL(0.6 + h * 0.1, 0.9, 0.65);
        skSphere.material.color = col;
    }
    skRenderer.render(skScene, skCamera);
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
    orbLabel.className = "orb-label sphere";
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
    orbLabel.className = "orb-label";
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
   MEDIAPIPE HANDS
══════════════════════════════════════════ */
function initMediaPipe(videoElement) {
    mpHands = new Hands({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });
    mpHands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.6
    });
    mpHands.onResults(onMPResults);

    mpCamera = new Camera(videoElement, {
        onFrame: async () => { await mpHands.send({ image: videoElement }); },
        width: 224,
        height: 224
    });
    mpCamera.start();
}

/* Check if all fingertips on BOTH hands are close together (sphere gesture) */
function detectSphereGesture(multiLandmarks) {
    if (!multiLandmarks || multiLandmarks.length < 2) return false;

    // fingertip landmark indices: thumb=4, index=8, middle=12, ring=16, pinky=20
    const tips = [4, 8, 12, 16, 20];

    // collect all fingertips from both hands
    const allTips = [];
    multiLandmarks.forEach(hand => {
        tips.forEach(i => allTips.push(hand[i]));
    });

    if (allTips.length < 10) return false;

    // compute centroid
    const cx = allTips.reduce((s, p) => s + p.x, 0) / allTips.length;
    const cy = allTips.reduce((s, p) => s + p.y, 0) / allTips.length;

    // check all tips within radius threshold
    const maxDist = Math.max(...allTips.map(p =>
        Math.sqrt((p.x - cx)**2 + (p.y - cy)**2)
    ));

    // threshold: all tips within ~15% of frame width of centroid
    return maxDist < 0.15;
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

function onMPResults(results) {
    const hands = results.multiHandLandmarks;

    if (!hands || hands.length === 0) {
        palmNX = null;
        palmNY = null;
        sphereGestureActive = false;
        sphereHoldStart = 0;
        return;
    }

    /* sphere gesture (2 hands, fingertips forming globe) */
    const isSphere = detectSphereGesture(hands);

    if (isSphere) {
        if (sphereHoldStart === 0) sphereHoldStart = Date.now();
        if (!orbSkeleton && Date.now() - sphereHoldStart > SPHERE_HOLD_MS) {
            // position orb at centroid of all fingertips
            const tips = [4,8,12,16,20];
            let ax=0, ay=0, n=0;
            hands.forEach(h => { tips.forEach(i => { ax += h[i].x; ay += h[i].y; n++; }); });
            const cx = (1 - ax/n) * window.innerWidth;
            const cy = (ay/n) * window.innerHeight;
            orbTargetX = cx;
            orbTargetY = cy;
            showSkeleton();
        }
        sphereGestureActive = true;
    } else {
        if (sphereGestureActive && orbSkeleton) {
            breakSkeleton();
        }
        sphereGestureActive = false;
        sphereHoldStart = 0;
    }

    /* palm tracking for drag (use first hand if not in skeleton mode) */
    if (!orbSkeleton && hands.length >= 1) {
        const palm = getPalmCenter(hands[0]);
        palmNX = palm.x;
        palmNY = palm.y;
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
        webcam = new tmImage.Webcam(160, 160, true);
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

    try {
        webcam.update();
    } catch (err) {
        setStatus("Webcam update error: " + (err.message || err), "error");
        console.error(err);
        stopCamera();
        const btn = document.getElementById("startButton");
        btn.disabled = false;
        btn.textContent = "◎ Retry";
        return;
    }

    if (tmModel && !predictionInFlight) {
        const now = performance.now();
        if (now - lastPredictionTime >= PREDICTION_INTERVAL_MS) {
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

        if (!orbSkeleton && !exploding) {
            if (cn.includes("open") && best.probability > THRESH) {
                showOrb();
                if (palmNX !== null && palmNY !== null) {
                    const margin = 80;
                    orbTargetX = margin + palmNX * (window.innerWidth - margin*2);
                    orbTargetY = margin + palmNY * (window.innerHeight - margin*2);
                }
                orbLabel.textContent = "Palm open — orb follows your hand";
                orbLabel.className = "orb-label open";
            } else if (cn.includes("closed") && best.probability > THRESH) {
                hideOrb();
                orbLabel.textContent = "Hand closed — orb hidden";
                orbLabel.className = "orb-label closed";
            } else {
                orbLabel.textContent = "Idle…";
                orbLabel.className = "orb-label";
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
