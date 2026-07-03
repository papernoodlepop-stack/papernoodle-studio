// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const CONFIG = {
 api:          "",
 syncInterval: 1_000,

 thumbLimits: [1, 1, 5, 1, 3, 1, 5, 2],

 thumbImages: [
   "/thumb/cockatoo.png",
   "/thumb/hummingbird.png",
   "/thumb/heart.png",
   "/thumb/branch.png",
   "/thumb/spiral.png",
   "/thumb/grass.png",
   "/thumb/bubble.png",
   "/thumb/fuchsia.png",
 ],

 thumbSizes: [
   { w: 144, h: 110 },
   { w: 100, h:  81 },
   { w:  60, h:  67 },
   { w: 120, h:  89 },
   { w:  90, h:  79 },
   { w: 144, h: 118 },
   { w:  60, h:  57 },
   { w:  80, h: 132 },
 ],

 thumbScale: [2.8, 2.7, 1.2, 3.2, 2.4, 3.3, 1.2, 2.3],
};

const THUMB_NAMES = [
 "Cockatoo", "Hummingbird", "Heart", "Branch",
 "Spiral",   "Grass",       "Bubble", "Fuchsia",
];

// Admin mode: add ?admin=1 to URL to see overlap dimming in preview
const ADMIN_MODE = new URLSearchParams(window.location.search).get("admin") === "1";

// ─────────────────────────────────────────
//  UTILS  (declared first — used everywhere)
// ─────────────────────────────────────────
let touchLocked = false;
let activeTouches = 0;

function blockedByTouchLock() {
 return touchLocked || activeTouches > 1;
}

document.addEventListener("touchstart", (e) => {
 activeTouches = e.touches.length;

 if (activeTouches >= 2) {
   touchLocked = true;

   // cancel current selections/editing immediately
   CanvasObjects.deselect();

   // prevent browser gestures
   e.preventDefault();
 }
}, { passive: false });

document.addEventListener("touchmove", (e) => {
 activeTouches = e.touches.length;

 if (activeTouches >= 2 || touchLocked) {
   e.preventDefault();
   e.stopPropagation();
   return false;
 }
}, { passive: false });

document.addEventListener("touchend", (e) => {
 activeTouches = e.touches.length;

 if (activeTouches === 0) {
   touchLocked = false;
 }
}, { passive: false });

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function post(path, body) {
 return fetch(CONFIG.api + path, {
   method:  "POST",
   headers: { "Content-Type": "application/json" },
   body:    JSON.stringify(body),
 }).then(r => r.json());
}

function waitForLayout(cb) {
 let lastW = 0, lastH = 0, stable = 0;
 (function check() {
   const { width, height } = DOM.canvas.getBoundingClientRect();
   stable = (width === lastW && height === lastH) ? stable + 1 : 0;
   lastW = width; lastH = height;
   stable >= 3 ? cb() : requestAnimationFrame(check);
 })();
}

let _countdownTimer;
function startCountdown(seconds) {
 clearInterval(_countdownTimer);
 let rem = seconds;
 _countdownTimer = setInterval(() => {
   const m = Math.floor(rem / 60), s = rem % 60;
   if (DOM.countdownDisplay)
     DOM.countdownDisplay.textContent = rem > 0
       ? `${m}:${String(s).padStart(2, "0")}`
       : "any moment now";
   if (rem-- <= 0) clearInterval(_countdownTimer);
 }, 1_000);
}

// ─────────────────────────────────────────
//  DOM
// ─────────────────────────────────────────
const DOM = {
 canvas:             document.getElementById("canvas"),
 previewModal:       document.getElementById("previewModal"),
 previewCanvas:      document.getElementById("previewCanvas"),
 successModal:       document.getElementById("successModal"),
 expiredModal:       document.getElementById("expiredModal"),
 previewBtn:         document.getElementById("previewBtn"),
 purchaseBtn:        document.getElementById("purchaseBtn"),
 resetBtn:           document.getElementById("startOverBtn"),
 editBtn:            document.getElementById("editBtn"),
 backToEditBtn:      document.getElementById("backToEditBtn"),
 notifyBtn:          document.getElementById("notifyBtn"),
 expiredOkBtn:       document.getElementById("expiredOkBtn"),
 expiredPurchaseBtn: document.getElementById("expiredPurchaseBtn"),
 slotCaption:        document.getElementById("slotCaption"),
 slotCaptionText:    document.getElementById("slotCaptionText"),
 countdownDisplay:   document.getElementById("countdownDisplay"),
 thumbs:             document.querySelectorAll(".thumb"),
};

// ─────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────
const State = (() => {
 const s = {
   mode:               "edit",
   reservationId:      null,
   reservationEndsAt:  null,
   productionEndsAt:   null,
   checkoutInProgress: false,
   bootComplete:       false,
 };

 return {
   get: k => s[k],
   get mode()             { return s.mode; },
   get reservationActive(){ return !!s.reservationEndsAt && Date.now() < s.reservationEndsAt; },
   get productionActive() { return !!s.productionEndsAt; },
   get checkoutBlocked()  { return this.reservationActive || this.productionActive; },

   set(patch) { Object.assign(s, patch); UI.render(); },

   setMode(m) {
     if (s.mode === m) return;
     s.mode = m;
     if (m === "edit") {
       s.reservationId = null; s.reservationEndsAt = null;
       s.productionEndsAt = null; s.checkoutInProgress = false;
     }
     UI.render();
   },

   forceEdit(patch = {}) {
     s.mode = "edit"; s.reservationId = null; s.reservationEndsAt = null;
     s.productionEndsAt = null; s.checkoutInProgress = false;
     Object.assign(s, patch); UI.render();
   },
 };
})();

// ─────────────────────────────────────────
//  THUMBS
// ─────────────────────────────────────────
const Thumbs = (() => {
 let counts = [...CONFIG.thumbLimits];

 function render() {
   const disabled = State.get("checkoutInProgress");
   DOM.thumbs.forEach((el, i) => {
     const empty = counts[i] <= 0;
     el.classList.toggle("empty", empty);
     el.style.pointerEvents      = (empty || disabled) ? "none" : "auto";
     el.style.opacity            = (empty || disabled) ? "0.4" : "1";
     el.style.backgroundImage    = `url('${CONFIG.thumbImages[i]}')`;
     el.style.backgroundSize     = "contain";
     el.style.backgroundRepeat   = "no-repeat";
     el.style.backgroundPosition = "center";
     el.style.cursor             = empty ? "default" : "pointer";
     el.style.position           = "relative";

     // Dot indicator bar
     let bar = el.querySelector(".thumb-dots");
     if (!bar) {
       bar = document.createElement("div");
       bar.className = "thumb-dots";
       bar.style.cssText = "position:absolute;bottom:3px;left:50%;transform:translateX(-50%);display:flex;gap:3px;pointer-events:none;";
       el.appendChild(bar);
     }
     bar.innerHTML = "";
     const limit = CONFIG.thumbLimits[i];
     if (limit > 1) {
       for (let d = 0; d < limit; d++) {
         const dot = document.createElement("div");
         dot.style.cssText = `width:5px;height:5px;border-radius:50%;background:#fff;opacity:${d < counts[i] ? 1 : 0.3}`;
         bar.appendChild(dot);
       }
     }
   });
 }

 function use(i)     { if (!counts[i]) return false; counts[i]--; render(); return true; }
 function release(i) { counts[i] = Math.min(CONFIG.thumbLimits[i], counts[i] + 1); render(); }
 function getCounts()       { return [...counts]; }
 function setCounts(saved)  { counts = saved ? [...saved] : [...CONFIG.thumbLimits]; render(); }
 function reset()           { counts = [...CONFIG.thumbLimits]; render(); }

 return { render, use, release, getCounts, setCounts, reset };
})();

// ─────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────
const Storage = (() => {
 const K = {
   design:    "savedDesign",
   resId:     "reservationId",
   resEndsAt: "reservationEndsAt",
 };

 const save = () =>
   localStorage.setItem(K.design, JSON.stringify({
     layout:      CanvasObjects.getLayout(),
     thumbCounts: Thumbs.getCounts(),
   }));

 function load() {
   const raw = localStorage.getItem(K.design);
   if (!raw) return null;
   try { return JSON.parse(raw); }
   catch { localStorage.removeItem(K.design); return null; }
 }

 const clearAll         = () => Object.values(K).forEach(k => localStorage.removeItem(k));
 const clearReservation = () => { localStorage.removeItem(K.resId); localStorage.removeItem(K.resEndsAt); };

 function saveReservation(id, endsAt) {
   localStorage.setItem(K.resId, id);
   localStorage.setItem(K.resEndsAt, endsAt);
 }

 function loadReservation() {
   return {
     id:     localStorage.getItem(K.resId),
     endsAt: parseInt(localStorage.getItem(K.resEndsAt), 10) || null,
   };
 }

 return { save, load, clearAll, clearReservation, saveReservation, loadReservation };
})();

// ─────────────────────────────────────────
//  CANVAS OBJECTS
// ─────────────────────────────────────────
const CanvasObjects = (() => {
 let objects    = [];
 let nextId     = 0;
 let selectedId = null;
 const typeSeq  = CONFIG.thumbLimits.map(() => 0);

 // ── Z-order ────────────────────────────
 function compactZ() {
   [...objects].sort((a, b) => a.z - b.z).forEach((o, i) => { o.z = 10 + i; });
 }
 function applyZ() {
   objects.forEach(o => {
     const el = DOM.canvas.querySelector(`[data-id="${o.id}"]`);
     if (el) el.style.zIndex = String(o.z);
   });
 }

 // ── Interactivity ──────────────────────
 // When nothing selected: ALL objects are tappable (natural top-wins hit-test).
 // When something selected: only the selected object gets pointer events;
 //   all others dim and become inert so controls always hit the right target.
 function updateInteractivity() {
   objects.forEach(o => {
     const el = DOM.canvas.querySelector(`[data-id="${o.id}"]`);
     if (!el) return;
     const isSel = o.id === selectedId;
     const none  = selectedId !== null && !isSel;
     el.style.pointerEvents = none ? "none" : "all";
     el.style.opacity       = none ? "0.4"  : "1";
     el.style.cursor        = isSel ? "grab" : "pointer";
   });
 }

 // ── Floating panel (position:fixed, outside #canvas) ──
 let panel = null;

 function ensurePanel() {
   if (blockedByTouchLock()) return;
   if (panel) return;
   panel = document.createElement("div");
   panel.id = "ctrl-panel";
   panel.style.cssText = [
     "position:fixed", "display:none", "gap:4px", "align-items:center",
     "background:#4a5060", "border:1px solid #6b7280", "border-radius:8px",
     "padding:4px 6px", "z-index:99999",
     "touch-action:manipulation", "pointer-events:all",
     "box-shadow:0 4px 14px rgba(0,0,0,0.35)",
   ].join(";");

   // Order: rotate | fwd | bck | del | done(last)
   [
     { id:"cp-rotate", label:"↻", title:"Rotate",         danger:false },
     { id:"cp-fwd",    label:"↑", title:"Bring forward",  danger:false },
     { id:"cp-bck",    label:"↓", title:"Send backward",  danger:false },
     { id:"cp-del",    label:"✕", title:"Remove",         danger:true  },
     { id:"cp-done",   label:"✓", title:"Done",           danger:false },
   ].forEach(b => {
     const btn = document.createElement("button");
     btn.id = b.id; btn.title = b.title; btn.textContent = b.label;
     const isCheck = b.id === "cp-done";
     btn.style.cssText = [
       "width:36px", "height:36px", "border-radius:6px",
       "border:1px solid #ccc", "background:#fff",
       "font-size:17px", "line-height:1", "cursor:pointer",
       "display:flex", "align-items:center", "justify-content:center",
       b.danger ? "color:#e53935" : isCheck ? "color:#2e7d32" : "color:#333",
     ].join(";");
     btn.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); handlePanel(b.id, e); });
     panel.appendChild(btn);
   });
   document.body.appendChild(panel);
 }

 function handlePanel(id, e) {
   if (id === "cp-done") { deselect(); return; }

   const o = objects.find(o => o.id === selectedId);
   if (!o) return;

   if (id === "cp-rotate") {
     startFreeRotate(o, e);
     return;
   }

   if (id === "cp-fwd" || id === "cp-bck") {
     // z values are always kept compact (no gaps), so sort → swap → apply
     // is always a single-step move with no normalisation pass eating the click.
     const sorted = [...objects].sort((a, b) => a.z - b.z);
     const i = sorted.findIndex(x => x.id === o.id);
     if (id === "cp-fwd" && i < sorted.length - 1) {
       const tmp = sorted[i].z; sorted[i].z = sorted[i+1].z; sorted[i+1].z = tmp;
     } else if (id === "cp-bck" && i > 0) {
       const tmp = sorted[i].z; sorted[i].z = sorted[i-1].z; sorted[i-1].z = tmp;
     }
        applyZ();
 positionPanel();
 Storage.save();
 return;
}

   if (id === "cp-del") {
     Thumbs.release(o.itemIdx);
     DOM.canvas.querySelector(`[data-id="${o.id}"]`)?.remove();
     objects.splice(objects.indexOf(o), 1);
     selectedId = null;
     compactZ(); applyZ(); hidePanel(); updateInteractivity();
     Storage.save(); UI.render();
   }
 }

 function positionPanel() {
   ensurePanel();
   if (selectedId === null) { hidePanel(); return; }
   const o = objects.find(o => o.id === selectedId);
   if (!o) { hidePanel(); return; }

   const cr = DOM.canvas.getBoundingClientRect();
   const cx = cr.left + o.x + o.w / 2;
   const cy = cr.top  + o.y;

   panel.style.visibility = "hidden";
   panel.style.display    = "flex";
   const pw = panel.offsetWidth, ph = panel.offsetHeight;
   panel.style.visibility = "";

   panel.style.left = `${clamp(cx - pw / 2, 8, window.innerWidth  - pw - 8)}px`;
   panel.style.top  = `${Math.max(8, cy - ph - 12)}px`;
 }

 const hidePanel = () => { if (panel) panel.style.display = "none"; };

 // ── Free rotate — triggered by panel button, drag anywhere ──
 // No handle element on the image. After pressing ↻, the next
 // pointermove anywhere on the document rotates the object.
 function startFreeRotate(o, triggerEvent) {
   if (blockedByTouchLock()) return;
   const el = DOM.canvas.querySelector(`[data-id="${o.id}"]`);
   if (!el) return;

   // Lock center at activation time
   const r  = el.getBoundingClientRect();
   const cx = r.left + r.width  / 2;
   const cy = r.top  + r.height / 2;
   const a0 = Math.atan2(triggerEvent.clientY - cy, triggerEvent.clientX - cx);
   const r0 = o.rotation;

   document.body.style.cursor = "crosshair";

   function onMove(ev) {
     if (blockedByTouchLock()) return;
     let d = Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0;
     if (d >  Math.PI) d -= 2 * Math.PI;
     if (d < -Math.PI) d += 2 * Math.PI;
     o.rotation = r0 + d;
     el.style.transform = `rotate(${o.rotation}rad)`;
   }
   function onUp() {
     document.removeEventListener("pointermove", onMove);
     document.removeEventListener("pointerup", onUp);
     document.body.style.cursor = "";
     positionPanel();
     Storage.save();
   }
   document.addEventListener("pointermove", onMove);
   document.addEventListener("pointerup", onUp);
 }

 // ── Build DOM element for one object ───
 function buildEl(o) {
   const el = document.createElement("div");
   el.className  = "box";
   el.dataset.id = o.id;
   el.style.cssText = [
     `left:${o.x}px`, `top:${o.y}px`,
     `width:${o.w}px`, `height:${o.h}px`,
     `z-index:${o.z}`,
     `transform:rotate(${o.rotation}rad)`,
     "position:absolute", "touch-action:none", "pointer-events:all",
     "will-change:transform", "cursor:grab",
     "transition:opacity .15s ease",
   ].join(";");

   // Image
   const img = document.createElement("img");
   img.src = CONFIG.thumbImages[o.itemIdx]; img.className = "svg-art"; img.draggable = false;
   img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;";
  
   el.appendChild(img);

   // Instance badge (multi-limit items only)
   if (CONFIG.thumbLimits[o.itemIdx] > 1) {
     const badge = document.createElement("div");
     badge.className = "instance-badge"; badge.textContent = o.seq;
     badge.style.cssText = "position:absolute;top:3px;right:3px;font-size:10px;font-weight:600;background:rgba(0,0,0,0.5);color:#fff;border-radius:4px;padding:1px 4px;pointer-events:none;";
     el.appendChild(badge);
   }

   // Selection outline
   const outline = document.createElement("div");
   outline.className = "sel-outline";
   outline.style.cssText = "position:absolute;inset:-3px;border:2px solid #378ADD;border-radius:3px;pointer-events:none;display:none;";
   el.appendChild(outline);


   // ── Pointer handling ─────────────────
   let lpTimer = null, didMove = false;

   el.addEventListener("pointerdown", e => {
     if (blockedByTouchLock()) return;
     e.preventDefault(); e.stopPropagation();
     didMove = false;

     // Long-press: show layer picker (only when there are overlaps)
     lpTimer = setTimeout(() => {
       if (didMove) return;
       const cr = DOM.canvas.getBoundingClientRect();
       const px = e.clientX - cr.left, py = e.clientY - cr.top;
       const overlaps = objects.filter(obj =>
         px >= obj.x && px <= obj.x + obj.w &&
         py >= obj.y && py <= obj.y + obj.h
       );
       if (overlaps.length > 1) showPicker(e);
     }, 500);

     const isNewSelection = o.id !== selectedId;

if (isNewSelection) {
  selectObj(o.id);
}

// DO NOT return — allow long-press timer to continue

     // Already selected: begin drag
     el.setPointerCapture(e.pointerId);
     startDrag(o.id, e, () => { didMove = true; clearTimeout(lpTimer); lpTimer = null; });
   });

   el.addEventListener("pointerup",     () => clearTimeout(lpTimer));
   el.addEventListener("pointercancel", () => clearTimeout(lpTimer));

   return el;
 }

 // ── Selection ───────────────────────────
 function selectObj(id) {
   selectedId = id;
   objects.forEach(o => {
     const el = DOM.canvas.querySelector(`[data-id="${o.id}"]`);
     if (!el) return;
     el.querySelector(".sel-outline").style.display = o.id === id ? "block" : "none";
   });
   updateInteractivity();
   positionPanel();
   hidePicker();
 }

 function deselect() {
   selectedId = null;
   objects.forEach(o => {
     const el = DOM.canvas.querySelector(`[data-id="${o.id}"]`);
     if (!el) return;
     el.querySelector(".sel-outline").style.display = "none";
   });
   hidePanel();
   updateInteractivity();
   hidePicker();
 }

 // ── Drag ────────────────────────────────
 function startDrag(objId, e, onFirstMove) {
   const o  = objects.find(o => o.id === objId); if (!o) return;
   const el = DOM.canvas.querySelector(`[data-id="${objId}"]`);
   const cr = DOM.canvas.getBoundingClientRect();
   const ox = e.clientX - cr.left - o.x;
   const oy = e.clientY - cr.top  - o.y;
   let moved = false;
   const VISIBLE = 50;

   function onMove(ev) {
     if (blockedByTouchLock()) return;
     if (!moved) { moved = true; if (onFirstMove) onFirstMove(); }
     const r = DOM.canvas.getBoundingClientRect();
     o.x = clamp(ev.clientX - r.left - ox, -(o.w - VISIBLE), r.width  - VISIBLE);
     o.y = clamp(ev.clientY - r.top  - oy, -(o.h - VISIBLE), r.height - VISIBLE);
     if (el) { el.style.left = `${o.x}px`; el.style.top = `${o.y}px`; }
   }
   function onUp() {
     document.removeEventListener("pointermove", onMove);
     document.removeEventListener("pointerup", onUp);
     positionPanel(); Storage.save();
   }
   document.addEventListener("pointermove", onMove);
   document.addEventListener("pointerup", onUp);
 }

 // ── Layer picker ────────────────────────
 let picker = null;

let pickerRotation = 0;
pickerRotation =
 parseInt(localStorage.getItem("pickerRotation"), 10) || 0;

 function applyPickerRotation() {
 if (!picker) return;

 picker.style.transform =
   `rotate(${pickerRotation}deg)`;

 picker.style.transformOrigin = "center center";
}

 function ensurePicker() {
   if (picker) return;
   picker = document.createElement("div");
   picker.id = "layer-picker";
   picker.style.cssText = [
     "position:fixed", "display:none", "flex-direction:column",
     "gap:2px", "padding:6px",
     "background:#2f3542", "color:#fff", "border:1px solid #555",
     "border-radius:8px", "z-index:99998", "min-width:150px",
     "box-shadow:0 4px 14px rgba(0,0,0,0.55)",
   ].join(";");
   document.body.appendChild(picker);
   // Dismiss on outside tap
   document.addEventListener("pointerdown", ev => {
     if (!ev.target.closest("#layer-picker")) hidePicker();
   }, true);
 }

 function showPicker(e) {
   if (touchLocked || activeTouches > 1) return;
   ensurePicker();
   const cr = DOM.canvas.getBoundingClientRect();
   const px = e.clientX - cr.left, py = e.clientY - cr.top;
   const hits = objects
     .filter(o => px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h)
     .sort((a, b) => b.z - a.z);
   if (hits.length < 2) return;

   picker.innerHTML = "";

   const header = document.createElement("div");
header.style.cssText = `
 display:flex;
 align-items:center;
 justify-content:space-between;
 gap:8px;
 padding:2px 6px 5px;
`;

const lbl = document.createElement("div");
lbl.textContent = "Select layer";
lbl.style.cssText =
 "font-size:11px;color:#aaa;letter-spacing:.04em;text-transform:uppercase;";

const rotBtn = document.createElement("button");
rotBtn.textContent = "↻";
rotBtn.title = "Rotate picker";
rotBtn.style.cssText = `
 width:36px;
 height:36px;
 border:none;
 border-radius:6px;
 background:#4a5568;
 color:#fff;
 cursor:pointer;
 font-size:20px;
 font-weight:bold;
 display:flex;
 align-items:center;
 justify-content:center;
 flex-shrink:0;
`;

rotBtn.addEventListener("pointerdown", ev => {
 ev.preventDefault();
 ev.stopPropagation();

  pickerRotation = (pickerRotation + 90) % 360;

 localStorage.setItem(
   "pickerRotation",
   String(pickerRotation)
 );

 applyPickerRotation();
});

header.append(lbl, rotBtn);
picker.appendChild(header);

   hits.forEach((o, i) => {
     const name = CONFIG.thumbLimits[o.itemIdx] > 1
       ? `${THUMB_NAMES[o.itemIdx]} #${o.seq}`
       : THUMB_NAMES[o.itemIdx];

     const row = document.createElement("div");
     row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;color:#eee;";

     const nameSpan = document.createElement("span");
     nameSpan.textContent = name; nameSpan.style.pointerEvents = "none";
     row.appendChild(nameSpan);

     if (i === 0) {
       const tag = document.createElement("span");
       tag.textContent = "top"; tag.style.cssText = "font-size:10px;color:#888;pointer-events:none;";
       row.appendChild(tag);
     }

     row.addEventListener("pointerover", () => row.style.background = "#4a5568");
     row.addEventListener("pointerout",  () => row.style.background = "");
     row.addEventListener("pointerdown", ev => { ev.stopPropagation(); hidePicker(); selectObj(o.id); });
     picker.appendChild(row);
   });

   picker.style.display = "flex";
   applyPickerRotation();
   let lx = e.clientX + 10, ly = e.clientY - 16;
   if (lx + 160 > window.innerWidth)  lx = e.clientX - 165;
   if (ly + 200 > window.innerHeight) ly = window.innerHeight - 210;
   picker.style.left = `${lx}px`;
   picker.style.top  = `${ly}px`;
 }

 const hidePicker = () => { if (picker) picker.style.display = "none"; };

 // Canvas background tap → deselect
 DOM.canvas.addEventListener("pointerdown", e => {
   if (e.target === DOM.canvas) deselect();
 });
 DOM.canvas.addEventListener("contextmenu", e => e.preventDefault());

 // ── Public API ──────────────────────────
 return {
   hasBoxes()  { return objects.length > 0; },
   getAll()    { return [...objects]; },
   getLayout() {
 const cr = DOM.canvas.getBoundingClientRect();
 return objects.map(o => ({
   left: o.x / cr.width,
   top: o.y / cr.height,
   origin: o.itemIdx,
   rotation: o.rotation,
   z: o.z,
 }));
},

   place(itemIdx) {
 const size = CONFIG.thumbSizes[itemIdx];
 const sc   = CONFIG.thumbScale[itemIdx] ?? 1;
 const w    = Math.round(size.w * sc);
 const h    = Math.round(size.h * sc);

 const cr   = DOM.canvas.getBoundingClientRect();
 const off  = (objects.length % 6) * 16;

 typeSeq[itemIdx]++;

 const o = {
   id: nextId++,
   itemIdx,
   seq: typeSeq[itemIdx],

   x: (cr.width  - w) / 2 + off,
   y: (cr.height - h) / 2 + off,

   w,
   h,
   rotation: 0,
   z: objects.length + 10,
 };

 objects.push(o);
 DOM.canvas.appendChild(buildEl(o));
 selectObj(o.id);
 Storage.save();
},

   clear() {
     objects = []; nextId = 0; selectedId = null;
     DOM.canvas.innerHTML = "";
     hidePanel(); hidePicker();
     typeSeq.fill(0);
   },

   restore() {
     const data = Storage.load(); if (!data) return;
     const cr = DOM.canvas.getBoundingClientRect();
     DOM.canvas.innerHTML = ""; objects = [];
     selectedId = null;

     hidePanel();
     hidePicker();

     (data.layout || []).forEach(saved => {
       const itemIdx = Number(saved.origin);
       typeSeq[itemIdx]++;
       const { w: bw, h: bh } = CONFIG.thumbSizes[itemIdx];
       const sc = CONFIG.thumbScale[itemIdx] ?? 1;
       const w  = Math.round(bw * sc), h = Math.round(bh * sc);
       const o  = {
         id: nextId++, itemIdx, seq: typeSeq[itemIdx],
         x: saved.left * cr.width, y: saved.top * cr.height,
         w, h, rotation: saved.rotation || 0, z: saved.z ?? (10 + objects.length),
       };
       objects.push(o);
       DOM.canvas.appendChild(buildEl(o));
     });

     compactZ();
     applyZ();

     Thumbs.setCounts(data.thumbCounts);
     updateInteractivity();
   },
     deselect, hidePanel,
 };
})();

// ─────────────────────────────────────────
//  UI
// ─────────────────────────────────────────
const UI = (() => {
 function setBtn(el, disabled, text) {
   if (!el) return;
   el.disabled = disabled; el.classList.toggle("disabled", disabled);
   if (text !== undefined) el.textContent = text;
 }

 function render() {
   if (!State.get("bootComplete")) return;
   const boxes = CanvasObjects.hasBoxes();
   const blocked = State.checkoutBlocked;
   const inProd  = !!State.get("productionEndsAt");

   setBtn(DOM.purchaseBtn, !boxes || blocked);
   setBtn(DOM.previewBtn,  !boxes);
   DOM.purchaseBtn?.classList.toggle("locked", blocked);
   Thumbs.render();

   if (DOM.slotCaption && DOM.slotCaptionText) {
     const show = blocked && !inProd;
     DOM.slotCaption.classList.toggle("visible", show);
     DOM.slotCaptionText.textContent = show
       ? "Checkout in progress — stick around in case of cancellation" : "";
   }
 }

 function closeModals() {
   DOM.previewModal?.classList.remove("active");
   DOM.successModal?.classList.remove("active");
   DOM.expiredModal?.classList.remove("active");
   CanvasObjects.hidePanel();
 }

 function openPreview() {
   if (!CanvasObjects.hasBoxes()) return;
   CanvasObjects.deselect();
   renderPreviewCanvas();
   DOM.previewModal?.classList.add("active");
 }

 function renderPreviewCanvas() {
   DOM.previewCanvas.innerHTML = "";
   const cr    = DOM.canvas.getBoundingClientRect();
   const pr    = DOM.previewCanvas.getBoundingClientRect();
   const scale = pr.width / cr.width;
   const all   = CanvasObjects.getAll();

   // Draw bottom → top so stacking matches canvas
   [...all].sort((a, b) => a.z - b.z).forEach(o => {
     const wrap = document.createElement("div");
     // Dim objects that have anything above them so buried layers read as lighter
     const hasAbove = ADMIN_MODE && all.some(other => other.id !== o.id && other.z > o.z);
     Object.assign(wrap.style, {
       position: "absolute",
       left: `${(o.x / cr.width) * 100}%`,
       top:  `${(o.y / cr.height) * 100}%`,
       width:  `${o.w * scale}px`,
       height: `${o.h * scale}px`,
       transform: `rotate(${o.rotation}rad)`,
       filter: "drop-shadow(0 0 6px rgba(0,0,0,0.7))",
       opacity: hasAbove ? "0.45" : "1",
       pointerEvents: "none",
     });
     const img = document.createElement("img");
     img.src = CONFIG.thumbImages[o.itemIdx];
     img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
     wrap.appendChild(img);

     DOM.previewCanvas.appendChild(wrap);
   });

   // Stack-order legend (top → bottom, human-readable)
   if (all.length > 1) {
     const legend = document.createElement("div");
     legend.style.cssText = [
       "position:absolute", "top:10px", "right:10px",
       "background:transparent", "color:#000",
       "font-size:12px", "line-height:1.6",
       "pointer-events:none", "z-index:9999",
       "max-width:160px",
     ].join(";");

     const title = document.createElement("div");
     title.textContent = "Stack order";
     title.style.cssText = "font-weight:700;margin-bottom:4px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.5;";
     legend.appendChild(title);

     // Sort top → bottom for display
     [...all].sort((a, b) => b.z - a.z).forEach((o, i) => {
       const name = CONFIG.thumbLimits[o.itemIdx] > 1
         ? `${THUMB_NAMES[o.itemIdx]} #${o.seq}`
         : THUMB_NAMES[o.itemIdx];
       const row = document.createElement("div");
       row.textContent = `${i + 1}. ${name}`;
       legend.appendChild(row);
     });

     DOM.previewCanvas.appendChild(legend);
   }
 }

 function openSuccess() {
   closeModals(); DOM.successModal?.classList.add("active");
   const end = State.get("productionEndsAt");
   startCountdown(end ? Math.max(0, Math.ceil((end - Date.now()) / 1000)) : 30);
 }

 function openExpired() { closeModals(); DOM.expiredModal?.classList.add("active"); }

 function updatePurchaseButton() {
   const btn = DOM.purchaseBtn; if (!btn) return;
   const now = Date.now();
   const resEnd  = State.get("reservationEndsAt");
   const prodEnd = State.get("productionEndsAt");

   if (prodEnd) {
     const d = Math.ceil((prodEnd - now) / 1000);
     if (d > 0) {
       const m = Math.floor(d / 60), s = d % 60;
       btn.textContent = m > 0 ? `Printing — ${m}:${String(s).padStart(2,"0")}` : `Printing — ${d}s`;
       btn.classList.remove("pulse");
     } else { btn.textContent = "Almost done…"; btn.classList.add("pulse"); }
     return;
   }
   if (resEnd && now < resEnd) {
     btn.textContent = `Checkout in progress — ${Math.ceil((resEnd - now) / 1000)}s`;
     btn.classList.remove("pulse"); return;
   }
   btn.classList.remove("pulse");
   if (!State.checkoutBlocked) btn.textContent = "Purchase";
 }

 return { render, closeModals, openPreview, openSuccess, openExpired, updatePurchaseButton };
})();

// ─────────────────────────────────────────
//  SYNC
// ─────────────────────────────────────────
const Sync = (() => {
 let handle = null, fails = 0;
 const MAX = 3;

 async function poll() {
   try {
     const ctrl = new AbortController();
     const t    = setTimeout(() => ctrl.abort(), 4_000);
     const res  = await fetch(`${CONFIG.api}/reservation-status`, { signal: ctrl.signal });
     clearTimeout(t);
     if (!res.ok) return;
     fails = 0;
     const d = await res.json();

     if (!d.valid || d.status === "edit") {
       State.set({ reservationId:null, reservationEndsAt:null, productionEndsAt:null });
       State.setMode("edit"); return;
     }
     if (d.status === "reserved") {
       State.set({ reservationId:d.reservationId||null, reservationEndsAt:d.endsAt||null, productionEndsAt:null });
       return;
     }
     if (d.status === "production") {
       State.set({ productionEndsAt:d.productionEndsAt||null, reservationEndsAt:null });
       State.setMode("production");
       if (DOM.successModal?.classList.contains("active") && d.productionEndsAt) {
         const s = Math.max(0, Math.ceil((d.productionEndsAt - Date.now()) / 1000));
         if (s > 0) startCountdown(s);
       }
     }
   } catch {
     if (++fails >= MAX) {
       const now = Date.now();
       if ((!State.get("reservationEndsAt") || State.get("reservationEndsAt") < now) && !State.get("productionEndsAt")) {
         fails = 0; State.set({ reservationId:null, reservationEndsAt:null }); State.setMode("edit");
       }
     }
   }
 }

 function start() { if (handle) clearInterval(handle); handle = setInterval(poll, CONFIG.syncInterval); }
 return { poll, start };
})();

// ─────────────────────────────────────────
//  CHECKOUT
// ─────────────────────────────────────────
const Checkout = (() => {
 async function begin() {
   if (State.get("checkoutInProgress") || State.checkoutBlocked) return;
   Storage.save();
   const data = Storage.load();
   if (!data?.layout?.length) return;
   State.set({ checkoutInProgress: true });

   try {
     const res = await post("/reserve-slot", { layout: data.layout });
     if (!res.reserved) { State.set({ checkoutInProgress: false }); return; }

     const endsAt = res.expiresAt ?? res.endsAt ?? (Date.now() + 60_000);
     State.set({ reservationId: res.reservationId, reservationEndsAt: endsAt, productionEndsAt: null });
     Storage.saveReservation(res.reservationId, endsAt);

     const cx = await post("/create-checkout-session", { layout: data.layout, reservationId: res.reservationId });
     if (cx.url) { window.location.href = cx.url; return; }

     const { id } = Storage.loadReservation();
     if (id) post("/release-reservation", { reservationId: id }).catch(() => {});
     State.set({ checkoutInProgress: false });

   } catch {
     const { id } = Storage.loadReservation();
     if (id) post("/release-reservation", { reservationId: id }).catch(() => {});
     State.set({ checkoutInProgress: false });
   }
 }

 function releaseOnAbandon() {
   const { id } = Storage.loadReservation();
   if (id) post("/release-reservation", { reservationId: id }).catch(() => {});
   Storage.clearReservation(); State.forceEdit();
 }

 async function handleStripeReturn() {
   const url       = new URL(window.location.href);
   const sessionId = url.searchParams.get("session_id");
   const canceled  = url.searchParams.get("canceled");
   url.searchParams.delete("session_id"); url.searchParams.delete("canceled");
   window.history.replaceState({}, "", url.toString());

   if (sessionId) {
     for (let i = 0; i < 10; i++) {
       await Sync.poll();
       if (State.get("productionEndsAt")) break;
       await new Promise(r => setTimeout(r, 500));
     }
     UI.openSuccess(); return;
   }

   if (canceled === "true") {
     const { id } = Storage.loadReservation();
     if (!id) { State.forceEdit(); return; }
     fetch(`${CONFIG.api}/reservation-status`)
       .then(r => r.json())
       .then(d => {
         if (d.valid && d.reservationId === id)
           post("/release-reservation", { reservationId: id }).catch(() => {});
         Storage.clearReservation(); State.forceEdit();
       })
       .catch(() => releaseOnAbandon());
   }
 }

 return { begin, handleStripeReturn, releaseOnAbandon };
})();

// ─────────────────────────────────────────
//  ACTIONS
// ─────────────────────────────────────────
const Actions = {
 reset() {
   CanvasObjects.clear(); Thumbs.reset();
   Storage.clearAll(); UI.closeModals(); State.forceEdit();
 },
 placeThumb(i) {
   if (State.get("checkoutInProgress")) return;
   if (!Thumbs.use(i)) return;
   CanvasObjects.place(i); UI.render();
 },
};

// ─────────────────────────────────────────
//  RESERVATION CLOCK
// ─────────────────────────────────────────
setInterval(() => {
 if (State.get("reservationEndsAt") && State.get("reservationEndsAt") < Date.now())
   State.set({ reservationId: null, reservationEndsAt: null });
}, 1_000);

// ─────────────────────────────────────────
//  LISTENERS
// ─────────────────────────────────────────
function attachListeners() {
 DOM.previewBtn?.addEventListener("click",         () => UI.openPreview());
 DOM.purchaseBtn?.addEventListener("click",        () => Checkout.begin());
 console.log("purchase clicked");
 DOM.resetBtn?.addEventListener("click",           () => Actions.reset());
 DOM.editBtn?.addEventListener("click",            () => UI.closeModals());
 DOM.backToEditBtn?.addEventListener("click",      () => UI.closeModals());
 DOM.notifyBtn?.addEventListener("click",          () => alert("We will notify you."));
 DOM.expiredOkBtn?.addEventListener("click",       () => UI.closeModals());
 DOM.expiredPurchaseBtn?.addEventListener("click", () => { UI.closeModals(); Checkout.begin(); });

 DOM.thumbs.forEach((el, i) =>
   el.addEventListener("pointerdown", e => { if (blockedByTouchLock()) return; e.preventDefault(); Actions.placeThumb(i); })
 );
}

// ─────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
 UI.closeModals();
 attachListeners();

 waitForLayout(async () => {
   CanvasObjects.restore();

   const url = new URL(window.location.href);
   if (!url.searchParams.has("session_id")) {
     const { id } = Storage.loadReservation();
     if (id) { await post("/release-reservation", { reservationId: id }).catch(() => {}); Storage.clearReservation(); }
   }

   await Sync.poll();
   Checkout.handleStripeReturn();
   State.set({ bootComplete: true });
   Sync.start();
   setInterval(() => UI.updatePurchaseButton(), 1000);
 });
});

document.addEventListener("visibilitychange", async () => {
 if (document.visibilityState === "visible") { await Sync.poll(); UI.render(); }
});

window.addEventListener("pageshow", e => {
 if (!e.persisted) return;
 UI.closeModals();
 if (new URL(window.location.href).searchParams.has("session_id")) return;
 const { id } = Storage.loadReservation();
 if (id) Checkout.releaseOnAbandon();
});


// ─────────────────────────────────────────
// HELP POPUP
// ─────────────────────────────────────────

const infoBtn = document.getElementById("infoBtn");
const helpPopup = document.getElementById("helpPopup");

if (infoBtn && helpPopup) {
  infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    helpPopup.style.display =
      helpPopup.style.display === "block" ? "none" : "block";
  });

  document.addEventListener("click", () => {
    helpPopup.style.display = "none";
  });

  helpPopup.addEventListener("click", (e) => {
    e.stopPropagation();
  });
}