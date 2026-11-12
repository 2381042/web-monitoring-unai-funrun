import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Circle,
  Polyline,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import {
  Users,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  ShieldAlert,
  Volume2,
  VolumeX,
  MapPin,
  Clock,
  Lock,
  LogOut,
  Sliders,
  Navigation,
  X,
  ArrowRight,
  Activity,
  Check,
} from 'lucide-react';
import { Checkpoint, EventData, Incident, Volunteer } from '../types';
import { socket, API_BASE_URL } from '../socket';

// Komponen pengatur kamera peta otomatis (fitBounds / center) mengikuti koordinat Checkpoints terbaru di database
function MapCameraBoundsController({
  checkpoints,
  isCalibrating,
}: {
  checkpoints: Checkpoint[];
  isCalibrating: boolean;
}) {
  const map = useMap();
  const hasInitialFitRef = useRef<boolean>(false);

  useEffect(() => {
    if (!checkpoints || checkpoints.length === 0) return;

    // Saat pertama kali data checkpoints dimuat atau saat tidak sedang mengklik peta di mode kalibrasi,
    // sesuaikan kamera peta (fitBounds) agar fokus ke seluruh titik Checkpoints terbaru
    if (!hasInitialFitRef.current || !isCalibrating) {
      const bounds = L.latLngBounds(
        checkpoints.map((cp) => [Number(cp.latitude), Number(cp.longitude)] as [number, number])
      );
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
        hasInitialFitRef.current = true;
      }
    }
  }, [checkpoints, isCalibrating, map]);

  return null;
}

// Pembuat Ikon Dinamis Leaflet untuk Checkpoints, Volunteers, dan Incidents
function createCheckpointIcon(isMainPost: boolean, label: string) {
  const bg = isMainPost ? '#059669' : '#2563eb';
  return new L.DivIcon({
    className: 'custom-cp-marker',
    html: `<div style="background:${bg};color:#fff;padding:2px 6px;border-radius:6px;border:2px solid #fff;font-size:10px;font-weight:800;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.5);transform:translate(-50%,-50%);">${label}</div>`,
    iconSize: [0, 0],
  });
}

function createVolunteerIcon(status: string, name: string) {
  let color = '#64748b'; // Unknown -> Abu-abu
  if (status === 'Active') color = '#10b981'; // Active -> Hijau
  else if (status === 'Active (Mobile)') color = '#3b82f6'; // Active (Mobile) -> Biru
  else if (status === 'Out of Area') color = '#f97316'; // Out of Area -> Oranye/Merah

  return new L.DivIcon({
    className: 'custom-vol-marker',
    html: `<div title="${name} (${status})" style="background:${color};width:18px;height:18px;border-radius:9999px;border:3px solid #ffffff;box-shadow:0 0 8px ${color};"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function createIncidentIcon(isEscalated: boolean) {
  const bg = isEscalated ? '#dc2626' : '#ef4444';
  const ring = isEscalated ? '0 0 16px 6px rgba(239,68,68,0.95)' : '0 0 10px rgba(239,68,68,0.8)';
  return new L.DivIcon({
    className: 'custom-incident-marker',
    html: `<div style="background:${bg};width:26px;height:26px;border-radius:9999px;border:3px solid #fff;box-shadow:${ring};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:13px;">!</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

// Komponen klik peta untuk kalibrasi koordinat pos (Subbab 2.2.B)
function CalibrationMapClickHandler({
  enabled,
  onPickCoords,
}: {
  enabled: boolean;
  onPickCoords: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (enabled) {
        onPickCoords(
          Number(e.latlng.lat.toFixed(6)),
          Number(e.latlng.lng.toFixed(6))
        );
      }
    },
  });
  return null;
}

// Helper format durasi (detik -> "Xm Ys" atau "Ys")
function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }
  const totalSec = Math.round(seconds);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) {
    return `${secs} dtk`;
  }
  return `${mins} mnt ${secs} dtk`;
}

export default function CoordinatorDashboard() {
  // State Autentikasi Koordinator (UC-01)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return sessionStorage.getItem('unai_coordinator_auth') === 'true';
  });
  const [username, setUsername] = useState<string>('admin');
  const [password, setPassword] = useState<string>('unai2026');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Data Utama Sistem
  const [eventData, setEventData] = useState<EventData | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [volunteers, setVolunteers] = useState<Volunteer[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);

  // Pilihan Insiden untuk Seksi Bawah: Detail Penanganan & Pelacak Waktu 3 Fase (UC-09)
  const [selectedIncidentId, setSelectedIncidentId] = useState<number | null>(null);

  // State Jam Real-Time Setiap Detik untuk Evaluasi Eskalasi Otomatis (> 120 Detik)
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [audioMuted, setAudioMuted] = useState<boolean>(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // State Kalibrasi Koordinat Pos (Subbab 2.2.B)
  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);
  const [calibCheckpointId, setCalibCheckpointId] = useState<number | ''>('');
  const [calibLat, setCalibLat] = useState<string>('');
  const [calibLng, setCalibLng] = useState<string>('');
  const [calibFeedback, setCalibFeedback] = useState<string | null>(null);

  // Pilihan Petugas Penangani Saat Koordinator Mengunci Status Handled (UC-08)
  const [selectedHandlerId, setSelectedHandlerId] = useState<number | ''>('');
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Fetch data awal dari /api/init
  const fetchInitData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/init`);
      const data = await res.json();
      if (data.success) {
        setEventData(data.event);
        setCheckpoints(data.checkpoints || []);
        setVolunteers(data.volunteers || []);
        setIncidents(data.incidents || []);
        if (data.incidents && data.incidents.length > 0) {
          setSelectedIncidentId((prev) => prev ?? data.incidents[0].id);
        }
        if (data.checkpoints && data.checkpoints.length > 0 && !calibCheckpointId) {
          const firstCp = data.checkpoints[0];
          setCalibCheckpointId(firstCp.id);
          setCalibLat(String(firstCp.latitude));
          setCalibLng(String(firstCp.longitude));
        }
      }
    } catch (err) {
      console.error('[Dashboard] Gagal memuat /api/init:', err);
    }
  }, [calibCheckpointId]);

  useEffect(() => {
    fetchInitData();
  }, []);

  // Fungsi Web Audio API: Bunyi Alarm Darurat Berulang saat Eskalasi > 120 Detik (Subbab 2.1 & 2.2.C)
  const playEscalationAlarmBeep = useCallback(() => {
    if (audioMuted) return;
    try {
      const AudioContextClass =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1174.66, now + 0.18);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.4);
    } catch {
      // Abaikan jika pengguna belum berinteraksi dengan dokumen
    }
  }, [audioMuted]);

  // Interval Setiap 1 Detik: Evaluasi NOW() - created_at pada seluruh insiden berstatus 'New'
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Hitung daftar insiden yang mengalami Eskalasi Otomatis (status === 'New' dan durasi > 120 detik)
  const escalatedIncidentIds = useMemo(() => {
    const ids = new Set<number>();
    for (const inc of incidents) {
      if (inc.status_insiden === 'New') {
        const createdMs = new Date(inc.created_at).getTime();
        const elapsedSeconds = (nowMs - createdMs) / 1000;
        if (elapsedSeconds > 120) {
          ids.add(inc.id);
        }
      }
    }
    return ids;
  }, [incidents, nowMs]);

  // Bunyikan alarm Web Audio API berulang setiap 2 detik selama ada insiden berstatus 'New' > 120 detik
  useEffect(() => {
    if (!isAuthenticated || escalatedIncidentIds.size === 0) return;

    playEscalationAlarmBeep();
    const alarmInterval = setInterval(() => {
      playEscalationAlarmBeep();
    }, 2000);

    return () => clearInterval(alarmInterval);
  }, [isAuthenticated, escalatedIncidentIds.size, playEscalationAlarmBeep]);

  // Urutkan daftar insiden pada Panel Tengah Kanan:
  // Insiden 'New' yang tereskalasi (> 120 detik) wajib ditempatkan di baris paling atas!
  const sortedNotifications = useMemo(() => {
    return [...incidents].sort((a, b) => {
      const aEscalated = escalatedIncidentIds.has(a.id) ? 1 : 0;
      const bEscalated = escalatedIncidentIds.has(b.id) ? 1 : 0;
      if (aEscalated !== bEscalated) {
        return bEscalated - aEscalated;
      }
      const aOrder = a.status_insiden === 'New' ? 2 : a.status_insiden === 'Handled' ? 1 : 0;
      const bOrder = b.status_insiden === 'New' ? 2 : b.status_insiden === 'Handled' ? 1 : 0;
      if (aOrder !== bOrder) {
        return bOrder - aOrder;
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [incidents, escalatedIncidentIds]);

  // Listener Socket.IO Real-Time
  useEffect(() => {
    const onVolunteerUpdated = (updatedVol: Volunteer) => {
      setVolunteers((prev) => {
        const exists = prev.some((v) => v.id === updatedVol.id);
        if (exists) {
          return prev.map((v) => (v.id === updatedVol.id ? updatedVol : v));
        }
        return [updatedVol, ...prev];
      });
    };

    const onCheckpointUpdated = (updatedCp: Checkpoint) => {
      setCheckpoints((prev) =>
        prev.map((cp) => (cp.id === updatedCp.id ? updatedCp : cp))
      );
    };

    const onNewIncident = (newInc: Incident) => {
      setIncidents((prev) => {
        const exists = prev.some((i) => i.id === newInc.id);
        if (exists) {
          return prev.map((i) => (i.id === newInc.id ? newInc : i));
        }
        return [newInc, ...prev];
      });
      setSelectedIncidentId(newInc.id);
      playEscalationAlarmBeep();
    };

    const onStatusUpdated = (updatedInc: Incident) => {
      setIncidents((prev) =>
        prev.map((inc) => (inc.id === updatedInc.id ? updatedInc : inc))
      );
    };

    const onStatusUpdateRejected = (payload: { message: string }) => {
      setActionFeedback(payload.message);
      window.alert(payload.message);
    };

    socket.on('volunteer_updated', onVolunteerUpdated);
    socket.on('checkpoint_updated', onCheckpointUpdated);
    socket.on('new_incident', onNewIncident);
    socket.on('status_updated', onStatusUpdated);
    socket.on('status_update_rejected', onStatusUpdateRejected);

    return () => {
      socket.off('volunteer_updated', onVolunteerUpdated);
      socket.off('checkpoint_updated', onCheckpointUpdated);
      socket.off('new_incident', onNewIncident);
      socket.off('status_updated', onStatusUpdated);
      socket.off('status_update_rejected', onStatusUpdateRejected);
    };
  }, [playEscalationAlarmBeep]);

  // Perhitungan 4 Kartu Ringkasan Real-Time (Baris Atas - UC-07)
  const summaryStats = useMemo(() => {
    const total = volunteers.length;
    const activeCount = volunteers.filter(
      (v) => v.status_lokasi === 'Active' || v.status_lokasi === 'Active (Mobile)'
    ).length;
    const outOfAreaCount = volunteers.filter(
      (v) => v.status_lokasi === 'Out of Area'
    ).length;
    const unknownCount = volunteers.filter(
      (v) => v.status_lokasi === 'Unknown'
    ).length;

    return { total, activeCount, outOfAreaCount, unknownCount };
  }, [volunteers]);

  // Insiden terpilih untuk Seksi Detail Penanganan Insiden & Pelacak Waktu 3 Fase (UC-09)
  const selectedIncident = useMemo(() => {
    if (selectedIncidentId) {
      const found = incidents.find((i) => i.id === selectedIncidentId);
      if (found) return found;
    }
    return incidents[0] || null;
  }, [incidents, selectedIncidentId]);

  // Garis Rute (<Polyline />) Dinamis Mengikuti Urutan Lintasan:
  // Pos 3 (Start) -> Simpang Marshal 1 -> Pos 1 -> Simpang Marshal 2 -> Simpang Marshal 3 -> Simpang Marshal 4 -> Simpang Marshal 5 -> Pos 2 -> Pos 3 (Finish)
  const dynamicRoutePositions = useMemo<[number, number][]>(() => {
    if (!checkpoints || checkpoints.length === 0) return [];

    const routeOrderPrefixes = [
      'Pos 3',
      'Simpang Marshal 1',
      'Pos 1',
      'Simpang Marshal 2',
      'Simpang Marshal 3',
      'Simpang Marshal 4',
      'Simpang Marshal 5',
      'Pos 2',
      'Pos 3',
    ];

    const orderedCoords: [number, number][] = [];
    for (const prefix of routeOrderPrefixes) {
      const matched = checkpoints.find((cp) =>
        cp.nama_pos.toLowerCase().startsWith(prefix.toLowerCase())
      );
      if (matched) {
        orderedCoords.push([Number(matched.latitude), Number(matched.longitude)]);
      }
    }

    return orderedCoords;
  }, [checkpoints]);

  // Posisi Tengah Peta (center) Dinamis Mengikuti Rata-Rata Koordinat Checkpoints Terbaru di Database
  const dynamicMapCenter = useMemo<[number, number]>(() => {
    if (!checkpoints || checkpoints.length === 0) {
      return [-6.814834, 107.582814];
    }
    const sumLat = checkpoints.reduce((acc, cp) => acc + Number(cp.latitude), 0);
    const sumLng = checkpoints.reduce((acc, cp) => acc + Number(cp.longitude), 0);
    return [sumLat / checkpoints.length, sumLng / checkpoints.length];
  }, [checkpoints]);

  // Handler Login Koordinator (UC-01)
  const handleCoordinatorLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);

    try {
      const res = await fetch(`${API_BASE_URL}/api/coordinator/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setLoginError(data.message || 'Autentikasi gagal.');
        return;
      }
      sessionStorage.setItem('unai_coordinator_auth', 'true');
      setIsAuthenticated(true);
      fetchInitData();
    } catch (err) {
      setLoginError(`Gagal menghubungi server: ${(err as Error).message}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Handler Kalibrasi Koordinat Pos (PUT /api/checkpoints/:id - Subbab 2.2.B)
  const handleSaveCalibration = async (e: React.FormEvent) => {
    e.preventDefault();
    setCalibFeedback(null);
    if (!calibCheckpointId) return;

    try {
      const res = await fetch(`${API_BASE_URL}/api/checkpoints/${calibCheckpointId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: Number(calibLat),
          longitude: Number(calibLng),
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.checkpoint) {
          setCheckpoints((prev) =>
            prev.map((cp) => (cp.id === data.checkpoint.id ? data.checkpoint : cp))
          );
        }
        setCalibFeedback(data.message);
      } else {
        setCalibFeedback(`Gagal: ${data.message}`);
      }
    } catch (err) {
      setCalibFeedback(`Error: ${(err as Error).message}`);
    }
  };

  const handleUseCurrentGpsForCalibration = () => {
    if (!('geolocation' in navigator)) {
      window.alert('Peramban tidak mendukung Web Geolocation API.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCalibLat(pos.coords.latitude.toFixed(6));
        setCalibLng(pos.coords.longitude.toFixed(6));
        setCalibFeedback('Koordinat GPS perangkat saat ini berhasil diambil.');
      },
      (err) => {
        window.alert(`Gagal mengambil GPS: ${err.message}`);
      },
      { enableHighAccuracy: true }
    );
  };

  // Handler Pembaruan Status Insiden oleh Koordinator (UC-08: Handled / Resolved)
  const handleIncidentStatusUpdate = (
    incident: Incident,
    targetStatus: 'Handled' | 'Resolved'
  ) => {
    setActionFeedback(null);
    const chosenHandler =
      selectedHandlerId !== ''
        ? Number(selectedHandlerId)
        : volunteers.find((v) => v.role === 'Tim Medis Mobile' || v.role === 'Medis Pos')?.id ||
          incident.id_pelapor;

    socket.emit(
      'update_status',
      {
        incident_id: incident.id,
        id_penangani: targetStatus === 'Handled' ? chosenHandler : incident.id_penangani,
        status: targetStatus,
        client_timestamp: Date.now(),
      },
      (ack: {
        success: boolean;
        locked?: boolean;
        incident?: Incident;
        message?: string;
      }) => {
        if (ack && !ack.success && ack.message) {
          setActionFeedback(ack.message);
          window.alert(ack.message);
        } else if (ack && ack.success) {
          setActionFeedback(
            `Laporan #${incident.id} berhasil diperbarui menjadi ${targetStatus.toUpperCase()}.`
          );
        }
      }
    );
  };

  // ============================================================================
  // TAMPILAN LOGIN KOORDINATOR (UC-01) JIKA BELUM AUTENTIKASI
  // ============================================================================
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-6">
        <header className="max-w-6xl w-full mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 font-bold">
              FR
            </div>
            <span className="font-bold text-sm text-white">
              UNAI Fun Run 2026 — Sistem Manajemen Operasional Relawan
            </span>
          </div>
          <Link
            to="/relawan"
            className="text-xs font-semibold text-emerald-400 hover:text-emerald-300"
          >
            &larr; Buka Portal Web Relawan (`/relawan`)
          </Link>
        </header>

        <div className="max-w-md w-full mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
          <div className="mb-5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400">
              UC-01 &bull; Autentikasi Akses Sistem
            </span>
            <h1 className="text-xl font-extrabold text-white mt-1">
              Login Koordinator (Race Director &amp; Admin)
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Memisahkan kredensial khusus Koordinator dari kode PIN sesi acara relawan.
            </p>
          </div>

          <form onSubmit={handleCoordinatorLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Username Koordinator
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                required
              />
            </div>

            {loginError && (
              <div className="rounded-lg bg-red-950/70 border border-red-500/60 p-3 text-xs text-red-200">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 text-sm transition"
            >
              {isLoggingIn ? 'Memverifikasi Kredensial...' : 'Masuk ke Dashboard Monitoring'}
            </button>

            <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 text-[11px] text-slate-400 font-mono">
              Default Kredensial Koordinator: username = <strong className="text-slate-200">admin</strong> | password ={' '}
              <strong className="text-slate-200">unai2026</strong>
            </div>
          </form>
        </div>

        <footer className="text-center text-xs text-slate-500">
          Studi Kasus: UNAI Fun Run 2026 &bull; Dashboard Monitoring &amp; Real-Time Incident Alert
        </footer>
      </div>
    );
  }

  // ============================================================================
  // TAMPILAN UTAMA DASHBOARD MONITORING KOORDINATOR (WIREFRAME GAMBAR 5)
  // ============================================================================
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header Navigasi Atas */}
      <header className="bg-slate-900/90 border-b border-slate-800 px-4 md:px-6 py-3 sticky top-0 z-30 backdrop-blur">
        <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 font-extrabold">
              RD
            </div>
            <div>
              <h1 className="text-base md:text-lg font-extrabold text-white">
                Dashboard Monitoring — {eventData?.nama_event || 'UNAI Fun Run 2026'}
              </h1>
              <p className="text-xs text-slate-400">
                Race Director &amp; Admin &bull; Pemantauan Rute 7,2 km, Geofencing &amp; Eskalasi Insiden Real-Time
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {escalatedIncidentIds.size > 0 && (
              <span className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-extrabold animate-pulse flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4" />
                {escalatedIncidentIds.size} INSIDEN ESKALASI (&gt; 120s)!
              </span>
            )}

            <button
              type="button"
              onClick={() => setAudioMuted((prev) => !prev)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border flex items-center gap-1.5 transition ${
                audioMuted
                  ? 'bg-slate-800 border-slate-700 text-slate-400'
                  : 'bg-indigo-950/80 border-indigo-500/50 text-indigo-300'
              }`}
              title="Web Audio API Alarm Eskalasi (> 120 detik)"
            >
              {audioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              <span>Alarm Audio: {audioMuted ? 'MUTE' : 'AKTIF'}</span>
            </button>

            <button
              type="button"
              onClick={() => setIsCalibrating((prev) => !prev)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border flex items-center gap-1.5 transition ${
                isCalibrating
                  ? 'bg-amber-500 text-slate-950 border-amber-400 font-bold'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Kalibrasi Koordinat Pos</span>
            </button>

            <Link
              to="/relawan"
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition"
            >
              Portal Relawan (`/relawan`)
            </Link>

            <button
              type="button"
              onClick={() => {
                sessionStorage.removeItem('unai_coordinator_auth');
                setIsAuthenticated(false);
              }}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-red-950/60 border border-slate-700 text-slate-300 text-xs flex items-center gap-1 transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Keluar</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto p-4 md:p-6 space-y-6">
        {/* ===================================================================
            1. BARIS ATAS: 4 KARTU RINGKASAN REAL-TIME (UC-07)
        =================================================================== */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Kartu 1: Total Relawan */}
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-slate-400 block">
                Total Relawan
              </span>
              <strong className="text-3xl font-extrabold text-white mt-1 block">
                {summaryStats.total}
              </strong>
              <span className="text-[11px] text-slate-400 mt-1 block">
                Terdaftar pada sesi acara aktif
              </span>
            </div>
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Users className="w-6 h-6" />
            </div>
          </div>

          {/* Kartu 2: Status Active (<= 100m Pos / <= 50m Marshal + Active Mobile) */}
          <div className="rounded-xl bg-slate-900 border border-emerald-500/40 p-4 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-emerald-400 block">
                Status Active (&le; 100m Pos / &le; 50m Marshal)
              </span>
              <strong className="text-3xl font-extrabold text-emerald-300 mt-1 block">
                {summaryStats.activeCount}
              </strong>
              <span className="text-[11px] text-slate-400 mt-1 block">
                Termasuk Relawan Bergerak (Active Mobile)
              </span>
            </div>
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-6 h-6" />
            </div>
          </div>

          {/* Kartu 3: Out of Area (> 100m Pos / > 50m Marshal) */}
          <div className="rounded-xl bg-slate-900 border border-orange-500/40 p-4 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-orange-400 block">
                Out of Area (&gt; 100m Pos / &gt; 50m Marshal)
              </span>
              <strong className="text-3xl font-extrabold text-orange-300 mt-1 block">
                {summaryStats.outOfAreaCount}
              </strong>
              <span className="text-[11px] text-slate-400 mt-1 block">
                Melampaui radius pemantauan pos
              </span>
            </div>
            <div className="w-12 h-12 rounded-xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center text-orange-400">
              <AlertTriangle className="w-6 h-6" />
            </div>
          </div>

          {/* Kartu 4: Unknown (> 180s) */}
          <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-slate-300 block">
                Unknown (&gt; 180s)
              </span>
              <strong className="text-3xl font-extrabold text-slate-200 mt-1 block">
                {summaryStats.unknownCount}
              </strong>
              <span className="text-[11px] text-slate-400 mt-1 block">
                Tidak mengirim lokasi &gt; 3 menit
              </span>
            </div>
            <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400">
              <HelpCircle className="w-6 h-6" />
            </div>
          </div>
        </section>

        {/* ===================================================================
            MODAL / PANEL KALIBRASI KOORDINAT POS (SUBBAB 2.2.B)
        =================================================================== */}
        {isCalibrating && (
          <section className="rounded-xl bg-slate-900 border-2 border-amber-500/60 p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
                  Subbab 2.2.B &bull; Kalibrasi Lapangan Sebelum Acara
                </span>
                <h2 className="text-sm font-bold text-white">
                  Kalibrasi Koordinat Titik Pos (`Checkpoints`) — Klik pada Peta atau Ambil GPS Saat Ini
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsCalibrating(false)}
                className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={handleSaveCalibration}
              className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end"
            >
              <div className="md:col-span-4">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Pilih Titik Pos Tugas
                </label>
                <select
                  value={calibCheckpointId}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setCalibCheckpointId(id);
                    const found = checkpoints.find((cp) => cp.id === id);
                    if (found) {
                      setCalibLat(String(found.latitude));
                      setCalibLng(String(found.longitude));
                    }
                  }}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white"
                >
                  {checkpoints.map((cp) => (
                    <option key={cp.id} value={cp.id}>
                      {cp.nama_pos} (Check-In {cp.radius_checkin}m / Pantau {cp.radius_monitoring}m)
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Latitude
                </label>
                <input
                  type="number"
                  step="any"
                  value={calibLat}
                  onChange={(e) => setCalibLat(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-mono text-white"
                  required
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Longitude
                </label>
                <input
                  type="number"
                  step="any"
                  value={calibLng}
                  onChange={(e) => setCalibLng(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-mono text-white"
                  required
                />
              </div>

              <div className="md:col-span-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUseCurrentGpsForCalibration}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
                >
                  <Navigation className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Ambil GPS Saat Ini</span>
                </button>

                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-extrabold flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Simpan Koordinat</span>
                </button>
              </div>
            </form>

            {calibFeedback && (
              <p className="mt-2 text-xs text-emerald-300 font-medium">{calibFeedback}</p>
            )}
          </section>
        )}

        {/* ===================================================================
            2 & 3. BARIS TENGAH: PETA PEMANTAUAN LINTASAN 7,2 KM (KIRI) &
                   NOTIFIKASI INSIDEN REAL-TIME (KANAN)
        =================================================================== */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* PANEL TENGAH KIRI: PETA PEMANTAUAN LINTASAN 7,2 KM (UC-07) */}
          <div className="lg:col-span-7 rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                  UC-07 &bull; OpenStreetMap &amp; Geofencing
                </span>
                <h2 className="text-base font-bold text-white">
                  Peta Pemantauan Lintasan 7,2 km — UNAI Fun Run
                </h2>
              </div>

              {/* Legenda Status Visual Peta */}
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-300">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> Active
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" /> Mobile
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" /> Out of Area
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-400 inline-block" /> Unknown
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> SOS Insiden
                </span>
              </div>
            </div>

            <div className="h-[460px] w-full rounded-xl overflow-hidden border border-slate-800 relative z-0">
              <MapContainer
                center={dynamicMapCenter}
                zoom={15}
                style={{ height: '100%', width: '100%' }}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                <MapCameraBoundsController
                  checkpoints={checkpoints}
                  isCalibrating={isCalibrating}
                />

                <CalibrationMapClickHandler
                  enabled={isCalibrating}
                  onPickCoords={(lat, lng) => {
                    setCalibLat(String(lat));
                    setCalibLng(String(lng));
                    setCalibFeedback(
                      `Titik peta dipilih: (${lat}, ${lng}). Klik "Simpan Koordinat" untuk memperbarui pos.`
                    );
                  }}
                />

                {/* Garis Rute 7,2 km UNAI Fun Run Dinamis Mengikuti Titik Checkpoints Terbaru */}
                {dynamicRoutePositions.length > 1 && (
                  <Polyline
                    positions={dynamicRoutePositions}
                    pathOptions={{
                      color: '#6366f1',
                      weight: 4,
                      opacity: 0.85,
                      dashArray: '8, 6',
                    }}
                  />
                )}

                {/* Render 8 Titik Checkpoints (3 Pos Utama & 5 Simpang Marshal) + 2 Lingkaran Konsentris */}
                {checkpoints.map((cp) => {
                  const isMainPost = cp.radius_checkin === 50;
                  const shortLabel = cp.nama_pos.split(' (')[0];
                  return (
                    <React.Fragment key={cp.id}>
                      {/* Lingkaran Luar: radius_monitoring (100m Pos Utama / 50m Marshal) */}
                      <Circle
                        center={[Number(cp.latitude), Number(cp.longitude)]}
                        radius={Number(cp.radius_monitoring)}
                        pathOptions={{
                          color: isMainPost ? '#10b981' : '#3b82f6',
                          fillColor: isMainPost ? '#10b981' : '#3b82f6',
                          fillOpacity: 0.08,
                          weight: 1.5,
                          dashArray: '4, 4',
                        }}
                      />
                      {/* Lingkaran Dalam: radius_checkin (50m Pos Utama / 30m Marshal) */}
                      <Circle
                        center={[Number(cp.latitude), Number(cp.longitude)]}
                        radius={Number(cp.radius_checkin)}
                        pathOptions={{
                          color: isMainPost ? '#059669' : '#2563eb',
                          fillColor: isMainPost ? '#059669' : '#2563eb',
                          fillOpacity: 0.18,
                          weight: 2,
                        }}
                      />
                      <Marker
                        position={[Number(cp.latitude), Number(cp.longitude)]}
                        icon={createCheckpointIcon(isMainPost, shortLabel)}
                      >
                        <Popup>
                          <div className="text-xs space-y-1">
                            <strong className="block text-sm">{cp.nama_pos}</strong>
                            <div>Kilometer: KM {cp.kilometer}</div>
                            <div>
                              Radius Check-In: <strong>&le; {cp.radius_checkin} m</strong>
                            </div>
                            <div>
                              Radius Monitoring: <strong>&le; {cp.radius_monitoring} m</strong>
                            </div>
                            <div className="font-mono text-[10px] text-slate-500">
                              {Number(cp.latitude).toFixed(6)}, {Number(cp.longitude).toFixed(6)}
                            </div>
                          </div>
                        </Popup>
                      </Marker>
                    </React.Fragment>
                  );
                })}

                {/* Render Posisi Seluruh Relawan Secara Real-Time */}
                {volunteers
                  .filter((v) => v.current_lat !== null && v.current_lng !== null)
                  .map((v) => (
                    <Marker
                      key={v.id}
                      position={[Number(v.current_lat), Number(v.current_lng)]}
                      icon={createVolunteerIcon(v.status_lokasi, v.nama_relawan)}
                    >
                      <Popup>
                        <div className="text-xs space-y-1">
                          <strong className="block text-sm">{v.nama_relawan}</strong>
                          <div>Peran: {v.role}</div>
                          <div>Pos Tugas: {v.nama_pos || 'Mobile (Bergerak)'}</div>
                          <div>
                            Status Lokasi: <strong>{v.status_lokasi}</strong>
                          </div>
                          {v.last_seen_at && (
                            <div>
                              Terakhir Terlihat:{' '}
                              {new Date(v.last_seen_at).toLocaleTimeString('id-ID')}
                            </div>
                          )}
                        </div>
                      </Popup>
                    </Marker>
                  ))}

                {/* Render Pin Peringatan Merah untuk Titik Insiden Aktif */}
                {incidents
                  .filter((inc) => inc.status_insiden !== 'Resolved')
                  .map((inc) => (
                    <Marker
                      key={inc.id}
                      position={[Number(inc.incident_lat), Number(inc.incident_lng)]}
                      icon={createIncidentIcon(escalatedIncidentIds.has(inc.id))}
                      eventHandlers={{
                        click: () => setSelectedIncidentId(inc.id),
                      }}
                    >
                      <Popup>
                        <div className="text-xs space-y-1">
                          <strong className="text-red-600 block">
                            INSIDEN #{inc.id}: {inc.kategori_insiden}
                          </strong>
                          <div>
                            Jarak Pos Terdekat: &plusmn;
                            {Number(inc.jarak_pos_meter).toFixed(0)} m dari{' '}
                            {inc.nama_pos_terdekat}
                          </div>
                          <div>Pelapor: {inc.nama_pelapor}</div>
                          <div>Status: {inc.status_insiden}</div>
                        </div>
                      </Popup>
                    </Marker>
                  ))}
              </MapContainer>
            </div>

            {/* Daftar Ringkas Relawan di Bawah Peta */}
            <div className="mt-3 pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <span>
                Lingkaran Dalam = Radius Check-In (50m Pos / 30m Marshal) &bull; Lingkaran Putus-putus = Radius Monitoring (100m Pos / 50m Marshal)
              </span>
              <span className="font-mono text-[11px] text-slate-300">
                Relawan Terpantau: {volunteers.length} personel
              </span>
            </div>
          </div>

          {/* PANEL TENGAH KANAN: NOTIFIKASI INSIDEN REAL-TIME (UC-08) */}
          <div className="lg:col-span-5 rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-800">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-red-400">
                  UC-08 &bull; Eskalasi Otomatis &gt; 120 Detik
                </span>
                <h2 className="text-base font-bold text-white">
                  Notifikasi Insiden Real-Time
                </h2>
              </div>

              {/* Pilihan Petugas Penangani Saat Koordinator Mengunci Status Handled */}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-slate-400">Penangani:</span>
                <select
                  value={selectedHandlerId}
                  onChange={(e) =>
                    setSelectedHandlerId(e.target.value ? Number(e.target.value) : '')
                  }
                  className="rounded bg-slate-950 border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                >
                  <option value="">Otomatis (Medis / Pelapor)</option>
                  {volunteers.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.nama_relawan} ({v.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {actionFeedback && (
              <div className="mb-3 rounded-lg bg-indigo-950/60 border border-indigo-500/50 px-3 py-2 text-xs text-indigo-200">
                {actionFeedback}
              </div>
            )}

            {sortedNotifications.length === 0 ? (
              <div className="flex-1 flex items-center justify-center rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-400">
                Belum ada laporan insiden yang masuk. Notifikasi SOS akan tampil secara instan tanpa refresh halaman.
              </div>
            ) : (
              <div className="space-y-3 max-h-[450px] overflow-y-auto pr-1">
                {sortedNotifications.map((inc) => {
                  const isEscalated = escalatedIncidentIds.has(inc.id);
                  const elapsedSec = Math.max(
                    0,
                    Math.floor((nowMs - new Date(inc.created_at).getTime()) / 1000)
                  );
                  const isSelected = selectedIncident?.id === inc.id;

                  return (
                    <div
                      key={inc.id}
                      onClick={() => setSelectedIncidentId(inc.id)}
                      className={`rounded-xl border p-3.5 text-xs transition cursor-pointer ${
                        isEscalated
                          ? 'bg-red-950/90 border-2 border-red-500 animate-pulse shadow-lg shadow-red-950/80'
                          : inc.status_insiden === 'New'
                          ? 'bg-red-950/35 border-red-500/60'
                          : inc.status_insiden === 'Handled'
                          ? 'bg-amber-950/30 border-amber-500/50'
                          : 'bg-slate-950/70 border-slate-800'
                      } ${isSelected ? 'ring-2 ring-indigo-500' : ''}`}
                    >
                      {/* Baris Atas Kartu: Badge Status, Eskalasi, & Jam Lapor */}
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded font-extrabold text-[10px] uppercase ${
                              inc.status_insiden === 'New'
                                ? 'bg-red-600 text-white'
                                : inc.status_insiden === 'Handled'
                                ? 'bg-amber-400 text-slate-950'
                                : 'bg-emerald-600 text-white'
                            }`}
                          >
                            {inc.status_insiden.toUpperCase()}
                          </span>
                          <span className="font-mono font-bold text-white">#{inc.id}</span>
                          <span className="font-bold text-sm text-white">
                            {inc.kategori_insiden}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 font-mono text-[11px] text-slate-300">
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          <span>{new Date(inc.created_at).toLocaleTimeString('id-ID')}</span>
                        </div>
                      </div>

                      {/* Peringatan Eskalasi Otomatis (> 120 Detik) */}
                      {isEscalated && (
                        <div className="mb-2 rounded bg-red-600 text-white px-2.5 py-1 font-extrabold text-[11px] flex items-center justify-between">
                          <span>
                            PERINGATAN ESKALASI OTOMATIS (&gt; 120 DETIK BELUM DITANGANI!)
                          </span>
                          <span className="font-mono">{formatDurationSeconds(elapsedSec)}</span>
                        </div>
                      )}

                      {inc.status_insiden === 'New' && !isEscalated && (
                        <div className="mb-1.5 text-[11px] text-red-300 font-mono">
                          Waktu tunggu respons: {elapsedSec} detik (Batas eskalasi: 120 detik)
                        </div>
                      )}

                      {/* Patokan Jarak Pos Terdekat */}
                      <div className="text-emerald-300 font-semibold mb-1 flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          Jarak Pos Terdekat: &plusmn;{Number(inc.jarak_pos_meter).toFixed(0)} m dari{' '}
                          {inc.nama_pos_terdekat || `Pos #${inc.id_checkpoint_terdekat}`}
                        </span>
                      </div>

                      {inc.catatan && (
                        <p className="text-slate-300 italic mb-1.5">Catatan: "{inc.catatan}"</p>
                      )}

                      {/* Informasi Pelapor & Penguncian Petugas Penangani */}
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 mb-3">
                        <span>
                          Pelapor:{' '}
                          <strong className="text-slate-200">
                            {inc.nama_pelapor || `Relawan #${inc.id_pelapor}`}
                          </strong>
                        </span>
                        <span>
                          Penangani:{' '}
                          {inc.nama_penangani ? (
                            <strong className="text-amber-300 inline-flex items-center gap-1">
                              <Lock className="w-3 h-3" />
                              {inc.nama_penangani}
                            </strong>
                          ) : (
                            <span className="text-slate-500">Belum dikunci</span>
                          )}
                        </span>
                      </div>

                      {/* Tombol Aksi: Tangani (Set Handled) & Selesai (Set Resolved) */}
                      <div className="flex items-center gap-2 pt-2 border-t border-white/10">
                        <button
                          type="button"
                          disabled={inc.status_insiden !== 'New'}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleIncidentStatusUpdate(inc, 'Handled');
                          }}
                          className={`flex-1 py-1.5 px-3 rounded-lg font-bold text-xs transition ${
                            inc.status_insiden === 'New'
                              ? 'bg-amber-400 hover:bg-amber-300 text-slate-950'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          Tangani (Set Handled)
                        </button>

                        <button
                          type="button"
                          disabled={inc.status_insiden === 'Resolved'}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleIncidentStatusUpdate(inc, 'Resolved');
                          }}
                          className={`flex-1 py-1.5 px-3 rounded-lg font-bold text-xs transition ${
                            inc.status_insiden !== 'Resolved'
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          Selesai (Set Resolved)
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* ===================================================================
            4. BAGIAN BAWAH: DASHBOARD MONITORING INSIDEN - UNAI FUN RUN (UC-09)
        =================================================================== */}
        <section className="rounded-xl bg-slate-900 border border-slate-800 p-5 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400">
                UC-09 &bull; Evaluasi Pasca-Acara &amp; Pelacak Waktu 3 Fase
              </span>
              <h2 className="text-lg font-extrabold text-white">
                Dashboard Monitoring Insiden — UNAI Fun Run
              </h2>
            </div>
            <Activity className="w-5 h-5 text-indigo-400" />
          </div>

          {/* SUB-SEKSI A: DETAIL PENANGANAN INSIDEN & PELACAK WAKTU 3 FASE */}
          <div className="rounded-xl bg-slate-950 border border-slate-800 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3">
              Detail Penanganan Insiden &amp; Pelacak Waktu 3 Fase
            </h3>

            {selectedIncident ? (
              <>
                {/* 4 Kotak Informasi: ID Insiden, Kategori, Pelapor, Jarak Pos */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                  <div className="rounded-lg bg-slate-900 border border-slate-800 p-3">
                    <span className="text-[11px] text-slate-400 block">ID Insiden</span>
                    <strong className="text-base font-mono text-white">
                      #{selectedIncident.id}
                    </strong>
                  </div>
                  <div className="rounded-lg bg-slate-900 border border-slate-800 p-3">
                    <span className="text-[11px] text-slate-400 block">Kategori</span>
                    <strong className="text-base text-red-300">
                      {selectedIncident.kategori_insiden}
                    </strong>
                  </div>
                  <div className="rounded-lg bg-slate-900 border border-slate-800 p-3">
                    <span className="text-[11px] text-slate-400 block">Pelapor</span>
                    <strong className="text-sm text-white block">
                      {selectedIncident.nama_pelapor || `Relawan #${selectedIncident.id_pelapor}`}
                    </strong>
                    {selectedIncident.nama_penangani && (
                      <span className="text-[11px] text-amber-300">
                        Ditangani: {selectedIncident.nama_penangani}
                      </span>
                    )}
                  </div>
                  <div className="rounded-lg bg-slate-900 border border-slate-800 p-3">
                    <span className="text-[11px] text-slate-400 block">Jarak Pos</span>
                    <strong className="text-sm text-emerald-300">
                      &plusmn;{Number(selectedIncident.jarak_pos_meter).toFixed(0)} m dari{' '}
                      {selectedIncident.nama_pos_terdekat}
                    </strong>
                  </div>
                </div>

                {/* Bagan Alur Lini Masa Horizontal 3 Titik: NEW -> HANDLED -> RESOLVED */}
                <div className="grid grid-cols-1 md:grid-cols-5 items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl p-4">
                  {/* Titik 1: STATUS: NEW (created_at) */}
                  <div className="rounded-xl border border-red-500/60 bg-red-950/30 p-3 text-center">
                    <span className="inline-block px-2 py-0.5 rounded bg-red-600 text-white text-[10px] font-extrabold mb-1">
                      FASE 1
                    </span>
                    <div className="font-bold text-xs text-white">
                      STATUS: NEW (created_at)
                    </div>
                    <div className="font-mono text-xs text-red-300 mt-1">
                      {new Date(selectedIncident.created_at).toLocaleTimeString('id-ID')}
                    </div>
                  </div>

                  <div className="hidden md:flex flex-col items-center justify-center text-slate-400 text-[11px]">
                    <ArrowRight className="w-5 h-5 text-amber-400" />
                    <span className="font-mono mt-0.5">
                      {selectedIncident.handled_at
                        ? formatDurationSeconds(
                            (new Date(selectedIncident.handled_at).getTime() -
                              new Date(selectedIncident.created_at).getTime()) /
                              1000
                          )
                        : 'Menunggu...'}
                    </span>
                  </div>

                  {/* Titik 2: STATUS: HANDLED (handled_at) */}
                  <div
                    className={`rounded-xl border p-3 text-center ${
                      selectedIncident.handled_at
                        ? 'border-amber-500/60 bg-amber-950/30'
                        : 'border-slate-800 bg-slate-900/40 opacity-60'
                    }`}
                  >
                    <span className="inline-block px-2 py-0.5 rounded bg-amber-400 text-slate-950 text-[10px] font-extrabold mb-1">
                      FASE 2
                    </span>
                    <div className="font-bold text-xs text-white">
                      STATUS: HANDLED (handled_at)
                    </div>
                    <div className="font-mono text-xs text-amber-300 mt-1">
                      {selectedIncident.handled_at
                        ? new Date(selectedIncident.handled_at).toLocaleTimeString('id-ID')
                        : 'Belum Ditangani'}
                    </div>
                  </div>

                  <div className="hidden md:flex flex-col items-center justify-center text-slate-400 text-[11px]">
                    <ArrowRight className="w-5 h-5 text-emerald-400" />
                    <span className="font-mono mt-0.5">
                      {selectedIncident.resolved_at
                        ? formatDurationSeconds(
                            (new Date(selectedIncident.resolved_at).getTime() -
                              new Date(selectedIncident.created_at).getTime()) /
                              1000
                          )
                        : 'Menunggu...'}
                    </span>
                  </div>

                  {/* Titik 3: STATUS: RESOLVED (resolved_at) */}
                  <div
                    className={`rounded-xl border p-3 text-center ${
                      selectedIncident.resolved_at
                        ? 'border-emerald-500/60 bg-emerald-950/30'
                        : 'border-slate-800 bg-slate-900/40 opacity-60'
                    }`}
                  >
                    <span className="inline-block px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-extrabold mb-1">
                      FASE 3
                    </span>
                    <div className="font-bold text-xs text-white">
                      STATUS: RESOLVED (resolved_at)
                    </div>
                    <div className="font-mono text-xs text-emerald-300 mt-1">
                      {selectedIncident.resolved_at
                        ? new Date(selectedIncident.resolved_at).toLocaleTimeString('id-ID')
                        : 'Belum Selesai'}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-400">
                Pilih salah satu baris insiden untuk meninjau detail pelacak waktu 3 fase.
              </p>
            )}
          </div>

          {/* SUB-SEKSI B: TABEL REKAPITULASI WAKTU RESPONS INSIDEN (8 KOLOM PERSIS) */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3">
              Rekapitulasi Waktu Respons Insiden
            </h3>

            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-950 text-slate-300 border-b border-slate-800">
                    <th className="py-3 px-3.5 font-bold">ID</th>
                    <th className="py-3 px-3.5 font-bold">Kategori</th>
                    <th className="py-3 px-3.5 font-bold">Pelapor &amp; Jarak Pos</th>
                    <th className="py-3 px-3.5 font-bold">Waktu Lapor (created_at)</th>
                    <th className="py-3 px-3.5 font-bold">Waktu Tanggap (handled_at)</th>
                    <th className="py-3 px-3.5 font-bold">Waktu Selesai (resolved_at)</th>
                    <th className="py-3 px-3.5 font-bold">Durasi Respons</th>
                    <th className="py-3 px-3.5 font-bold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {incidents.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-slate-500">
                        Belum ada data insiden terekam.
                      </td>
                    </tr>
                  ) : (
                    incidents.map((inc) => {
                      const createdMs = new Date(inc.created_at).getTime();
                      const handledSec = inc.handled_at
                        ? (new Date(inc.handled_at).getTime() - createdMs) / 1000
                        : null;
                      const resolvedSec = inc.resolved_at
                        ? (new Date(inc.resolved_at).getTime() - createdMs) / 1000
                        : null;

                      return (
                        <tr
                          key={inc.id}
                          onClick={() => setSelectedIncidentId(inc.id)}
                          className={`hover:bg-slate-800/60 cursor-pointer transition ${
                            selectedIncident?.id === inc.id ? 'bg-indigo-950/30' : ''
                          }`}
                        >
                          {/* Kolom 1: ID */}
                          <td className="py-3 px-3.5 font-mono font-bold text-white">
                            #{inc.id}
                          </td>

                          {/* Kolom 2: Kategori */}
                          <td className="py-3 px-3.5 font-semibold text-white">
                            {inc.kategori_insiden}
                          </td>

                          {/* Kolom 3: Pelapor & Jarak Pos */}
                          <td className="py-3 px-3.5">
                            <div className="text-slate-200 font-medium">
                              {inc.nama_pelapor || `Relawan #${inc.id_pelapor}`}
                            </div>
                            <div className="text-[11px] text-emerald-400">
                              &plusmn;{Number(inc.jarak_pos_meter).toFixed(0)} m dari{' '}
                              {inc.nama_pos_terdekat}
                            </div>
                          </td>

                          {/* Kolom 4: Waktu Lapor (created_at) */}
                          <td className="py-3 px-3.5 font-mono text-slate-300">
                            {new Date(inc.created_at).toLocaleTimeString('id-ID')}
                          </td>

                          {/* Kolom 5: Waktu Tanggap (handled_at) */}
                          <td className="py-3 px-3.5 font-mono text-amber-300">
                            {inc.handled_at
                              ? new Date(inc.handled_at).toLocaleTimeString('id-ID')
                              : '-'}
                          </td>

                          {/* Kolom 6: Waktu Selesai (resolved_at) */}
                          <td className="py-3 px-3.5 font-mono text-emerald-300">
                            {inc.resolved_at
                              ? new Date(inc.resolved_at).toLocaleTimeString('id-ID')
                              : '-'}
                          </td>

                          {/* Kolom 7: Durasi Respons (Tanggap & Selesai dalam menit & detik) */}
                          <td className="py-3 px-3.5 font-mono text-[11px]">
                            <div>
                              <span className="text-slate-400">Tanggap: </span>
                              <strong className="text-amber-300">
                                {formatDurationSeconds(handledSec)}
                              </strong>
                            </div>
                            <div>
                              <span className="text-slate-400">Selesai: </span>
                              <strong className="text-emerald-300">
                                {formatDurationSeconds(resolvedSec)}
                              </strong>
                            </div>
                          </td>

                          {/* Kolom 8: Status */}
                          <td className="py-3 px-3.5">
                            <span
                              className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase ${
                                inc.status_insiden === 'New'
                                  ? 'bg-red-600 text-white'
                                  : inc.status_insiden === 'Handled'
                                  ? 'bg-amber-400 text-slate-950'
                                  : 'bg-emerald-600 text-white'
                              }`}
                            >
                              {inc.status_insiden}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

