import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import mqtt from 'mqtt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const STORE_PATH = path.join(__dirname, 'motion-store.json');

// ==================== HiveMQ Config จากโค้ด ESP32 ====================
const MQTT_BROKER_HOST = 'purplequeen-abb61cf6.a03.euc1.aws.hivemq.cloud';
const MQTT_BROKER_PORT = 8883;
const MQTT_BROKER_URL = `mqtts://${MQTT_BROKER_HOST}:${MQTT_BROKER_PORT}`;
const MQTT_USER = 'Sittihpon';
const MQTT_PASS = '111222333';

const TOPIC_PASS_COUNT = 'sensor/pass_count';
const TOPIC_DISTANCE = 'sensor/distance';

export interface MotionEvent {
  id: string;
  countIndex: number;
  timestamp: string;
  deviceId: string;
  locationName: string;
  source: 'esp32-wifi' | 'manual-test';
  distance?: number;
}

export interface MotionState {
  deviceId: string;
  locationName: string;
  armedMode: boolean;
  motionActive: boolean;
  totalCount: number;
  currentDistance: number | null;
  thresholdCm: number;
  lastDetectedAt: string | null;
  ledAlarmEnabled: boolean;
  alertThresholdCount: number;
  mqttConnected: boolean;
  mqttBroker: string;
  lastMqttMsgAt: string | null;
  events: MotionEvent[];
}

function loadState(): MotionState {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.totalCount === 'number' && Array.isArray(parsed.events)) {
        return {
          deviceId: parsed.deviceId || 'ESP32-Ultrasonic-01',
          locationName: parsed.locationName || 'จุดตรวจนับคนเดินผ่าน (HC-SR04)',
          armedMode: parsed.armedMode !== undefined ? parsed.armedMode : true,
          motionActive: false,
          totalCount: parsed.totalCount || 0,
          currentDistance: typeof parsed.currentDistance === 'number' ? parsed.currentDistance : null,
          thresholdCm: parsed.thresholdCm || 50.0,
          lastDetectedAt: parsed.lastDetectedAt || null,
          ledAlarmEnabled: parsed.ledAlarmEnabled !== undefined ? parsed.ledAlarmEnabled : true,
          alertThresholdCount: parsed.alertThresholdCount || 20,
          mqttConnected: false,
          mqttBroker: MQTT_BROKER_HOST,
          lastMqttMsgAt: parsed.lastMqttMsgAt || null,
          events: parsed.events.map((e: Partial<MotionEvent>, i: number) => ({
            id: e.id || `evt-${i}`,
            countIndex: e.countIndex || (parsed.events.length - i),
            timestamp: e.timestamp || new Date().toISOString(),
            deviceId: e.deviceId || 'ESP32-Ultrasonic-01',
            locationName: e.locationName || 'จุดตรวจนับคนเดินผ่าน (HC-SR04)',
            source: e.source === 'manual-test' ? 'manual-test' : 'esp32-wifi',
            distance: typeof e.distance === 'number' ? e.distance : undefined,
          })),
        };
      }
    }
  } catch {
    // Fallback to clean state
  }

  // ล้างค่าตัวอย่างทั้งหมด เริ่มต้นด้วยค่าจริงที่พร้อมรับจากบอร์ด ESP32
  return {
    deviceId: 'ESP32-Ultrasonic-01',
    locationName: 'จุดตรวจนับคนเดินผ่าน (HC-SR04)',
    armedMode: true,
    motionActive: false,
    totalCount: 0,
    currentDistance: null,
    thresholdCm: 50.0,
    lastDetectedAt: null,
    ledAlarmEnabled: true,
    alertThresholdCount: 20,
    mqttConnected: false,
    mqttBroker: MQTT_BROKER_HOST,
    lastMqttMsgAt: null,
    events: [],
  };
}

const state: MotionState = loadState();
let clearMotionTimer: NodeJS.Timeout | null = null;

function saveState() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Ignore fs errors
  }
}

const sseClients = new Set<Response>();

function broadcastState() {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ฟังก์ชันบันทึกการตรวจจับและส่งต่อให้หน้าเว็บ
function handlePassDetection(count: number, distance?: number) {
  if (clearMotionTimer) {
    clearTimeout(clearMotionTimer);
    clearMotionTimer = null;
  }

  const nowIso = new Date().toISOString();
  state.motionActive = true;
  state.totalCount = count;
  state.lastDetectedAt = nowIso;
  state.lastMqttMsgAt = nowIso;
  if (distance !== undefined) {
    state.currentDistance = distance;
  }

  const newEvent: MotionEvent = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    countIndex: count,
    timestamp: nowIso,
    deviceId: state.deviceId,
    locationName: state.locationName,
    source: 'esp32-wifi',
    distance: distance !== undefined ? distance : (state.currentDistance ?? undefined),
  };

  state.events.unshift(newEvent);
  if (state.events.length > 200) {
    state.events = state.events.slice(0, 200);
  }

  // เคลียร์สถานะ active หลังจาก 3.5 วินาที
  clearMotionTimer = setTimeout(() => {
    state.motionActive = false;
    saveState();
    broadcastState();
  }, 3500);

  saveState();
  broadcastState();
}

// ฟังก์ชันอัปเดตระยะทางจากเซนเซอร์ HC-SR04
function handleDistanceUpdate(distance: number) {
  state.currentDistance = distance;
  state.lastMqttMsgAt = new Date().toISOString();

  // หากอยู่ในเกณฑ์ตรวจจับ THRESHOLD_CM
  if (distance > 2.0 && distance < state.thresholdCm) {
    state.motionActive = true;
  }

  saveState();
  broadcastState();
}

// ==================== เชื่อมต่อ HiveMQ Cloud MQTT Broker ====================
console.log(`[MQTT] กำลังเชื่อมต่อไปยัง HiveMQ Cloud: ${MQTT_BROKER_HOST}:${MQTT_BROKER_PORT}...`);

const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USER,
  password: MQTT_PASS,
  rejectUnauthorized: false,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
  clientId: `StudioServer-${Math.random().toString(16).slice(2, 8)}`,
});

mqttClient.on('connect', () => {
  console.log('[MQTT] เชื่อมต่อ HiveMQ Cloud สำเร็จ!');
  state.mqttConnected = true;
  state.mqttBroker = MQTT_BROKER_HOST;
  broadcastState();

  // Subscribe topics ที่ ESP32 ส่งมา
  mqttClient.subscribe([TOPIC_PASS_COUNT, TOPIC_DISTANCE, 'sensor/#'], (err) => {
    if (err) {
      console.error('[MQTT] เกิดข้อผิดพลาดในการ Subscribe:', err);
    } else {
      console.log(`[MQTT] Subscribed เรียบร้อย: ${TOPIC_PASS_COUNT}, ${TOPIC_DISTANCE}`);
    }
  });
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] กำลังพยายามเชื่อมต่อ HiveMQ ใหม่...');
  state.mqttConnected = false;
  broadcastState();
});

mqttClient.on('close', () => {
  state.mqttConnected = false;
  broadcastState();
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] เกิดข้อผิดพลาด:', err.message);
  state.mqttConnected = false;
  broadcastState();
});

mqttClient.on('message', (topic, payload) => {
  const messageStr = payload.toString().trim();
  console.log(`[MQTT ข้อความเข้า] ${topic} -> ${messageStr}`);

  if (topic === TOPIC_PASS_COUNT) {
    const val = parseInt(messageStr, 10);
    if (!isNaN(val)) {
      handlePassDetection(val);
    }
  } else if (topic === TOPIC_DISTANCE) {
    const dist = parseFloat(messageStr);
    if (!isNaN(dist)) {
      handleDistanceUpdate(dist);
    }
  }
});

async function startServer() {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/api/state', (_req: Request, res: Response) => {
    res.json(state);
  });

  app.get('/api/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  const handlePostMotion = (req: Request, res: Response) => {
    const body = req.body || {};
    const motionVal =
      body.motion !== undefined
        ? Boolean(Number(body.motion) || body.motion === true || body.motion === 'HIGH')
        : true;

    if (motionVal) {
      const nextCount = (typeof body.count === 'number' && body.count > 0)
        ? body.count
        : state.totalCount + 1;
      handlePassDetection(nextCount, typeof body.distance === 'number' ? body.distance : undefined);
    }

    res.json({
      ok: true,
      motionActive: state.motionActive,
      totalCount: state.totalCount,
      currentDistance: state.currentDistance,
      ledAlarm: state.ledAlarmEnabled ? 1 : 0,
      armedMode: state.armedMode ? 1 : 0,
    });
  };

  app.post('/api/motion', handlePostMotion);
  app.post('/api/telemetry', handlePostMotion);

  app.get('/api/motion/trigger', (req: Request, res: Response) => {
    const q = req.query;
    const countVal = q.count ? parseInt(String(q.count), 10) : state.totalCount + 1;
    const distVal = q.distance ? parseFloat(String(q.distance)) : undefined;

    handlePassDetection(countVal, distVal);

    res.json({
      ok: true,
      motionActive: state.motionActive,
      totalCount: state.totalCount,
      currentDistance: state.currentDistance,
    });
  });

  app.post('/api/config', (req: Request, res: Response) => {
    const {
      ledAlarmEnabled,
      deviceId,
      locationName,
      armedMode,
      alertThresholdCount,
      thresholdCm,
    } = req.body || {};
    if (typeof ledAlarmEnabled === 'boolean') {
      state.ledAlarmEnabled = ledAlarmEnabled;
    }
    if (typeof armedMode === 'boolean') {
      state.armedMode = armedMode;
    }
    if (typeof deviceId === 'string' && deviceId.trim()) {
      state.deviceId = deviceId.trim();
    }
    if (typeof locationName === 'string' && locationName.trim()) {
      state.locationName = locationName.trim();
    }
    if (typeof alertThresholdCount === 'number' && alertThresholdCount > 0) {
      state.alertThresholdCount = alertThresholdCount;
    }
    if (typeof thresholdCm === 'number' && thresholdCm > 0) {
      state.thresholdCm = thresholdCm;
    }
    saveState();
    broadcastState();
    res.json({ ok: true, state });
  });

  // ล้างค่านับและประวัติทั้งหมดให้เป็น 0
  app.post('/api/reset', (_req: Request, res: Response) => {
    if (clearMotionTimer) {
      clearTimeout(clearMotionTimer);
      clearMotionTimer = null;
    }
    state.motionActive = false;
    state.totalCount = 0;
    state.currentDistance = null;
    state.lastDetectedAt = null;
    state.events = [];
    saveState();
    broadcastState();
    res.json({ ok: true, state });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 ESP32 Telemetry Dashboard รันสำเร็จที่:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`📡 HiveMQ Cloud Broker: ${MQTT_BROKER_HOST}:${MQTT_BROKER_PORT}`);
    console.log(`======================================================\n`);
  });
}

startServer();
