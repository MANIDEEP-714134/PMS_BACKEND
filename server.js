/**
 * Node.js Server for Firestore Storage (no MQTT)
 * Uses Base64 encoded service account JSON from environment variable
 */

require("dotenv").config(); // Load .env variables
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// ===== CONFIG =====
const PORT = 8080;

// ===== FIREBASE SETUP (using Base64 from .env) =====
if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_BASE64 in .env");
  process.exit(1);
}
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const firestore = admin.firestore();

// ===== EXPRESS SETUP =====
const app = express();
app.use(cors());
app.use(express.json());

// ===== HELPERS =====
const getFormattedTimestamp = () => {
  const now = new Date();
  const pad = (n) => (n < 10 ? "0" + n : n);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

const log = (msg, type = "INFO") => {
  console.log(`[${new Date().toISOString()}] [${type}] ${msg}`);
};

const liveDataCache = {};

const formatData = (device_id, payload, firestoreTimestamp) => {
  return {
    device_id: device_id,
    line1: payload.line1 ?? 0,
    line2: payload.line2 ?? 0,
    temperature: payload.temperature ?? 0,
    turbidity: payload.turbidity ?? 0,
    ph: payload.ph ?? 0,
    do: payload.do ?? 0,
    tds: payload.tds ?? 0,
    relay1_status: payload.relay1_status ?? 0,
    relay2_status: payload.relay2_status ?? 0,
    timestamp: firestoreTimestamp || admin.firestore.Timestamp.now(),
  };
};

// ===== API ROUTES =====

// Store incoming data
// Fetch history data for the last 2 days
app.get("/api/history/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId)
    return res.status(400).json({ status: "error", error: "deviceId required" });

  try {
    // Calculate 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    // Query Firestore
    const snapshot = await firestore
      .collection(deviceId)
      .where("timestamp", ">=", twoDaysAgo)
      .orderBy("timestamp", "desc")
      .get();

    if (snapshot.empty) {
      return res.json({ status: "no_data", data: [] });
    }

    const history = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ status: "ok", data: history });
  } catch (err) {
    log(`Error fetching history for ${deviceId}: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});


app.post("/api/data", async (req, res) => {
  try {
    const data = req.body;

    if (!data.device_id) {
      return res.status(400).json({ status: "error", error: "device_id required" });
    }

    const docId = getFormattedTimestamp();

    // Create formatted structure
    const formatted = formatData(data.device_id, data);

    // Save in Firestore (for history)
    await firestore.collection(data.device_id).doc(docId).set(formatted);

    // Save in memory cache
    liveDataCache[data.device_id] = {
      data: formatted,
      lastUpdated: Date.now(),
    };

    log(`HTTP Data stored: ${data.device_id}/${docId}`);

    res.json({ status: "success", stored: formatted });
  } catch (err) {
    log(`Error saving HTTP data: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

// Fetch latest data for a device
app.get("/api/data/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId)
    return res.status(400).json({ status: "error", error: "deviceId required" });

  const cacheEntry = liveDataCache[deviceId];

  // If no data or older than 30s → return no_data
  if (!cacheEntry || Date.now() - cacheEntry.lastUpdated > 30000) {
    return res.json({ status: "no_data", data: "--" });
  }

  res.json({ status: "ok", data: cacheEntry.data });
});

// Save relay control data
app.post("/api/relays", async (req, res) => {
  try {
    const { device_id, ...relays } = req.body;
    if (!device_id)
      return res.status(400).json({ status: "error", error: "device_id required" });

    const docId = getFormattedTimestamp();

    await firestore.collection(`${device_id}_control`).doc(docId).set({
      device_id,
      ...relays,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ status: "success", device_id, updated: relays });
    log(`Relay data saved for ${device_id}`);
  } catch (err) {
    log(`Error saving relay data: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => log(`Server running on port ${PORT}`));
