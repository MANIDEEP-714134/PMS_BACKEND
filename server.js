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
const serviceAccount = require("./serviceAccountKey.json");


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

// ===== API ROUTES =====

// Store incoming data
app.post("/api/data", async (req, res) => {
  try {
    const data = req.body;

    if (!data.device_id) {
      return res.status(400).json({ status: "error", error: "device_id required" });
    }

    const docId = getFormattedTimestamp();

    await firestore.collection(data.device_id).doc(docId).set({
      ...data,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    log(`HTTP Data stored: ${data.device_id}/${docId}`);

    res.json({ status: "success", stored: data });
  } catch (err) {
    log(`Error saving HTTP data: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

// Fetch latest data for a device
app.get("/api/data/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ status: "error", error: "deviceId required" });

  try {
    const snapshot = await firestore
      .collection(deviceId)
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();

    if (snapshot.empty) return res.json({ status: "no_data", data: "--" });

    const latestDoc = snapshot.docs[0].data();
    res.json({ status: "ok", data: latestDoc });
  } catch (err) {
    log(`Error fetching data for ${deviceId}: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
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
