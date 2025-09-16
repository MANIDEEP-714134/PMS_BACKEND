/**
 * Node.js Server for Firestore Storage + In-Memory Cache (optimized)
 * Stores last 2 days in server memory, full history optionally in Firestore
 * Sends notifications to all users with the same deviceId when condition is met
 */

require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// ===== CONFIG =====
const PORT = 8080;
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000; // 2 days in ms

// ===== FIREBASE SETUP =====
if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_BASE64 in .env");
  process.exit(1);
}
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString(
    "utf8"
  )
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

const formatData = (device_id, payload, firestoreTimestamp) => ({
  device_id,
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
});

// ===== IN-MEMORY CACHES =====
const liveDataCache = {}; // { deviceId: { data, lastUpdated } }
const historyCache = {}; // { deviceId: [last 2 days data] }
const userSettingsCache = {}; // { deviceId: { noAeratorsLine1, noAeratorsLine2, perAerator_currentLine1, perAerator_currentLine2 } }
const alertStateCache = {}; // { deviceId: { active: true/false, lastAlert: timestamp } }

// ===== API ROUTES =====

// Store incoming data
app.post("/api/data", async (req, res) => {
  try {
    const data = req.body;
    if (!data.device_id)
      return res
        .status(400)
        .json({ status: "error", error: "device_id required" });

    const docId = getFormattedTimestamp();
    const formatted = formatData(data.device_id, data);

    // Save in Firestore
    await firestore.collection(data.device_id).doc(docId).set(formatted);

    // Save in live cache
    liveDataCache[data.device_id] = {
      data: formatted,
      lastUpdated: Date.now(),
    };

    // Save in history cache (2-day rolling window)
    if (!historyCache[data.device_id]) historyCache[data.device_id] = [];
    historyCache[data.device_id].push(formatted);
    const cutoff = Date.now() - TWO_DAYS;
    historyCache[data.device_id] = historyCache[data.device_id].filter(
      (item) => item.timestamp.toMillis() >= cutoff
    );

    log(`HTTP Data stored: ${data.device_id}/${docId}`);

    // ===== NOTIFICATION CHECK =====
    let alertSent = false;
    let noAlertNeeded = true;

    // Load cached calculation values if available
    let deviceSettings = userSettingsCache[data.device_id];
    if (!deviceSettings) {
      // Load from Firestore once and cache
      const snapshot = await firestore
        .collection("users")
        .where("deviceId", "==", data.device_id)
        .get();

      if (!snapshot.empty) {
        // Use first user as reference for calculation values
        const firstUser = snapshot.docs[0].data();
        deviceSettings = {
          noAeratorsLine1: firstUser.noAeratorsLine1 || 0,
          noAeratorsLine2: firstUser.noAeratorsLine2 || 0,
          perAerator_currentLine1: firstUser.perAerator_currentLine1 || 1,
          perAerator_currentLine2: firstUser.perAerator_currentLine2 || 1,
        };
        userSettingsCache[data.device_id] = deviceSettings;
        log(`Cached calculation values for deviceId=${data.device_id}`);
      }
    }

    if (deviceSettings) {
      const snapshot = await firestore
        .collection("users")
        .where("deviceId", "==", data.device_id)
        .get();

      const ratio1 = Math.round(
        formatted.line1 / (deviceSettings.perAerator_currentLine1 || 1)
      );
      const ratio2 = Math.round(
        formatted.line2 / (deviceSettings.perAerator_currentLine2 || 1)
      );

      let alertMsg = "";
      if (ratio1 < (deviceSettings.noAeratorsLine1 || 0))
        alertMsg += `Line1 aerators running = ${ratio1}, expected ≥ ${deviceSettings.noAeratorsLine1}. `;
      if (ratio2 < (deviceSettings.noAeratorsLine2-1 || 0))
        alertMsg += `Line2 aerators running = ${ratio2}, expected ≥ ${deviceSettings.noAeratorsLine2}.`;

      const deviceAlertState = alertStateCache[data.device_id] || {
        active: false,
      };

      if (alertMsg) {
        noAlertNeeded = false;

        if (!deviceAlertState.active) {
          for (const doc of snapshot.docs) {
            const userData = doc.data();
            if (userData.fcmToken) {
              const message = {
                token: userData.fcmToken,
                notification: {
                  title: "⚠️ Aerator Alert!",
                  body: `Device ${data.device_id}: ${alertMsg}`,
                },
                
                android: {
                  priority: "HIGH",
                  notification: {
                    channel_id: "alarm_channel",
                    sound: "alarm",
                  },
                },
              };
              try {
                await admin.messaging().send(message);
                log(
                  `✅ Alert sent to user ${doc.id} for device ${data.device_id}`
                );
                alertSent = true;
              } catch (err) {
                if (
                  err.code === "messaging/registration-token-not-registered"
                ) {
                  log(`❌ Invalid FCM token for user ${doc.id}`, "WARN");
                } else {
                  log(
                    `❌ Failed to send notification to user ${doc.id}: ${err.message}`,
                    "ERROR"
                  );
                }
              }
            } else {
              log(`⚠️ No FCM token for user ${doc.id}`, "WARN");
            }
          }
          alertStateCache[data.device_id] = {
            active: true,
            lastAlert: Date.now(),
          };
        } else {
          log(
            `ℹ️ Alert already active for ${data.device_id}, skipping re-send`
          );
        }
      } else {
        if (deviceAlertState.active) {
          log(`✅ Device ${data.device_id} recovered, clearing alert state`);
        }
        alertStateCache[data.device_id] = { active: false };
      }
    }

    res.json({
      status: "success",
      stored: formatted,
      alertSent,
      noAlertNeeded,
    });
  } catch (err) {
    log(`❌ Error saving HTTP data: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ===== PATCH USERS BY deviceId (update calculation values) =====
app.patch("/api/users/update", async (req, res) => {
  try {
    const {
      deviceId,
      noAeratorsLine1,
      noAeratorsLine2,
      perAerator_currentLine1,
      perAerator_currentLine2,
    } = req.body;
    if (!deviceId)
      return res
        .status(400)
        .json({ status: "error", error: "deviceId required" });

    const updates = {};
    if (noAeratorsLine1 !== undefined)
      updates.noAeratorsLine1 = noAeratorsLine1;
    if (noAeratorsLine2 !== undefined)
      updates.noAeratorsLine2 = noAeratorsLine2;
    if (perAerator_currentLine1 !== undefined)
      updates.perAerator_currentLine1 = perAerator_currentLine1;
    if (perAerator_currentLine2 !== undefined)
      updates.perAerator_currentLine2 = perAerator_currentLine2;

    if (!Object.keys(updates).length)
      return res
        .status(400)
        .json({ status: "error", error: "Provide at least one field" });

    updates.updatedAt = new Date().toISOString();

    const snapshot = await firestore
      .collection("users")
      .where("deviceId", "==", deviceId)
      .get();
    if (snapshot.empty)
      return res
        .status(404)
        .json({ status: "error", error: "No users found with this deviceId" });

    const batch = firestore.batch();
    snapshot.forEach((doc) => batch.update(doc.ref, updates));
    await batch.commit();

    // Update cache for calculation
    if (!userSettingsCache[deviceId]) userSettingsCache[deviceId] = {};
    Object.assign(userSettingsCache[deviceId], updates);

    res.json({
      status: "success",
      message: `Updated ${snapshot.size} user(s)`,
      cache: userSettingsCache[deviceId],
    });
    log(`Updated ${snapshot.size} user(s) for deviceId=${deviceId}`);
  } catch (err) {
    log(`Error patching users: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ===== FETCH HISTORY =====
app.get("/api/history/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId)
    return res
      .status(400)
      .json({ status: "error", error: "deviceId required" });

  const history = historyCache[deviceId] || [];
  res.json({ status: history.length ? "ok" : "no_data", data: history });
});

// ===== FETCH LIVE DATA =====
app.get("/api/data/:deviceId", (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId)
    return res
      .status(400)
      .json({ status: "error", error: "deviceId required" });

  const cacheEntry = liveDataCache[deviceId];
  if (!cacheEntry || Date.now() - cacheEntry.lastUpdated > 30000) {
    return res.json({ status: "no_data", data: "--" });
  }

  res.json({ status: "ok", data: cacheEntry.data });
});

// ===== RELAY CONTROL =====
app.post("/api/relays", async (req, res) => {
  try {
    const { device_id, ...relays } = req.body;
    if (!device_id)
      return res
        .status(400)
        .json({ status: "error", error: "device_id required" });

    const docId = getFormattedTimestamp();
    await firestore
      .collection(`${device_id}_control`)
      .doc(docId)
      .set({
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

// ===== TEST NOTIFICATION API (matches /api/data payload) =====
app.post("/api/test-notification", async (req, res) => {
  try {
    const { fcmToken, title, body } = req.body;

    if (!fcmToken || !title || !body) {
      return res.status(400).json({
        status: "error",
        error: "fcmToken, title, and body are required",
      });
    }

    // Same payload as in /api/data alerts
    const message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      android: {
        priority: "HIGH",
        notification: {
          channel_id: "alarm_channel",
          sound: "alarm",
        },
      },
    };

    const response = await admin.messaging().send(message);

    log(`✅ Test notification sent to token: ${fcmToken}`);
    res.json({
      status: "success",
      validity: "valid",
      messageId: response,
      payload: message,
    });
  } catch (err) {
    if (
      err.code === "messaging/invalid-argument" ||
      err.code === "messaging/registration-token-not-registered"
    ) {
      log(`❌ Invalid or expired FCM token: ${req.body.fcmToken}`, "ERROR");
      return res.status(400).json({
        status: "error",
        validity: "invalid",
        error: "Invalid or expired FCM token",
      });
    }

    log(`❌ Failed to send test notification: ${err.message}`, "ERROR");
    res.status(500).json({
      status: "error",
      validity: "unknown",
      error: err.message,
    });
  }
});


// ===== START SERVER =====
app.listen(PORT, () => log(`Server running on port ${PORT}`));
