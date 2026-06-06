// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const CONFIG = {
api:           "",  // relative — avoids mixed-content HTTPS upgrade
syncInterval:  1_000,
snapThreshold: 0.25,
thumbLimits:   [1, 5, 1, 2, 1, 5, 1, 3],
thumbImages: [
  "/branch.svg",
  "/bubble.svg",
  "/cockatoo.svg",
  "/fuchsia.svg",
  "/grass.svg",
  "/heart.svg",
  "/hummingbird.svg",
  "/spiral.svg"
],
thumbBaseSizes: [
  1.4, // branch
  0.2, // bubble (tiny)
  1.4, // cockatoo
  1.1, // fuchsia
  1.5, // grass
  0.2, // heart
  1.0, // hummingbird
  0.9  // spiral
]
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
  get: (key) => s[key],
  get mode() { return s.mode; },

  get reservationActive() {
    return !!s.reservationEndsAt && Date.now() < s.reservationEndsAt;
  },

  get productionActive() {
    return !!s.productionEndsAt;
  },

  get checkoutBlocked() {
    return this.reservationActive || this.productionActive;
  },

  set(patch) {
    Object.assign(s, patch);
    UI.render();
  },

  setMode(newMode) {
    if (s.mode === newMode) return;
    s.mode = newMode;
    if (newMode === "edit") {
      s.reservationId      = null;
      s.reservationEndsAt  = null;
      s.productionEndsAt   = null;
      s.checkoutInProgress = false;
    }
    UI.render();
  },

  forceEdit(patch = {}) {
    s.mode               = "edit";
    s.reservationId      = null;
    s.reservationEndsAt  = null;
    s.productionEndsAt   = null;
    s.checkoutInProgress = false;
    Object.assign(s, patch);
    UI.render();
  },
};
})();


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
    el.style.opacity            = (empty || disabled) ? "0.4"  : "1";
    el.style.backgroundImage    = `url('${CONFIG.thumbImages[i]}')`;
    el.style.backgroundSize     = "contain";
    el.style.backgroundRepeat   = "no-repeat";
    el.style.backgroundPosition = "center";
    const badge = el.querySelector(".thumb-count");
    if (badge) badge.textContent = counts[i];
  });
}

function use(i) {
  if (counts[i] <= 0) return false;
  counts[i]--;
  render();
  return true;
}

function release(i) {
  counts[i] = Math.min(CONFIG.thumbLimits[i], counts[i] + 1);
  render();
}

function getCounts()      { return [...counts]; }
function setCounts(saved) { counts = saved ? [...saved] : [...CONFIG.thumbLimits]; render(); }
function reset()          { counts = [...CONFIG.thumbLimits]; render(); }

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

function save() {
  const rect   = DOM.canvas.getBoundingClientRect();
  const layout = [...DOM.canvas.querySelectorAll(".box")].map(b => ({
    left:      b.offsetLeft / rect.width,
    top:       b.offsetTop  / rect.height,
    origin:    b.dataset.origin,
    rotation:  parseFloat(b.dataset.rotation || 0),
    scale:     parseFloat(b.dataset.scale    || 1),
    baseScale: parseFloat(b.dataset.baseScale|| 1),
  }));
  localStorage.setItem(K.design, JSON.stringify({ layout, thumbCounts: Thumbs.getCounts() }));
}

function load() {
  const raw = localStorage.getItem(K.design);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {
    localStorage.removeItem(K.design);
    return null;
  }
}

function clearAll()         { Object.values(K).forEach(k => localStorage.removeItem(k)); }
function clearReservation() { localStorage.removeItem(K.resId); localStorage.removeItem(K.resEndsAt); }

function saveReservation(id, endsAt) {
  localStorage.setItem(K.resId,     id);
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
//  CANVAS
// ─────────────────────────────────────────
const Canvas = (() => {
function hasBoxes() {
  return DOM.canvas.querySelectorAll(".box").length > 0;
}

function applyTransform(box) {
  const rot       = parseFloat(box.dataset.rotation  || 0);
  const scale     = parseFloat(box.dataset.scale     || 1);
  const baseScale = parseFloat(box.dataset.baseScale || 1);
  box.style.transform = `rotate(${rot}rad) scale(${scale * baseScale})`;
}

function createBox(x, y, i) {
  const box             = document.createElement("div");
  box.className         = "box";
  box.style.left        = x + "px";
  box.style.top         = y + "px";
  box.dataset.origin    = String(i);
  box.dataset.rotation  = "0";
  box.dataset.scale     = "1";
  box.dataset.baseScale = String(CONFIG.thumbBaseSizes?.[i] ?? 1);

  const rotator     = document.createElement("div");
  rotator.className = "rotator";

  const img         = document.createElement("div");
  img.className     = "image";
  img.innerHTML     = `<img src="${CONFIG.thumbImages[i]}" class="svg-art" draggable="false" />`;

  const handle      = document.createElement("div");
  handle.className  = "handle";
  handle.innerHTML  = `
    <svg viewBox="0 0 24 24" width="20" height="20">
      <path d="M21 12a9 9 0 1 1-3-6.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <polyline points="21 3 21 8 16 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  rotator.append(img, handle);
  box.appendChild(rotator);
  applyTransform(box);

  handle.addEventListener("pointerdown", e => {
    e.preventDefault();
    e.stopPropagation();
    startRotate(box, e);
  });

  box.addEventListener("pointerdown", e => {
    if (!e.target.closest(".handle")) {
      e.preventDefault();
      startDrag(box, e);
    }
  });

  // Two-finger pinch to scale
  box.addEventListener("touchstart", e => {
    if (e.touches.length === 2) startPinch(box, e);
  }, { passive: false });

  return box;
}

function restore() {
  const data = Storage.load();
  if (!data) return;
  const rect = DOM.canvas.getBoundingClientRect();
  DOM.canvas.innerHTML = "";
  data.layout.forEach(b => {
    const box             = createBox(b.left * rect.width, b.top * rect.height, b.origin);
    box.dataset.rotation  = b.rotation  || 0;
    box.dataset.scale     = b.scale     || 1;
    box.dataset.baseScale = b.baseScale || (CONFIG.thumbBaseSizes?.[b.origin] ?? 1);
    applyTransform(box);
    DOM.canvas.appendChild(box);
  });
  Thumbs.setCounts(data.thumbCounts);
}

function clear() {
  DOM.canvas.innerHTML = "";
  Thumbs.reset();
}

function startDrag(box, e) {
  box.classList.add("dragging");
  const ox = e.clientX - box.offsetLeft;
  const oy = e.clientY - box.offsetTop;

  function onMove(ev) {
    const { width, height } = DOM.canvas.getBoundingClientRect();
    const w  = box.offsetWidth;
    const h  = box.offsetHeight;
    const ax = w * (1 - CONFIG.snapThreshold);
    const ay = h * (1 - CONFIG.snapThreshold);
    box.style.left = clamp(ev.clientX - ox, -ax, width  - (w - ax)) + "px";
    box.style.top  = clamp(ev.clientY - oy, -ay, height - (h - ay)) + "px";
  }

  function onUp(ev) {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup",   onUp);
    try { box.releasePointerCapture(ev.pointerId); } catch {}
    box.classList.remove("dragging");
    checkOutside(box);
    Storage.save();
    UI.render();
  }

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup",   onUp);
}

function startRotate(box, e) {
  box.classList.add("rotating");
  const r0   = box.getBoundingClientRect();
  const cx   = r0.left + r0.width  / 2;
  const cy   = r0.top  + r0.height / 2;
  const a0   = Math.atan2(e.clientY - cy, e.clientX - cx);
  const rot0 = parseFloat(box.dataset.rotation || 0);

  function onMove(ev) {
    const r    = box.getBoundingClientRect();
    const a    = Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2));
    let diff   = a - a0;
    if (diff >  Math.PI) diff -= 2 * Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    box.dataset.rotation = rot0 + diff;
    applyTransform(box);
  }

  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup",   onUp);
    box.classList.remove("rotating");
    applyTransform(box);
    Storage.save();
  }

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup",   onUp);
}

function startPinch(box, e) {
  // Two-finger pinch to scale
  if (e.touches.length !== 2) return;
  e.preventDefault();

  const scale0 = parseFloat(box.dataset.scale || 1);
  const t1 = e.touches[0];
  const t2 = e.touches[1];
  const dist0 = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

  function onMove(ev) {
    if (ev.touches.length !== 2) return;
    ev.preventDefault();
    const a = ev.touches[0];
    const b = ev.touches[1];
    const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const ratio = dist / dist0;
    // Clamp scale between 0.1 and 5
    box.dataset.scale = clamp(scale0 * ratio, 0.1, 5);
    applyTransform(box);
  }

  function onEnd() {
    box.removeEventListener("touchmove",  onMove);
    box.removeEventListener("touchend",   onEnd);
    box.removeEventListener("touchcancel",onEnd);
    Storage.save();
  }

  box.addEventListener("touchmove",   onMove,  { passive: false });
  box.addEventListener("touchend",    onEnd);
  box.addEventListener("touchcancel", onEnd);
}

function checkOutside(box) {
  const cr     = DOM.canvas.getBoundingClientRect();
  const br     = box.getBoundingClientRect();
  const cx     = br.left + br.width  / 2;
  const cy     = br.top  + br.height / 2;
  const inside = cx >= cr.left && cx <= cr.right && cy >= cr.top && cy <= cr.bottom;
  if (!inside) {
    Thumbs.release(Number(box.dataset.origin));
    box.remove();
    Storage.save();
    UI.render();
  }
}

return { hasBoxes, createBox, restore, clear };
})();


// ─────────────────────────────────────────
//  UI
// ─────────────────────────────────────────
const UI = (() => {
function setBtn(el, disabled, text) {
  if (!el) return;
  el.disabled = disabled;
  el.classList.toggle("disabled", disabled);
  if (text !== undefined) el.textContent = text;
}

function render() {
  if (!State.get("bootComplete")) return;
  const boxes           = Canvas.hasBoxes();
  const checkoutBlocked = State.checkoutBlocked;
  const inProduction    = !!State.get("productionEndsAt");

  setBtn(DOM.purchaseBtn, !boxes || checkoutBlocked);
  setBtn(DOM.previewBtn,  !boxes);
  DOM.purchaseBtn?.classList.toggle("locked", checkoutBlocked);
  Thumbs.render();

  if (DOM.slotCaption && DOM.slotCaptionText) {
    if (checkoutBlocked && !inProduction) {
      DOM.slotCaptionText.textContent = "Checkout in progress — stick around in case of cancellation";
      DOM.slotCaption.classList.add("visible");
    } else {
      DOM.slotCaption.classList.remove("visible");
      DOM.slotCaptionText.textContent = "";
    }
  }
}

function closeModals() {
  DOM.previewModal?.classList.remove("active");
  DOM.successModal?.classList.remove("active");
  DOM.expiredModal?.classList.remove("active");
}

function openPreview() {
  if (!Canvas.hasBoxes()) return;
  renderPreviewCanvas();
  DOM.previewModal?.classList.add("active");
}

function openSuccess() {
  closeModals();
  DOM.successModal?.classList.add("active");
  const prodEndsAt = State.get("productionEndsAt");
  const secs = prodEndsAt
    ? Math.max(0, Math.ceil((prodEndsAt - Date.now()) / 1000))
    : 30;
  startCountdown(secs);
}

function openExpired() {
  closeModals();
  DOM.expiredModal?.classList.add("active");
}

function renderPreviewCanvas() {
  DOM.previewCanvas.innerHTML = "";
  const cr    = DOM.canvas.getBoundingClientRect();
  const pr    = DOM.previewCanvas.getBoundingClientRect();
  const scale = pr.width / cr.width;
  DOM.canvas.querySelectorAll(".box").forEach(b => {
    const clone = b.cloneNode(true);
    Object.assign(clone.style, {
      position:      "absolute",
      left:          (b.offsetLeft / cr.width)  * 100 + "%",
      top:           (b.offsetTop  / cr.height) * 100 + "%",
      width:         b.offsetWidth  * scale + "px",
      height:        b.offsetHeight * scale + "px",
      transform:     b.style.transform,
      pointerEvents: "none",
    });
    DOM.previewCanvas.appendChild(clone);
  });
}

function updatePurchaseButton() {
  const btn = DOM.purchaseBtn;
  if (!btn) return;

  const now     = Date.now();
  const resEnd  = State.get("reservationEndsAt");
  const prodEnd = State.get("productionEndsAt");

  if (prodEnd) {
    const diff = Math.ceil((prodEnd - now) / 1000);
    if (diff > 0) {
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      btn.textContent = m > 0
        ? `Printing — ${m}:${String(s).padStart(2, "0")}`
        : `Printing — ${diff}s`;
      btn.classList.remove("pulse");
    } else {
      btn.textContent = "Almost done…";
      btn.classList.add("pulse");
    }
    return;
  }

  if (resEnd && now < resEnd) {
    const diff = Math.ceil((resEnd - now) / 1000);
    btn.textContent = `Checkout in progress — ${diff}s`;
    btn.classList.remove("pulse");
    return;
  }

  btn.classList.remove("pulse");
  if (!State.checkoutBlocked) {
    btn.textContent = "Purchase";
  }
}

return { render, closeModals, openPreview, openSuccess, openExpired, updatePurchaseButton };
})();


// ─────────────────────────────────────────
//  SERVER SYNC
// ─────────────────────────────────────────
const Sync = (() => {
let handle    = null;
let failCount = 0;
const MAX_FAILS = 3;

async function poll() {
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 4_000);
    const res        = await fetch(`${CONFIG.api}/reservation-status`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return;
    failCount = 0;

    const data = await res.json();

    if (!data.valid || data.status === "edit") {
      State.set({ reservationId: null, reservationEndsAt: null, productionEndsAt: null });
      State.setMode("edit");
      return;
    }

    if (data.status === "reserved") {
      State.set({
        reservationId:     data.reservationId || null,
        reservationEndsAt: data.endsAt        || null,
        productionEndsAt:  null,
      });
      return;
    }

    if (data.status === "production") {
      State.set({ productionEndsAt: data.productionEndsAt || null, reservationEndsAt: null });
      State.setMode("production");
      if (DOM.successModal?.classList.contains("active") && data.productionEndsAt) {
        const secs = Math.max(0, Math.ceil((data.productionEndsAt - Date.now()) / 1000));
        if (secs > 0) startCountdown(secs);
      }
      return;
    }

  } catch (err) {
    failCount++;
    const now        = Date.now();
    const resExpired = !State.get("reservationEndsAt") || State.get("reservationEndsAt") < now;
    const prodPresent= !!State.get("productionEndsAt");

    if (resExpired && !prodPresent && failCount >= MAX_FAILS) {
      failCount = 0;
      State.set({ reservationId: null, reservationEndsAt: null });
      State.setMode("edit");
    }
  }
}

function start() {
  if (handle) clearInterval(handle);
  handle = setInterval(poll, CONFIG.syncInterval);
}

return { poll, start };
})();


// ─────────────────────────────────────────
//  CHECKOUT
// ─────────────────────────────────────────
const Checkout = (() => {
async function begin() {
  if (State.get("checkoutInProgress") || State.checkoutBlocked) return;

  // Save current canvas state before proceeding
  Storage.save();
  const data = Storage.load();
  if (!data || !data.layout || data.layout.length === 0) return;

  State.set({ checkoutInProgress: true });

  try {
    const resJson = await post("/reserve-slot", { layout: data.layout });

    if (!resJson.reserved) {
      State.set({ checkoutInProgress: false });
      return;
    }

    const reservationEndsAt = resJson.expiresAt ?? resJson.endsAt ?? (Date.now() + 60_000);
    State.set({ reservationId: resJson.reservationId, reservationEndsAt, productionEndsAt: null });
    Storage.saveReservation(resJson.reservationId, reservationEndsAt);

    const checkoutJson = await post("/create-checkout-session", {
      layout:        data.layout,
      reservationId: resJson.reservationId,
    });

    if (checkoutJson.url) {
      window.location.href = checkoutJson.url;
      return;
    }

    const savedResId = Storage.loadReservation().id;
    if (savedResId) post("/release-reservation", { reservationId: savedResId }).catch(() => {});
    State.set({ checkoutInProgress: false });

  } catch (err) {
    const savedResId = Storage.loadReservation().id;
    if (savedResId) post("/release-reservation", { reservationId: savedResId }).catch(() => {});
    State.set({ checkoutInProgress: false });
  }
}

function releaseOnAbandon() {
  const { id } = Storage.loadReservation();
  if (id) post("/release-reservation", { reservationId: id }).catch(() => {});
  Storage.clearReservation();
  State.forceEdit();
}

async function handleStripeReturn() {
  const url       = new URL(window.location.href);
  const sessionId = url.searchParams.get("session_id");
  const canceled  = url.searchParams.get("canceled");

  url.searchParams.delete("session_id");
  url.searchParams.delete("canceled");
  window.history.replaceState({}, "", url.toString());

  if (sessionId) {
    for (let i = 0; i < 10; i++) {
      await Sync.poll();
      if (State.get("productionEndsAt")) break;
      await new Promise(r => setTimeout(r, 500));
    }
    UI.openSuccess();
    return;
  }

  if (canceled === "true") {
    const { id } = Storage.loadReservation();
    if (!id) { State.forceEdit(); return; }

    fetch(`${CONFIG.api}/reservation-status`)
      .then(r => r.json())
      .then(data => {
        if (data.valid && data.reservationId === id) {
          post("/release-reservation", { reservationId: id }).catch(() => {});
        }
        Storage.clearReservation();
        State.forceEdit();
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
  Canvas.clear();
  Storage.clearAll();
  UI.closeModals();
  State.forceEdit();
},

placeThumb(i, e) {
  if (State.get("checkoutInProgress")) return;
  if (!Thumbs.use(i)) return;
  const rect = DOM.canvas.getBoundingClientRect();
  const box  = Canvas.createBox(rect.width / 2 - 60, rect.height / 2 - 120, i);
  DOM.canvas.appendChild(box);
  Storage.save();
  UI.render();
  box.dispatchEvent(new PointerEvent("pointerdown", {
    clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, bubbles: true,
  }));
},
};


// ─────────────────────────────────────────
//  CLOCK
// ─────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  if (State.get("reservationEndsAt") && State.get("reservationEndsAt") < now) {
    State.set({ reservationId: null, reservationEndsAt: null });
  }
}, 1_000);


// ─────────────────────────────────────────
//  LISTENERS
// ─────────────────────────────────────────
function attachListeners() {
  DOM.previewBtn?.addEventListener("click",         () => UI.openPreview());
  DOM.purchaseBtn?.addEventListener("click",        () => Checkout.begin());
  DOM.resetBtn?.addEventListener("click",           () => Actions.reset());
  DOM.editBtn?.addEventListener("click",            () => UI.closeModals());
  DOM.backToEditBtn?.addEventListener("click",      () => UI.closeModals());
  DOM.notifyBtn?.addEventListener("click",          () => alert("We will notify you."));
  DOM.expiredOkBtn?.addEventListener("click",       () => UI.closeModals());
  DOM.expiredPurchaseBtn?.addEventListener("click", () => { UI.closeModals(); Checkout.begin(); });

  DOM.thumbs.forEach((el, i) => {
    el.addEventListener("pointerdown", e => { e.preventDefault(); Actions.placeThumb(i, e); });
  });
}


// ─────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  UI.closeModals();
  attachListeners();

  waitForLayout(async () => {
    Canvas.restore();

    // Release any stale reservation from a previous abandoned checkout
    const url = new URL(window.location.href);
    if (!url.searchParams.has("session_id")) {
      const { id } = Storage.loadReservation();
      if (id) {
        await post("/release-reservation", { reservationId: id }).catch(() => {});
        Storage.clearReservation();
      }
    }

    await Sync.poll();
    Checkout.handleStripeReturn();
    State.set({ bootComplete: true });
    Sync.start();

    setInterval(() => UI.updatePurchaseButton(), 200);
  });
});


// ─────────────────────────────────────────
//  VISIBILITY REFRESH
// ─────────────────────────────────────────
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    await Sync.poll();
    UI.render();
  }
});


// ─────────────────────────────────────────
//  PAGESHOW
// ─────────────────────────────────────────
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  UI.closeModals();

  const url = new URL(window.location.href);
  if (url.searchParams.has("session_id")) return;

  const { id } = Storage.loadReservation();
  if (!id) return;

  Checkout.releaseOnAbandon();
});


// ─────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

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

let countdownInterval;

function startCountdown(seconds) {
  clearInterval(countdownInterval);
  let remaining = seconds;

  countdownInterval = setInterval(() => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    if (DOM.countdownDisplay)
      DOM.countdownDisplay.textContent = `${m}:${String(s).padStart(2, "0")}`;

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      if (DOM.countdownDisplay)
        DOM.countdownDisplay.textContent = "any moment now";
    }
    remaining--;
  }, 1_000);
}