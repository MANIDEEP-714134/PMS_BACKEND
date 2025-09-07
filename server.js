/**
 * Node.js Server for Firestore Storage + In-Memory Cache (no MQTT)
 * Stores last 2 days in server memory, full history optionally in Firestore
 */

require("dotenv").config(); // Load .env variables
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// ===== CONFIG =====
const PORT = 8080;
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000; // 2 days in ms

// ===== FIREBASE SETUP (using Base64 from .env) =====
if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_BASE64 in .env");
  process.exit(1);
}
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);

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

// ===== IN-MEMORY CACHES =====
const liveDataCache = {}; // latest data only { deviceId: { data, lastUpdated } }
const historyCache = {}; // per device: array of last 2 days
const userSettingsCache = {}; // { deviceId: { noAeratorsLine1, noAeratorsLine2, perAerator_currentLine1, perAerator_currentLine2, updatedAt } }

// ===== API ROUTES =====

// Store incoming data
app.post("/api/data", async (req, res) => {
  try {
    const data = req.body;
    if (!data.device_id) {
      return res.status(400).json({ status: "error", error: "device_id required" });
    }

    const docId = getFormattedTimestamp();
    const formatted = formatData(data.device_id, data);

    // === Save in Firestore for long-term history ===
    await firestore.collection(data.device_id).doc(docId).set(formatted);

    // === Save in live data cache ===
    liveDataCache[data.device_id] = {
      data: formatted,
      lastUpdated: Date.now(),
    };

    // === Save in history cache (2-day rolling window) ===
    if (!historyCache[data.device_id]) {
      historyCache[data.device_id] = [];
    }
    historyCache[data.device_id].push(formatted);

    const cutoff = Date.now() - TWO_DAYS;
    historyCache[data.device_id] = historyCache[data.device_id].filter(
      (item) => item.timestamp.toMillis() >= cutoff
    );

    log(`HTTP Data stored: ${data.device_id}/${docId}`);

    // === 🚨 AUTO NOTIFICATION CHECK ===
    try {
      let settings = userSettingsCache[data.device_id];

      // Cold start → load from Firestore once
      if (!settings) {
        const snapshot = await firestore
          .collection("users")
          .where("deviceId", "==", data.device_id)
          .get();
        if (!snapshot.empty) {
          settings = snapshot.docs[0].data();
          userSettingsCache[data.device_id] = settings;
          log(`Cached user settings for deviceId=${data.device_id}`);
        }
      }

      if (settings) {
        const perAerator1 = settings.perAerator_currentLine1 || 1;
        const noAerators1 = settings.noAeratorsLine1 || 0;
        const ratio1 = Math.round(formatted.line1 / perAerator1);

        const perAerator2 = settings.perAerator_currentLine2 || 1;
        const noAerators2 = settings.noAeratorsLine2 || 0;
        const ratio2 = Math.round(formatted.line2 / perAerator2);

        let alertMsg = "";
        if (ratio1 < noAerators1) {
          alertMsg += `Line1 aerators running = ${ratio1}, expected ≥ ${noAerators1}. `;
        }
        if (ratio2 < noAerators2) {
          alertMsg += `Line2 aerators running = ${ratio2}, expected ≥ ${noAerators2}.`;
        }

        if (alertMsg) {
          const snapshot = await firestore
            .collection("users")
            .where("deviceId", "==", data.device_id)
            .get();

          snapshot.forEach(async (doc) => {
            const userData = doc.data();
            if (userData.fcmToken) {
              const message = {
                notification: {
                  title: "⚠️ Aerator Alert!",
                  body: `Device ${data.device_id}: ${alertMsg}`,
                },
                token: userData.fcmToken,
              };

              try {
                await admin.messaging().send(message);
                log(`Notification sent to ${userData.name || "Unknown"} (${doc.id})`);
              } catch (err) {
                if (err.code === "messaging/registration-token-not-registered") {
                  log(`Invalid/expired fcmToken for user ${doc.id}`, "WARN");
                } else {
                  log(`Failed to send notification to ${doc.id}: ${err.message}`, "ERROR");
                }
              }
            } else {
              log(`No fcmToken for user ${doc.id}`, "WARN");
            }
          });
        } else {
          log(`No alert needed for device ${data.device_id}`);
        }
      } else {
        log(`No settings found in cache/Firestore for deviceId=${data.device_id}`, "WARN");
      }
    } catch (err) {
      log(`Notification error: ${err}`, "ERROR");
    }

    res.json({ status: "success", stored: formatted });
  } catch (err) {
    log(`Error saving HTTP data: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ===== PATCH USERS BY deviceId (from body) =====
app.patch("/api/users/update", async (req, res) => {
  try {
    const { deviceId, noAeratorsLine1, noAeratorsLine2, perAerator_currentLine1, perAerator_currentLine2 } = req.body;

    if (!deviceId) {
      return res.status(400).json({ status: "error", error: "deviceId is required in body" });
    }

    // Collect only provided fields
    const updates = {};
    if (noAeratorsLine1 !== undefined) updates.noAeratorsLine1 = noAeratorsLine1;
    if (noAeratorsLine2 !== undefined) updates.noAeratorsLine2 = noAeratorsLine2;
    if (perAerator_currentLine1 !== undefined) updates.perAerator_currentLine1 = perAerator_currentLine1;
    if (perAerator_currentLine2 !== undefined) updates.perAerator_currentLine2 = perAerator_currentLine2;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ status: "error", error: "At least one of the 4 fields must be provided" });
    }

    updates.updatedAt = new Date().toISOString();

    // Query all users with given deviceId
    const snapshot = await firestore.collection("users").where("deviceId", "==", deviceId).get();

    if (snapshot.empty) {
      return res.status(404).json({ status: "error", error: `No users found with deviceId=${deviceId}` });
    }

    // Batch update all matching docs
    const batch = firestore.batch();
    snapshot.forEach((doc) => {
      batch.update(doc.ref, updates);
    });
    await batch.commit();

    // Update cache
    userSettingsCache[deviceId] = {
      ...(userSettingsCache[deviceId] || {}),
      ...updates,
    };

    res.json({ status: "success", message: `Updated ${snapshot.size} user(s) with deviceId ${deviceId}`, cache: userSettingsCache[deviceId] });
    log(`Updated ${snapshot.size} user(s) with deviceId ${deviceId} (cache updated)`);
  } catch (error) {
    log(`Error patching users: ${error}`, "ERROR");
    res.status(500).json({ status: "error", error: error.message });
  }
});

// Fetch history data (last 2 days from cache only)
app.get("/api/history/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) {
    return res.status(400).json({ status: "error", error: "deviceId required" });
  }

  const history = historyCache[deviceId] || [];
  if (!history.length) {
    return res.json({ status: "no_data", data: [] });
  }

  res.json({ status: "ok", data: history });
});

// Fetch latest live data for a device
app.get("/api/data/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) {
    return res.status(400).json({ status: "error", error: "deviceId required" });
  }

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
    if (!device_id) {
      return res.status(400).json({ status: "error", error: "device_id required" });
    }

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
