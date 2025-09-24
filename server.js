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
const mqtt = require("mqtt");

// ===== MQTT CONFIG =====
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://broker.emqx.io";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "PMS/data";
const mqttClient = mqtt.connect(MQTT_BROKER);

// ===== CORE PROCESSING FUNCTION =====
async function processDeviceData(data, source = "http") {
  if (!data.device_id) throw new Error("device_id required");

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

  log(`[${source.toUpperCase()}] Data stored: ${data.device_id}/${docId}`);

  // ========== NOTIFICATION CHECK (same as your existing logic) ==========
  let alertSent = false;
  let noAlertNeeded = true;
  let alertMsg = "";

  let deviceSettings = userSettingsCache[data.device_id];
  if (!deviceSettings) {
    const snapshot = await firestore
      .collection("users")
      .where("deviceId", "==", data.device_id)
      .get();

    if (!snapshot.empty) {
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

    if (ratio1 < (deviceSettings.noAeratorsLine1 || 0))
      alertMsg += `Line1 aerators running = ${ratio1}, expected ≥ ${deviceSettings.noAeratorsLine1}. `;
    if (ratio2 < (deviceSettings.noAeratorsLine2 || 0))
      alertMsg += `Line2 aerators running = ${ratio2}, expected ≥ ${deviceSettings.noAeratorsLine2}.`;

    if (alertMsg) {
      noAlertNeeded = false;
      const deviceAlertState = alertStateCache[data.device_id] || {
        active: false,
      };
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
              alertSent = true;
            } catch (err) {
              log(
                `❌ Failed to send FCM for user ${doc.id}: ${err.message}`,
                "WARN"
              );
            }
          }
        }
        alertStateCache[data.device_id] = {
          active: true,
          lastAlert: Date.now(),
        };
      }
    } else {
      const deviceAlertState = alertStateCache[data.device_id] || {
        active: false,
      };
      if (deviceAlertState.active) {
        log(`✅ Device ${data.device_id} recovered, clearing alert state`);
      }
      alertStateCache[data.device_id] = { active: false };
    }
  }

  return { formatted, alertSent, alertMsg, noAlertNeeded };
}

function publishCommand(command) {
  const topic = "PMS/cmd";
  const payload = JSON.stringify(command);

  mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
    if (err) {
      log(`❌ Failed to publish command: ${err.message}`, "ERROR");
    } else {
      log(`📢 Command published to ${topic}: ${payload}`);
    }
  });
}

app.post("/api/control-response", (req, res) => {
  const { deviceId, code } = req.body;

  if (!deviceId || !code) {
    return res.status(400).json({ status: "error", error: "deviceId and code required" });
  }

  responseControl[deviceId] = { code };

  log(`Frontend set response code for ${deviceId}: ${code}`);

  res.json({
    status: "success",
    deviceId,
    code,
  });
});


const responseControl = {}; 
// ===== HTTP ENDPOINT (reuses processDeviceData) =====
app.post("/api/data", async (req, res) => {
  try {
    const respCode = responseControl[device_id]?.code || 200;

    const { formatted, alertSent, alertMsg, noAlertNeeded } =
      await processDeviceData(req.body, "http");

    if (alertMsg) {
      res.status(respCode).json({
        status: "success",
        stored: formatted,
        alertSent,
        noAlertNeeded,
      });
    } else {
      res.status(respCode).json({
        status: "success",
        stored: formatted,
        alertSent,
        noAlertNeeded,
      });
    }
  } catch (err) {
    log(`❌ Error saving HTTP data: ${err}`, "ERROR");
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ===== MQTT HANDLER =====
// ===== MQTT CONFIG =====

// ===== MQTT DEBUG HANDLER =====
mqttClient.on("connect", () => {
  console.log("✅ Connected to MQTT broker");
  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) {
      console.error("❌ Failed to subscribe:", err);
    } else {
      console.log(`📡 Subscribed to topic: ${MQTT_TOPIC}`);
    }
  });
});

mqttClient.on("message", async (topic, message) => {
  console.log("📩 Incoming MQTT Message");
  console.log("   📌 Topic:", topic);
  console.log("   📦 Raw Payload:", message.toString());

  try {
    const parsed = JSON.parse(message.toString());
    console.log("   ✅ Parsed JSON:", parsed);

    // 🔥 Store into Firestore + cache
    const { formatted, alertSent, alertMsg, noAlertNeeded } =
      await processDeviceData(parsed, "mqtt");

    console.log("   💾 Stored to Firestore:", formatted.device_id);
    if (alertMsg) {
      console.log("   🚨 Alert Triggered:", alertMsg);
      console.log("   📲 FCM sent?", alertSent);
    } else {
      console.log("   ✅ No alert needed");
    }
  } catch (err) {
    console.error("   ❌ Failed to parse/process message:", err.message);
  }
});

mqttClient.on("error", (err) => {
  console.error("❌ MQTT Error:", err);
});

mqttClient.on("close", () => {
  console.log("⚠️ MQTT connection closed");
});

mqttClient.on("reconnect", () => {
  console.log("🔄 Reconnecting to MQTT broker...");
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

// ===== GET GUARDIAN NUMBERS BY USER ID =====
app.get("/api/guardians/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res
        .status(400)
        .json({ status: "error", error: "userId required" });
    }

    // Query Firestore for the user with this userId
    const doc = await firestore.collection("users").doc(userId).get();

    if (!doc.exists) {
      return res.status(404).json({ status: "error", error: "User not found" });
    }

    const data = doc.data();

    const guardians = {
      userName: data.name || "",
      guardianNumber1: data.guardianNumber1 || "",
      guardianNumber2: data.guardianNumber2 || "",
    };

    res.json({ status: "success", userId, guardians });
  } catch (err) {
    console.error(
      `Error fetching guardians for user ${req.params.userId}:`,
      err
    );
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => log(`Server running on port ${PORT}`));
