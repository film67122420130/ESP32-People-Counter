import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  ShieldCheck,
  ShieldOff,
  UserCheck,
  Bell,
  BellOff,
  Volume2,
  Vibrate,
  RotateCcw,
  Download,
  Smartphone,
  Clock,
  Settings,
  Activity,
  Check,
  Trash2,
  MapPin,
  Wifi,
  Radio,
  Ruler,
  Cpu,
  Waves,
} from 'lucide-react';
import { usePWAInstall, useOnlineStatus } from './hooks/usePWAInstall';

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

type MobileTab = 'monitor' | 'history' | 'settings';
type SoundTone = 'chime' | 'beep' | 'siren';

export default function App() {
  const [activeTab, setActiveTab] = useState<MobileTab>('monitor');
  const [state, setState] = useState<MotionState>({
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
    mqttBroker: 'purplequeen-abb61cf6.a03.euc1.aws.hivemq.cloud',
    lastMqttMsgAt: null,
    events: [],
  });

  // Mobile phone local alert preferences
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [soundTone, setSoundTone] = useState<SoundTone>('chime');
  const [vibrateEnabled, setVibrateEnabled] = useState<boolean>(true);
  const [pushNotifyEnabled, setPushNotifyEnabled] = useState<boolean>(false);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'esp32-wifi'>('all');

  // Settings form state
  const [locationInput, setLocationInput] = useState<string>('จุดตรวจนับคนเดินผ่าน (HC-SR04)');
  const [thresholdInput, setThresholdInput] = useState<number>(20);
  const [distanceThresholdInput, setDistanceThresholdInput] = useState<number>(50.0);
  const [savedToast, setSavedToast] = useState<boolean>(false);
  const [showIOSModal, setShowIOSModal] = useState<boolean>(false);

  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const isOnline = useOnlineStatus();
  const prevCountRef = useRef<number | null>(null);

  // Synthesize mobile alert tones via Web Audio API
  const playMobileSound = (tone: SoundTone = soundTone) => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();

      if (tone === 'chime') {
        const now = ctx.currentTime;
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(659.25, now);
        osc1.frequency.setValueAtTime(523.25, now + 0.18);
        gain1.gain.setValueAtTime(0.2, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.55);
      } else if (tone === 'siren') {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(740, now);
        osc.frequency.linearRampToValueAtTime(1180, now + 0.2);
        osc.frequency.linearRampToValueAtTime(740, now + 0.4);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.45);
      } else {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch {
      // Ignore if audio not yet unlocked
    }
  };

  const triggerPhoneFeedback = (nextState: MotionState) => {
    if (!nextState.armedMode) return;

    if (soundEnabled) {
      playMobileSound(soundTone);
    }

    if (vibrateEnabled && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate([200, 100, 200]);
      } catch {
        // Ignore on unsupported devices
      }
    }

    if (
      pushNotifyEnabled &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      try {
        new Notification(`ตรวจพบคนเดินผ่าน! (${nextState.locationName})`, {
          body: `ครั้งที่ #${nextState.totalCount} เวลา ${new Date().toLocaleTimeString('th-TH', { hour12: false })}${nextState.currentDistance ? ` (ระยะ ${nextState.currentDistance.toFixed(1)} cm)` : ''}`,
          icon: '/pwa-192x192.png',
        });
      } catch {
        // Ignore notification error
      }
    }
  };

  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then((data: MotionState) => {
        setState(data);
        setLocationInput(data.locationName || 'จุดตรวจนับคนเดินผ่าน (HC-SR04)');
        setThresholdInput(data.alertThresholdCount || 20);
        setDistanceThresholdInput(data.thresholdCm || 50.0);
        prevCountRef.current = data.totalCount;
      })
      .catch(() => {});

    const es = new EventSource('/api/stream');
    es.addEventListener('state', (evt) => {
      try {
        const nextState: MotionState = JSON.parse(evt.data);
        if (
          prevCountRef.current !== null &&
          nextState.totalCount > prevCountRef.current
        ) {
          triggerPhoneFeedback(nextState);
        }
        prevCountRef.current = nextState.totalCount;
        setState(nextState);
      } catch {
        // Ignore malformed event
      }
    });

    return () => {
      es.close();
    };
  }, [soundEnabled, soundTone, vibrateEnabled, pushNotifyEnabled]);

  const handleResetCounter = async () => {
    await fetch('/api/reset', { method: 'POST' });
  };

  const handleUpdateServerConfig = async (patch: Partial<MotionState>) => {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  };

  const handleSaveSettingsForm = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleUpdateServerConfig({
      locationName: locationInput,
      alertThresholdCount: thresholdInput,
      thresholdCm: distanceThresholdInput,
    });
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2000);
  };

  const handleEnablePushNotification = async () => {
    if (typeof Notification === 'undefined') {
      setPushNotifyEnabled(false);
      return;
    }
    if (pushNotifyEnabled) {
      setPushNotifyEnabled(false);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setPushNotifyEnabled(true);
    }
  };


  const filteredEvents = useMemo(() => {
    if (historyFilter === 'all') return state.events;
    return state.events.filter((e) => e.source === 'esp32-wifi');
  }, [state.events, historyFilter]);

  const handleExportCsv = () => {
    const header = 'ครั้งที่,วันและเวลา,จุดติดตั้ง,บอร์ด,ระยะทางที่ตรวจพบ (cm),แหล่งที่มา\n';
    const rows = filteredEvents
      .map(
        (e) =>
          `${e.countIndex},${new Date(e.timestamp).toLocaleString('th-TH')},${e.locationName},${e.deviceId},${e.distance !== undefined ? e.distance.toFixed(1) : '-'},${e.source}`
      )
      .join('\n');
    const blob = new Blob(['\uFEFF' + header + rows], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pass_count_log_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const progressRatio = Math.min(
    1,
    state.totalCount / Math.max(1, state.alertThresholdCount)
  );

  const isObjectInRange =
    state.currentDistance !== null &&
    state.currentDistance > 2.0 &&
    state.currentDistance < state.thresholdCm;

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col pb-20 md:pb-8 font-sans selection:bg-cyan-500 selection:text-slate-950">
      {/* Offline Indicator Banner */}
      {!isOnline && (
        <div className="bg-amber-500 text-slate-950 px-4 py-1.5 text-xs font-semibold text-center tracking-wide">
          โหมดออฟไลน์ — แสดงข้อมูลล่าสุดที่บันทึกไว้ในเครื่อง
        </div>
      )}

      {/* Top Bar Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 sm:px-6 h-16 bg-[#0B0E17]/95 backdrop-blur-md border-b border-slate-800 shadow-lg">
        {/* Brand with Status Badge */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-600 to-teal-400 p-[1px] flex items-center justify-center">
            <div className="w-full h-full bg-[#0B0E17] rounded-[11px] flex items-center justify-center">
              <Waves className="w-5 h-5 text-cyan-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base sm:text-lg font-bold tracking-tight text-slate-100 font-display whitespace-nowrap">
                ESP32 Telemetry
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-800">
                HC-SR04
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
              <span
                className={`w-2 h-2 rounded-full ${
                  state.mqttConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                }`}
              />
              <span>
                {state.mqttConnected ? 'HiveMQ Online' : 'Connecting HiveMQ...'}
              </span>
            </div>
          </div>
        </div>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <button
            type="button"
            onClick={() => setActiveTab('monitor')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'monitor'
                ? 'text-cyan-400 underline underline-offset-8 decoration-2 decoration-cyan-400 font-semibold'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            ตรวจจับสด
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'history'
                ? 'text-cyan-400 underline underline-offset-8 decoration-2 decoration-cyan-400 font-semibold'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            ประวัติย้อนหลัง ({state.events.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'settings'
                ? 'text-cyan-400 underline underline-offset-8 decoration-2 decoration-cyan-400 font-semibold'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            ตั้งค่าระบบ
          </button>
        </nav>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {!isInstalled && isInstallable && (
            <button
              type="button"
              onClick={install}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500 text-slate-950 text-xs font-semibold hover:bg-cyan-400 transition-colors whitespace-nowrap"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>ติดตั้งแอป</span>
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              handleUpdateServerConfig({ armedMode: !state.armedMode })
            }
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors whitespace-nowrap ${
              state.armedMode
                ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            {state.armedMode ? (
              <>
                <Bell className="w-3.5 h-3.5" />
                <span>เฝ้าระวัง: เปิด</span>
              </>
            ) : (
              <>
                <BellOff className="w-3.5 h-3.5" />
                <span>พักการเตือน</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 w-full max-w-xl md:max-w-4xl mx-auto px-4 py-5 space-y-5">
        {/* TAB 1: LIVE MOTION & SENSOR MONITOR */}
        {activeTab === 'monitor' && (
          <>
            {/* Live Connection & Topic Banner */}
            <div className="bg-[#0B0E17] border border-slate-800/80 rounded-2xl p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2">
                <div
                  className={`w-2.5 h-2.5 rounded-full ${
                    state.mqttConnected
                      ? 'bg-emerald-400 shadow-[0_0_10px_#10b981]'
                      : 'bg-amber-400'
                  }`}
                />
                <div>
                  <span className="text-slate-400">MQTT Broker: </span>
                  <strong className="text-slate-200 font-mono">HiveMQ Cloud (SSL 8883)</strong>
                </div>
              </div>

              <div className="flex items-center gap-4 text-slate-400 font-mono">
                <div className="flex items-center gap-1">
                  <Radio className="w-3.5 h-3.5 text-cyan-400" />
                  <span>
                    Topics:{' '}
                    <span className="text-cyan-300">sensor/pass_count</span>,{' '}
                    <span className="text-cyan-300">sensor/distance</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Hero Card: Real-time Ultrasonic Distance Meter (HC-SR04) */}
            <div
              className={`rounded-2xl p-6 border transition-all duration-300 relative overflow-hidden ${
                isObjectInRange
                  ? 'bg-gradient-to-br from-amber-950/40 via-[#111827] to-[#0B0E17] border-amber-500 shadow-[0_0_30px_rgba(245,158,11,0.15)]'
                  : 'bg-[#111827] border-slate-800'
              }`}
            >
              {/* Background Radar Waves effect */}
              <div className="absolute -right-8 -top-8 w-40 h-40 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none" />

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start sm:items-center gap-4">
                  <div
                    className={`w-16 h-16 rounded-2xl flex items-center justify-center border shrink-0 transition-colors ${
                      isObjectInRange
                        ? 'bg-amber-500/20 border-amber-400 text-amber-300 animate-pulse'
                        : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                    }`}
                  >
                    <Ruler className="w-8 h-8" />
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs uppercase tracking-wider text-slate-400 font-mono">
                        เซนเซอร์วัดระยะ HC-SR04 (Trig: 26, Echo: 25)
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium ${
                          isObjectInRange
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-slate-800 text-slate-400 border border-slate-700'
                        }`}
                      >
                        เกณฑ์: &lt; {state.thresholdCm} cm
                      </span>
                    </div>

                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-4xl sm:text-5xl font-mono font-black text-slate-100 tracking-tight tabular-nums">
                        {state.currentDistance !== null
                          ? state.currentDistance.toFixed(1)
                          : '--.-'}
                      </span>
                      <span className="text-lg font-mono font-medium text-slate-400">
                        cm
                      </span>
                    </div>

                    <div className="text-xs mt-1">
                      {state.currentDistance === null ? (
                        <span className="text-slate-400">
                          รอสัญญาณระยะทางจากบอร์ด ESP32...
                        </span>
                      ) : isObjectInRange ? (
                        <span className="text-amber-400 font-semibold flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                          ตรวจพบวัตถุเดินผ่านในระยะตรวจจับ!
                        </span>
                      ) : (
                        <span className="text-emerald-400 font-medium">
                          ✓ ระยะปกติ — ไม่มีวัตถุขวางหน้าเซนเซอร์
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Status Badge */}
                <div className="flex flex-col sm:items-end justify-center pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-800/80">
                  <span className="text-[11px] text-slate-400 font-mono">
                    สถานะเซนเซอร์
                  </span>
                  <div
                    className={`mt-1 px-3 py-1 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 font-mono ${
                      state.motionActive || isObjectInRange
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        state.motionActive || isObjectInRange
                          ? 'bg-amber-400'
                          : 'bg-emerald-400'
                      }`}
                    />
                    {state.motionActive || isObjectInRange
                      ? 'DETECTED'
                      : 'STANDBY'}
                  </div>
                  <span className="text-[10px] text-slate-500 mt-1 font-mono tabular-nums">
                    {state.lastMqttMsgAt
                      ? `อัปเดต: ${new Date(state.lastMqttMsgAt).toLocaleTimeString('th-TH')}`
                      : 'ยังไม่มีข้อความเข้า'}
                  </span>
                </div>
              </div>

              {/* Real-time Distance Progress Bar Visualizer */}
              <div className="mt-5 pt-4 border-t border-slate-800/80 space-y-1.5">
                <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                  <span>0 cm (ใกล้สุด)</span>
                  <span className="text-amber-400">เกณฑ์ตรวจจับ ({state.thresholdCm} cm)</span>
                  <span>100+ cm</span>
                </div>
                <div className="h-3 w-full bg-[#0B0E17] rounded-full overflow-hidden relative border border-slate-800">
                  {/* Threshold mark line */}
                  <div
                    style={{ left: `${Math.min(100, (state.thresholdCm / 100) * 100)}%` }}
                    className="absolute top-0 bottom-0 w-0.5 bg-amber-500 z-10"
                  />
                  {/* Current distance fill */}
                  {state.currentDistance !== null && (
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(2, (state.currentDistance / 100) * 100))}%`,
                      }}
                      className={`h-full transition-all duration-150 rounded-full ${
                        isObjectInRange
                          ? 'bg-gradient-to-r from-amber-500 to-rose-500 shadow-[0_0_10px_#f59e0b]'
                          : 'bg-gradient-to-r from-cyan-600 to-cyan-400'
                      }`}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* 2-Column Metric Cards: Pass Counter & Location */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Total People Counter with Progress Ring */}
              <div className="bg-[#111827] border border-slate-800 rounded-2xl p-5 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <UserCheck className="w-3.5 h-3.5 text-cyan-400" />
                    <span>จำนวนคนเดินผ่านทั้งหมด</span>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-4xl sm:text-5xl font-mono font-bold text-slate-100 tabular-nums">
                      {state.totalCount}
                    </span>
                    <span className="text-sm font-mono text-slate-400">
                      ครั้ง
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1 tabular-nums">
                    เป้าหมายแจ้งเตือน: {state.alertThresholdCount} ครั้ง
                  </div>
                </div>

                {/* Micro Progress Ring */}
                <svg className="w-16 h-16 -rotate-90 shrink-0" viewBox="0 0 56 56">
                  <circle
                    cx="28"
                    cy="28"
                    r="22"
                    fill="none"
                    stroke="#1E293B"
                    strokeWidth="5"
                  />
                  <circle
                    cx="28"
                    cy="28"
                    r="22"
                    fill="none"
                    stroke={
                      state.totalCount >= state.alertThresholdCount
                        ? '#F59E0B'
                        : '#06B6D4'
                    }
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeDasharray={`${(progressRatio * 138.2).toFixed(1)} 138.2`}
                  />
                </svg>
              </div>

              {/* Location & Last Detection Info */}
              <div className="bg-[#111827] border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <MapPin className="w-3.5 h-3.5 text-cyan-400" />
                    <span>จุดติดตั้งเซนเซอร์</span>
                  </div>
                  <div className="text-base font-semibold text-slate-100 mt-1 truncate">
                    {state.locationName}
                  </div>
                  <div className="text-xs font-mono text-cyan-400 mt-0.5">
                    บอร์ด: {state.deviceId}
                  </div>
                </div>

                <div className="pt-3 flex items-center justify-between border-t border-slate-800/80 mt-3 text-xs">
                  <span className="text-slate-400 font-mono">ตรวจพบล่าสุด:</span>
                  <span className="font-mono font-semibold text-slate-200 tabular-nums">
                    {state.lastDetectedAt
                      ? new Date(state.lastDetectedAt).toLocaleTimeString('th-TH') + ' น.'
                      : 'ยังไม่มีคนเดินผ่าน'}
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Actions (Reset & Test Audio) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => playMobileSound(soundTone)}
                className="w-full min-h-[46px] rounded-xl bg-[#111827] border border-slate-700 text-slate-200 font-medium text-xs flex items-center justify-center gap-2 hover:bg-slate-800 transition-colors"
              >
                <Volume2 className="w-4 h-4 text-cyan-400" />
                <span>ทดสอบเสียงแจ้งเตือน ({soundTone})</span>
              </button>

              <button
                type="button"
                onClick={handleResetCounter}
                className="w-full min-h-[46px] rounded-xl bg-[#111827] border border-slate-700 text-slate-300 font-medium text-xs flex items-center justify-center gap-2 hover:border-rose-500/60 hover:text-rose-300 transition-colors"
              >
                <RotateCcw className="w-4 h-4 text-rose-400" />
                <span>รีเซ็ตตัวนับเป็น 0 (ล้างประวัติ)</span>
              </button>
            </div>

            {/* Recent Activity Live List */}
            <div className="bg-[#111827] border border-slate-800 rounded-2xl p-5">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  <h2 className="text-sm font-semibold text-slate-100">
                    รายการตรวจพบล่าสุดจากเซนเซอร์จริง
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('history')}
                  className="text-xs text-cyan-400 font-medium hover:underline"
                >
                  ดูทั้งหมด ({state.events.length}) →
                </button>
              </div>

              {state.events.length === 0 ? (
                <div className="py-10 text-center space-y-2">
                  <div className="w-10 h-10 rounded-full bg-slate-800/80 border border-slate-700 mx-auto flex items-center justify-center text-slate-400">
                    <UserCheck className="w-5 h-5" />
                  </div>
                  <div className="text-xs font-medium text-slate-300">
                    ยังไม่มีข้อมูลคนเดินผ่าน
                  </div>
                  <div className="text-[11px] text-slate-500 max-w-sm mx-auto">
                    เมื่อมีคนเดินผ่านเซนเซอร์ HC-SR04 ในระยะ &lt; {state.thresholdCm} ซม. ระบบจะนับและบันทึกประวัติแบบเรียลไทม์ทันที
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-slate-800/70">
                  {state.events.slice(0, 5).map((evt) => (
                    <div
                      key={evt.id}
                      className="min-h-[56px] py-2.5 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-full bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-xs font-mono font-bold text-cyan-300 shrink-0 tabular-nums">
                          #{evt.countIndex}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-100 truncate">
                            ตรวจพบคนเดินผ่าน · {evt.locationName}
                          </div>
                          <div className="text-xs text-slate-400 font-mono">
                            {evt.distance !== undefined ? (
                              <span className="text-cyan-400">ระยะ: {evt.distance.toFixed(1)} cm · </span>
                            ) : null}
                            เซนเซอร์ ESP32 (HC-SR04)
                          </div>
                        </div>
                      </div>

                      <div className="text-right font-mono tabular-nums shrink-0">
                        <div className="text-xs font-semibold text-slate-200">
                          {new Date(evt.timestamp).toLocaleTimeString('th-TH', {
                            hour12: false,
                          })}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {new Date(evt.timestamp).toLocaleDateString('th-TH')}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}


        {/* TAB 3: HISTORY LOG & CSV EXPORT */}
        {activeTab === 'history' && (
          <div className="bg-[#111827] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  ประวัติเวลาที่คนเดินผ่าน ({filteredEvents.length} รายการ)
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  เรียงลำดับจากเวลาล่าสุดลงมา (ข้อมูลจริงจากเซนเซอร์)
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={filteredEvents.length === 0}
                  onClick={handleExportCsv}
                  className="flex items-center gap-1.5 px-3.5 min-h-[40px] rounded-xl bg-cyan-500 text-slate-950 text-xs font-semibold hover:bg-cyan-400 disabled:opacity-50 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>ส่งออก CSV</span>
                </button>
                <button
                  type="button"
                  onClick={handleResetCounter}
                  className="flex items-center gap-1.5 px-3 min-h-[40px] rounded-xl bg-[#0B0E17] border border-slate-700 text-xs text-slate-300 hover:border-rose-500 hover:text-rose-300 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                  <span>ล้างประวัติ</span>
                </button>
              </div>
            </div>

            {filteredEvents.length === 0 ? (
              <div className="py-14 text-center text-xs text-slate-400 space-y-1">
                <div className="text-slate-300 font-medium">ยังไม่มีประวัติการเดินผ่าน</div>
                <div>ข้อมูลทั้งหมดเริ่มต้นที่ 0 และจะบันทึกอัตโนมัติเมื่อมีคนเดินผ่าน</div>
              </div>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {filteredEvents.map((evt) => (
                  <div
                    key={evt.id}
                    className="min-h-[60px] py-3 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-xs font-mono font-bold text-cyan-300 shrink-0 tabular-nums">
                        #{evt.countIndex}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-100 truncate">
                          {evt.locationName}
                        </div>
                        <div className="text-xs text-slate-400 font-mono">
                          {evt.deviceId}
                          {evt.distance !== undefined && (
                            <span className="text-cyan-400 font-semibold"> · ระยะ {evt.distance.toFixed(1)} cm</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="text-right font-mono tabular-nums shrink-0">
                      <div className="text-sm font-semibold text-slate-100">
                        {new Date(evt.timestamp).toLocaleTimeString('th-TH', {
                          hour12: false,
                        })}{' '}
                        น.
                      </div>
                      <div className="text-xs text-slate-400">
                        {new Date(evt.timestamp).toLocaleDateString('th-TH')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: MOBILE SETTINGS & CONFIG */}
        {activeTab === 'settings' && (
          <div className="space-y-5">
            {/* Install App on Mobile Home Screen Card */}
            <div className="bg-[#111827] border border-cyan-500/40 rounded-2xl p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-300 shrink-0">
                    <Smartphone className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">
                      ติดตั้งแอปลงหน้าจอมือถือ (PWA)
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      เปิดดูจำนวนคนเดินผ่านได้สะดวกรวดเร็วแบบแอปมือถือ
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                {isInstalled ? (
                  <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3">
                    <Check className="w-4 h-4" />
                    <span>ติดตั้งแอปลงบนอุปกรณ์นี้เรียบร้อยแล้ว</span>
                  </div>
                ) : isInstallable ? (
                  <button
                    type="button"
                    onClick={install}
                    className="w-full min-h-[48px] rounded-xl bg-cyan-500 text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 hover:bg-cyan-400 transition-colors"
                  >
                    <Smartphone className="w-4 h-4" />
                    <span>กดเพื่อติดตั้งแอปลงมือถือทันที (Install App)</span>
                  </button>
                ) : (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setShowIOSModal((v) => !v)}
                      className="w-full min-h-[46px] rounded-xl bg-[#0B0E17] border border-cyan-500/50 text-cyan-300 font-medium text-xs flex items-center justify-center gap-2"
                    >
                      <Smartphone className="w-4 h-4" />
                      <span>
                        {isIOS
                          ? 'วิธีเพิ่มแอปลงหน้าจอโฮมสำหรับ iPhone / iPad'
                          : 'วิธีเพิ่มแอปลงหน้าจอโฮมมือถือ (Android / iOS)'}
                      </span>
                    </button>

                    {showIOSModal && (
                      <div className="bg-[#0B0E17] border border-slate-800 rounded-xl p-4 text-xs text-slate-300 space-y-1.5 leading-relaxed">
                        <div className="font-semibold text-slate-100">
                          ขั้นตอนการติดตั้งลงหน้าจอมือถือ:
                        </div>
                        <div>
                          • <strong>Android (Chrome):</strong> แตะเมนูจุด 3 จุดมุมขวาบน แล้วเลือก{' '}
                          <strong className="text-cyan-300">
                            "ติดตั้งแอป" (Install app)
                          </strong>{' '}
                          หรือ <strong className="text-cyan-300">"เพิ่มลงในหน้าจอหลัก"</strong>
                        </div>
                        <div>
                          • <strong>iPhone / iOS (Safari):</strong> แตะปุ่ม{' '}
                          <strong className="text-cyan-300">แชร์ (Share)</strong> ด้านล่าง แล้วเลือก{' '}
                          <strong className="text-cyan-300">
                            "เพิ่มไปยังหน้าจอโฮม" (Add to Home Screen)
                          </strong>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Sound & Notification Controls */}
            <div className="bg-[#111827] border border-slate-800 rounded-2xl p-5 space-y-4">
              <h2 className="text-base font-semibold text-slate-100 pb-3 border-b border-slate-800">
                การแจ้งเตือนบนอุปกรณ์
              </h2>

              {/* Sound Toggle */}
              <div className="flex items-center justify-between min-h-[48px]">
                <div className="flex items-center gap-3">
                  <Volume2 className="w-5 h-5 text-cyan-400" />
                  <div>
                    <div className="text-sm font-medium text-slate-100">
                      เสียงแจ้งเตือนเมื่อมีคนเดินผ่าน
                    </div>
                    <div className="text-xs text-slate-400">
                      ส่งเสียงเตือนทันทีที่เซนเซอร์ตรวจจับได้
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSoundEnabled((v) => !v)}
                  className={`min-w-[76px] min-h-[40px] px-3 rounded-xl text-xs font-semibold border transition-colors ${
                    soundEnabled
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                      : 'bg-[#0B0E17] border-slate-700 text-slate-400'
                  }`}
                >
                  {soundEnabled ? 'เปิดอยู่' : 'ปิด'}
                </button>
              </div>

              {/* Tone Selector */}
              <div className="bg-[#0B0E17] border border-slate-800 rounded-xl p-3.5 space-y-2.5">
                <div className="text-xs text-slate-400">
                  เลือกรูปแบบเสียงแจ้งเตือน (กดเพื่อทดลองฟังเสียง):
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'chime', label: 'กระดิ่งร้านค้า' },
                    { id: 'beep', label: 'บี๊บมาตรฐาน' },
                    { id: 'siren', label: 'ไซเรนเตือนภัย' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        const nextTone = t.id as SoundTone;
                        setSoundTone(nextTone);
                        playMobileSound(nextTone);
                      }}
                      className={`min-h-[42px] px-2 rounded-lg text-xs font-medium border transition-colors ${
                        soundTone === t.id
                          ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                          : 'bg-[#111827] border-slate-800 text-slate-400'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Vibration Toggle */}
              <div className="flex items-center justify-between min-h-[48px] pt-2 border-t border-slate-800/70">
                <div className="flex items-center gap-3">
                  <Vibrate className="w-5 h-5 text-cyan-400" />
                  <div>
                    <div className="text-sm font-medium text-slate-100">
                      สั่นโทรศัพท์เมื่อตรวจพบคนเดินผ่าน
                    </div>
                    <div className="text-xs text-slate-400">
                      สั่นเตือนที่เครื่องโทรศัพท์อัตโนมัติ
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setVibrateEnabled((v) => !v)}
                  className={`min-w-[76px] min-h-[40px] px-3 rounded-xl text-xs font-semibold border transition-colors ${
                    vibrateEnabled
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                      : 'bg-[#0B0E17] border-slate-700 text-slate-400'
                  }`}
                >
                  {vibrateEnabled ? 'เปิดอยู่' : 'ปิด'}
                </button>
              </div>

              {/* Browser Push Notification Toggle */}
              <div className="flex items-center justify-between min-h-[48px] pt-2 border-t border-slate-800/70">
                <div className="flex items-center gap-3">
                  <Bell className="w-5 h-5 text-cyan-400" />
                  <div>
                    <div className="text-sm font-medium text-slate-100">
                      ข้อความแจ้งเตือนเด้งบนหน้าจอ
                    </div>
                    <div className="text-xs text-slate-400">
                      แสดงแบนเนอร์แจ้งเตือนเมื่อมีคนผ่าน
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleEnablePushNotification}
                  className={`min-w-[76px] min-h-[40px] px-3 rounded-xl text-xs font-semibold border transition-colors ${
                    pushNotifyEnabled
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                      : 'bg-[#0B0E17] border-slate-700 text-slate-400'
                  }`}
                >
                  {pushNotifyEnabled ? 'เปิดอยู่' : 'เปิดใช้'}
                </button>
              </div>
            </div>

            {/* Threshold & Location Settings Form */}
            <form
              onSubmit={handleSaveSettingsForm}
              className="bg-[#111827] border border-slate-800 rounded-2xl p-5 space-y-4"
            >
              <h2 className="text-base font-semibold text-slate-100 pb-3 border-b border-slate-800">
                ตั้งค่าฮาร์ดแวร์และจุดตรวจจับ
              </h2>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  ระยะตรวจจับวัตถุ HC-SR04 (ซม.)
                </label>
                <input
                  type="number"
                  min="5"
                  max="400"
                  step="0.5"
                  value={distanceThresholdInput}
                  onChange={(e) =>
                    setDistanceThresholdInput(parseFloat(e.target.value) || 50.0)
                  }
                  className="w-full min-h-[44px] bg-[#0B0E17] border border-slate-700 rounded-xl px-3.5 text-sm font-mono text-cyan-300 tabular-nums focus:outline-none focus:border-cyan-500"
                />
                <span className="text-[11px] text-slate-500 mt-1 block">
                  ค่าในโค้ด ESP32 ตั้งไว้ที่ 50.0 ซม. (THRESHOLD_CM)
                </span>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  ชื่อจุดติดตั้งเซนเซอร์
                </label>
                <div className="flex flex-wrap gap-2 mb-2.5">
                  {[
                    'จุดตรวจนับคนเดินผ่าน (HC-SR04)',
                    'ประตูหน้าร้าน',
                    'ทางเข้าอาคาร',
                    'ทางเดิน',
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setLocationInput(preset)}
                      className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                        locationInput === preset
                          ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300'
                          : 'bg-[#0B0E17] border-slate-800 text-slate-400'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                  className="w-full min-h-[44px] bg-[#0B0E17] border border-slate-700 rounded-xl px-3.5 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  เกณฑ์แจ้งเตือนเป้าหมายจำนวนคน (ครั้ง)
                </label>
                <input
                  type="number"
                  min="1"
                  value={thresholdInput}
                  onChange={(e) =>
                    setThresholdInput(parseInt(e.target.value, 10) || 20)
                  }
                  className="w-full min-h-[44px] bg-[#0B0E17] border border-slate-700 rounded-xl px-3.5 text-sm font-mono text-cyan-300 tabular-nums focus:outline-none focus:border-cyan-500"
                />
              </div>

              <button
                type="submit"
                className="w-full min-h-[48px] rounded-xl bg-cyan-500 text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 hover:bg-cyan-400 transition-colors"
              >
                {savedToast ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>บันทึกการตั้งค่าเรียบร้อยแล้ว</span>
                  </>
                ) : (
                  <span>บันทึกการตั้งค่า</span>
                )}
              </button>
            </form>
          </div>
        )}
      </main>

      {/* Fixed Bottom Tab Bar for Mobile Touch Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0B0E17]/95 backdrop-blur-md border-t border-slate-800">
        <div className="grid grid-cols-3 items-center h-16">
          <button
            type="button"
            onClick={() => setActiveTab('monitor')}
            className={`flex flex-col items-center justify-center min-h-[44px] transition-colors ${
              activeTab === 'monitor' ? 'text-cyan-400' : 'text-slate-400'
            }`}
          >
            <Activity className="w-5 h-5" />
            <span className="text-[11px] font-medium tracking-tight mt-1">
              ตรวจจับสด
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex flex-col items-center justify-center min-h-[44px] transition-colors ${
              activeTab === 'history' ? 'text-cyan-400' : 'text-slate-400'
            }`}
          >
            <Clock className="w-5 h-5" />
            <span className="text-[11px] font-medium tracking-tight mt-1">
              ประวัติ ({state.events.length})
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`flex flex-col items-center justify-center min-h-[44px] transition-colors ${
              activeTab === 'settings' ? 'text-cyan-400' : 'text-slate-400'
            }`}
          >
            <Settings className="w-5 h-5" />
            <span className="text-[11px] font-medium tracking-tight mt-1">
              ตั้งค่า
            </span>
          </button>
        </div>
      </nav>
    </div>
  );
}
