/**
 * Node.js Server for MQTT Data Handling & Firestore Storage
 * Uses environment variables for sensitive config
 */

require("dotenv").config(); // Load .env variables
const express = require("express");
const mqtt = require("mqtt");
const admin = require("firebase-admin");
const cors = require("cors");

// ===== CONFIG FROM ENV =====
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL;
const MQTT_TOPIC = process.env.MQTT_TOPIC;
const PORT = process.env.PORT || 5000;

// ===== FIREBASE SETUP =====
const serviceAccount = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const firestore = admin.firestore();

// ===== EXPRESS SETUP =====
const app = express();
app.use(cors());
app.use(express.json());

// ===== MEMORY STORE FOR LATEST DATA =====
let latestData = {};
let lastUpdateTime = null;

// ===== HELPER FUNCTIONS =====
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

// ===== MQTT SETUP =====
const client = mqtt.connect(MQTT_BROKER_URL);

client.on("connect", () => {
  log(`Connected to MQTT broker: ${MQTT_BROKER_URL}`);
  client.subscribe(MQTT_TOPIC, (err) => {
    if (!err) log(`Subscribed to topic: ${MQTT_TOPIC}`);
    else log(`Subscribe error: ${err}`, "ERROR");
  });
});

client.on("message", async (topic, message, packet) => {
  try {
    if (packet.retain) return;

    const data = JSON.parse(message.toString());
    if (!data.device_id) {
      log("No device_id in MQTT message, skipping...", "WARN");
      return;
    }

    const docId = getFormattedTimestamp();

    await firestore.collection(data.device_id).doc(docId).set({
      ...data,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    latestData = { ...data, timestamp: new Date().toISOString() };
    lastUpdateTime = Date.now();

    log(`Data stored: ${data.device_id}/${docId}`);
  } catch (err) {
    log(`Error processing MQTT message: ${err}`, "ERROR");
  }
});

// ===== ROUTES =====

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
    const docTime = latestDoc.timestamp.toDate();
    const diffSeconds = (Date.now() - docTime.getTime()) / 1000;

    if (diffSeconds > 60) return res.json({ status: "no_data", data: "--" });

    res.json({ status: "ok", data: latestDoc });
  } catch (err) {
    log(`Error fetching data for ${deviceId}: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

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
