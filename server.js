require("dotenv").config();

const express  = require("express");
const stripe   = require("stripe")(process.env.STRIPE_SECRET_KEY);
const fs       = require("fs");
const path     = require("path");
const { MongoClient } = require("mongodb");

const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  port:           3000,
  // Base origin only — page paths (/edit.html etc.) are appended where used.
  frontendUrl:    "http://192.168.0.7:3000",
  reservationTTL: 10 * 60 * 1000,  // 10 min
  productionTTL:  15 * 60 * 1000,  // 15 min
};

// ─────────────────────────────────────────
//  ADMIN AUTH — fail loudly if not configured, never fall back to a guessable default
// ─────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("❌ ADMIN_PASSWORD is not set in the environment. Refusing to start with an unprotected admin panel.");
  process.exit(1);
}

// ─────────────────────────────────────────
//  MONGODB — real persistence, survives every Render redeploy.
// ─────────────────────────────────────────
// Render's free-tier disk is ephemeral: every deploy spins up a brand new
// container, so anything written to a local file (like the old orders.json)
// is wiped the moment the next deploy happens. MongoDB Atlas (or any
// external DB) lives outside that container entirely, so orders persist
// no matter how many times the app redeploys.
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is not set in the environment. Refusing to start without persistent order storage.");
  process.exit(1);
}

let ordersCollection = null;

async function connectMongo() {
  const mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db("papernoodle");
  ordersCollection = db.collection("orders");
  console.log("✅ Connected to MongoDB");
}

async function loadOrders() {
  if (!ordersCollection) return [];
  try {
    return await ordersCollection.find({}).sort({ paidAt: -1 }).toArray();
  } catch (err) {
    console.error("[mongo] loadOrders failed:", err.message);
    return [];
  }
}

async function saveOrder(order) {
  if (!ordersCollection) throw new Error("Orders collection not ready");
  await ordersCollection.insertOne(order);
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

// No-cache for HTML/JS — must be BEFORE express.static
app.use((req, res, next) => {
  if (req.path.endsWith(".js") || req.path.endsWith(".html") || req.path === "/") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "edit.html")));

app.use((req, res, next) => {
  if (req.path === "/webhook") return next();
  express.json()(req, res, next);
});

// ─────────────────────────────────────────
//  SLOT
// ─────────────────────────────────────────
// slot.layout is the SOURCE OF TRUTH for the design — kept here in server
// memory, never round-tripped through Stripe metadata (which truncates
// anything over ~500 chars per field and silently corrupts larger designs).
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
  console.log(`[slot] reset (${reason})`);
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
//  THUMB IMAGES — serve SVG files by name
// ─────────────────────────────────────────
app.get("/thumb/:name", (req, res) => {
  const name = req.params.name;
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.setHeader("Content-Type",  "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(file);
});

// ─────────────────────────────────────────
//  ADMIN AUTH MIDDLEWARE
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────
app.get("/ping", (req, res) => res.send("ok"));

// Debug-only SMS trigger — gated behind admin auth so it can't be fired by
// anyone who happens to find the route.
app.get("/test-sms", adminAuth, async (req, res) => {
  try {
    const message = await client.messages.create({
      body: "TEST SMS",
      from: process.env.TWILIO_PHONE_NUMBER,
      to: "+16143540440"
    });

    res.json({
      ok: true,
      sid: message.sid
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/reservation-status", (req, res) => {
  const now = Date.now();

  if (slot.status === "done") {
    return res.json({ valid: true, status: "done", reservationId: slot.reservationId });
  }
  
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
  // Layout lives here, in server memory, for the lifetime of this reservation.
  // This is the ONLY place it's stored pre-payment — never in Stripe metadata.
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
  const { reservationId } = req.body;
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
          unit_amount:  50,
        },
        quantity: 1,
      }],
      // Only the reservationId goes into metadata — small, safe, well
      // under Stripe's per-field limit. The actual design (slot.layout)
      // stays in server memory and is looked up by this ID in the webhook.
      metadata:    { reservationId },
      success_url: `${CONFIG.frontendUrl}/edit.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${CONFIG.frontendUrl}/edit.html?canceled=true`,
    });

    slot.stripeSessionId = session.id;
    return res.json({ url: session.url });

  } catch (err) {
    console.error("[checkout] Stripe error:", err.message);
    slot.status = "reserved";
    return res.status(500).json({ error: err.message });
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

    // Pull the design from server memory — NOT from Stripe metadata.
    const layout = slot.layout;

    slot.status           = "production";
    slot.expiresAt        = null;
    slot.productionEndsAt = now + CONFIG.productionTTL;

    try {
      await saveOrder({
        id:            reservationId,
        stripeSession: session.id,
        amount:        session.amount_total,
        currency:      session.currency,
        customerEmail: session.customer_details?.email || null,
        customerPhone: session.customer_details?.phone || null,
        layout:        layout,
        paidAt:        new Date(now).toISOString(),
      });
    } catch (err) {
      // Order data is precious — log loudly if the DB write fails so it's
      // not a silent loss the way the old file-based storage could be.
      console.error("❌ [order] FAILED TO SAVE ORDER:", err.message, { reservationId, stripeSession: session.id });
    }

    // ─────────────────────────────────────────
    //  TWILIO SMS NOTIFICATION
    // ─────────────────────────────────────────
    const phone = session.customer_details?.phone;
    console.log("[SMS DEBUG] phone from Stripe:", phone);

    if (phone) {
      try {
        await client.messages.create({
          body: "Your cyanotype design is ready!",
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone
        });
        console.log("[SMS SENT] success");
      } catch (err) {
        console.error("[SMS FAILED]", err.message);
      }
    } else {
      console.log("[SMS SKIPPED] no phone number from Stripe");
    }
  }

  return res.json({ received: true });
});

// ─────────────────────────────────────────
//  ADMIN ROUTES
// ─────────────────────────────────────────
app.get("/admin",        (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/admin/orders", adminAuth, async (req, res) => {
  const orders = await loadOrders();
  res.json(orders);
});

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
  slot.status = "done";
  res.json({ ok: true });
  setTimeout(() => resetSlot("admin-done"), 5_000);
});

// ─────────────────────────────────────────
//  QR CODE
// ─────────────────────────────────────────
const QRCode = require("qrcode");

app.get("/qr", async (req, res) => {
  try {
    const url = `${CONFIG.frontendUrl}/edit.html`;

    const svg = await QRCode.toString(url, {
      type: "svg",
      margin: 2,
      width: 300
    });

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR Code</title>
<style>
  body {
    background: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    font-family: sans-serif;
    gap: 16px;
  }
  svg { width: 300px; height: 300px; }
  p { font-size: 13px; color: #666; margin: 0; }
</style>
</head>
<body>
  ${svg}
  <p>${url}</p>
</body>
</html>
`;

    res.send(html);

  } catch (err) {
    console.error("[QR ERROR]", err);
    res.status(500).send("QR generation failed");
  }
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
connectMongo()
  .then(() => {
    app.listen(CONFIG.port, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${CONFIG.port}`);
    });
  })
  .catch(err => {
    console.error("❌ Failed to connect to MongoDB, refusing to start:", err.message);
    process.exit(1);
  });