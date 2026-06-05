require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);
const fs      = require("fs");
const path    = require("path");

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  port:           3000,
  frontendUrl:    "http://192.168.0.31:3000",
  reservationTTL: 1 * 60 * 1000,   // 1 min
  productionTTL:  30 * 1000,        // 30 sec
};

// ─────────────────────────────────────────
//  ORDER PERSISTENCE
// ─────────────────────────────────────────
const ORDERS_FILE = path.join(__dirname, "orders.json");

function loadOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch { return []; }
}

function saveOrder(order) {
  const orders = loadOrders();
  orders.unshift(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ─────────────────────────────────────────
//  APP
// ─────────────────────────────────────────
const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",          "*");
  res.setHeader("Access-Control-Allow-Methods",         "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",         "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

app.use(cors({ origin: "*" }));
// No-cache for HTML/JS — must be BEFORE express.static
app.use((req, res, next) => {
  if (req.path.endsWith(".js") || req.path.endsWith(".html") || req.path === "/") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'edit.html'));
});
app.use((req, res, next) => {
  if (req.path === "/webhook") return next();
  express.json()(req, res, next);
});

// ─────────────────────────────────────────
//  SLOT
// ─────────────────────────────────────────
const slot = {
  reservationId:    null,
  stripeSessionId:  null,
  layout:           [],
  status:           "idle",
  expiresAt:        null,
  productionEndsAt: null,
};

function slotFree(now = Date.now()) {
  switch (slot.status) {
    case "idle":            return true;
    case "reserved":        return slot.expiresAt <= now;
    case "pending_payment": return slot.expiresAt <= now;
    case "production":      return false;   // ONLY admin/done frees this
    default:                return true;
  }
}

function resetSlot(reason) {
  slot.reservationId    = null;
  slot.stripeSessionId  = null;
  slot.layout           = [];
  slot.status           = "idle";
  slot.expiresAt        = null;
  slot.productionEndsAt = null;
}

function secsLeft(ts, now) {
  return Math.ceil((ts - now) / 1000);
}

// ─────────────────────────────────────────
//  CLEANUP  — reservations only, never production
// ─────────────────────────────────────────
setInterval(async () => {
  // never touch production — only admin/done resets it
  if (slot.status === "production") {
    return;
  }
  if (slot.status === "idle") return;

  const now = Date.now();
  if (!slotFree(now)) return;

  if (slot.status === "pending_payment" && slot.stripeSessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(slot.stripeSessionId);
      if (session.status === "complete") return;
      await stripe.checkout.sessions.expire(slot.stripeSessionId);
    } catch {}
  }

  resetSlot("cleanup-interval");
}, 1_000);

// ─────────────────────────────────────────
//  THUMB IMAGES
// ─────────────────────────────────────────
app.get("/thumb/:index", (req, res) => {
  const i      = parseInt(req.params.index);
  const colors = ["FF0000","00FF00","FF0000","00FF00","FF0000","00FF00","FF0000","00FF00"];
  const color  = colors[i] || "888888";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="240">
  <rect width="120" height="240" fill="#${color}"/>
  <text x="60" y="128" font-family="sans-serif" font-size="48" font-weight="bold"
        fill="#000" text-anchor="middle" dominant-baseline="central">${i + 1}</text>
</svg>`;

  res.setHeader("Content-Type",  "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(svg);
});

// ─────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────
app.get("/reservation-status", (req, res) => {
  const now = Date.now();
  if (slotFree(now)) {
    return res.json({ valid: false });
  }

  if (slot.status === "reserved" || slot.status === "pending_payment") {
    return res.json({
      valid:         true,
      status:        "reserved",
      reservationId: slot.reservationId,
      endsAt:        slot.expiresAt,
      remaining:     Math.max(0, secsLeft(slot.expiresAt, now)),
    });
  }

  if (slot.status === "production") {
    const rem = secsLeft(slot.productionEndsAt, now);
    return res.json({
      valid:            true,
      status:           "production",
      reservationId:    slot.reservationId,
      productionEndsAt: slot.productionEndsAt,
      remaining:        rem,
    });
  }

  return res.json({ valid: false });
});

app.post("/reserve-slot", (req, res) => {
  const now = Date.now();
  if (!slotFree(now)) {
    const isProduction = slot.status === "production";
    const endsAt       = isProduction ? slot.productionEndsAt : slot.expiresAt;
    return res.json({
      reserved:  false,
      status:    isProduction ? "production" : "reserved",
      remaining: endsAt ? Math.max(0, secsLeft(endsAt, now)) : 0,
    });
  }

  const reservationId   = `${now}-${Math.floor(Math.random() * 1_000_000)}`;
  slot.reservationId    = reservationId;
  slot.stripeSessionId  = null;
  slot.layout           = req.body.layout || [];
  slot.status           = "reserved";
  slot.expiresAt        = now + CONFIG.reservationTTL;
  slot.productionEndsAt = null;

  return res.json({ reserved: true, reservationId, expiresAt: slot.expiresAt });
});

app.post("/release-reservation", (req, res) => {
  const { reservationId } = req.body;
  if (
    slot.reservationId !== reservationId ||
    (slot.status !== "reserved" && slot.status !== "pending_payment")
  ) return res.json({ ok: false });

  resetSlot("release-reservation");
  return res.json({ ok: true });
});

app.post("/create-checkout-session", async (req, res) => {
  const { layout, reservationId } = req.body;
  const now = Date.now();

  if (slot.reservationId !== reservationId)
    return res.status(400).json({ error: "Reservation ID mismatch" });
  if (slot.status !== "reserved")
    return res.status(400).json({ error: "Slot not in reservable state" });
  if (slot.expiresAt <= now)
    return res.status(400).json({ error: "Reservation expired" });

  slot.status = "pending_payment";

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types:    ["card"],
      mode:                    "payment",
      phone_number_collection: { enabled: true },
      line_items: [{
        price_data: {
          currency:     "usd",
          product_data: { name: "Custom Cyanotype Design" },
          unit_amount:  1000,
        },
        quantity: 1,
      }],
      metadata:    { reservationId, layout: JSON.stringify(layout) },
      success_url: `${CONFIG.frontendUrl}/edit.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${CONFIG.frontendUrl}/edit.html?canceled=true`,
    });

    slot.stripeSessionId = session.id;
    return res.json({ url: session.url });

  } catch (err) {
    slot.status = "reserved";
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ─────────────────────────────────────────
//  STRIPE WEBHOOK
// ─────────────────────────────────────────
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session       = event.data.object;
    const reservationId = session.metadata?.reservationId;
    const now           = Date.now();

    if (slot.reservationId !== reservationId) {
      if (session.payment_intent)
        await stripe.paymentIntents.cancel(session.payment_intent).catch(() => {});
      return res.json({ received: true });
    }

    if (slot.expiresAt && slot.expiresAt <= now) {
      if (session.payment_intent)
        await stripe.paymentIntents.cancel(session.payment_intent).catch(() => {});
      resetSlot("webhook-expired");
      return res.json({ received: true });
    }

    slot.status           = "production";
    slot.expiresAt        = null;
    slot.productionEndsAt = now + CONFIG.productionTTL;

    saveOrder({
      id:            reservationId,
      stripeSession: session.id,
      amount:        session.amount_total,
      currency:      session.currency,
      customerEmail: session.customer_details?.email || null,
      customerPhone: session.customer_details?.phone || null,
      layout:        JSON.parse(session.metadata?.layout || "[]"),
      paidAt:        new Date(now).toISOString(),
    });
  }

  return res.json({ received: true });
});

// ─────────────────────────────────────────
//  ADMIN AUTH
// ─────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cyanotype";

function adminAuth(req, res, next) {
  const auth = req.headers["authorization"];
  if (!auth) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Authentication required");
  }
  const [, encoded] = auth.split(" ");
  const [, password] = Buffer.from(encoded, "base64").toString().split(":");
  if (password !== ADMIN_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Wrong password");
  }
  next();
}


app.get("/admin",        (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/admin/orders", adminAuth, (req, res) => res.json(loadOrders()));

// No auth on SSE — only non-sensitive timing data, EventSource cannot send headers
app.get("/admin/events", (req, res) => {
  res.setHeader("Content-Type",        "text/event-stream");
  res.setHeader("Cache-Control",       "no-cache");
  res.setHeader("Connection",          "keep-alive");
  res.setHeader("X-Accel-Buffering",   "no");
  res.flushHeaders();

  // Tell browser to reconnect after 3s if connection drops
  res.write("retry: 3000\n\n");

  const iv = setInterval(() => {
    const payload = JSON.stringify({
      status:            slot.status,
      now:               Date.now(),
      reservationEndsAt: slot.expiresAt,
      productionEndsAt:  slot.productionEndsAt,
      reservationTTL:    CONFIG.reservationTTL,
      productionTTL:     CONFIG.productionTTL,
    });
    res.write(`data: ${payload}\n\n`);
  }, 1_000);

  req.on("close", () => clearInterval(iv));
});

app.post("/admin/notify", adminAuth, async (req, res) => {
  // Twilio SMS goes here
  res.json({ ok: true });
});

app.post("/admin/done", adminAuth, async (req, res) => {
  // Only way to free a production slot
  resetSlot("admin-done");
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  QR CODE
// ─────────────────────────────────────────
const QRCode = require("qrcode");

app.get("/qr", async (req, res) => {
  const url = `${CONFIG.frontendUrl}/edit.html`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 2, width: 300 });

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR Code</title>
<style>
  body { background:#fff; display:flex; flex-direction:column; align-items:center;
         justify-content:center; min-height:100vh; margin:0; font-family:sans-serif; gap:16px; }
  svg  { width:300px; height:300px; }
  p    { font-size:13px; color:#666; margin:0; }
</style>
</head>
<body>${svg}<p>${url}</p></body>
</html>`);
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
app.listen(CONFIG.port, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${CONFIG.port}`);
});