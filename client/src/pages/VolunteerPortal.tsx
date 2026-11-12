import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  MapPin,
  ShieldAlert,
  Radio,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Navigation,
  Moon,
  Sun,
  Eye,
  Smartphone,
  Activity,
  Send,
  RefreshCw,
  UserCheck,
  Lock,
} from 'lucide-react';
import {
  Checkpoint,
  EventData,
  Incident,
  IncidentCategory,
  Volunteer,
  VolunteerRole,
} from '../types';
import { calculateHaversineDistance } from '../utils/haversine';
import { socket, API_BASE_URL } from '../socket';

// Konfigurasi ikon standar Leaflet agar tampil sempurna di Vite
const incidentPinIcon = new L.DivIcon({
  className: 'custom-incident-pin',
  html: `<div style="background-color:#ef4444;width:24px;height:24px;border-radius:9999px;border:3px solid #ffffff;box-shadow:0 0 10px rgba(239,68,68,0.9);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px;">!</div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

const checkpointPinIcon = new L.DivIcon({
  className: 'custom-cp-pin',
  html: `<div style="background-color:#10b981;width:20px;height:20px;border-radius:9999px;border:2px solid #ffffff;box-shadow:0 0 6px rgba(16,185,129,0.8);"></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

function MiniMapBoundsUpdater({ checkpoints }: { checkpoints: Checkpoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (!checkpoints || checkpoints.length === 0) return;
    const bounds = L.latLngBounds(
      checkpoints.map((cp) => [Number(cp.latitude), Number(cp.longitude)] as [number, number])
    );
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
    }
  }, [checkpoints, map]);
  return null;
}

const ALL_ROLES: VolunteerRole[] = [
  'Water Station',
  'Medis Pos',
  'Marshal',
  'Pacer',
  'Tim Medis Mobile',
];

const INCIDENT_CATEGORIES: IncidentCategory[] = [
  'Kram Otot / Spray',
  'Pelari Kolaps',
  'Peserta Tersesat',
  'Stok Air Menipis',
];

export default function VolunteerPortal() {
  // Data Inisialisasi dari Server
  const [eventData, setEventData] = useState<EventData | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);

  // Form Self-Onboarding & Check-In (Panel Kiri - UC-01, UC-02, UC-03)
  const [namaRelawan, setNamaRelawan] = useState<string>('');
  const [selectedRole, setSelectedRole] = useState<VolunteerRole>('Water Station');
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<number | ''>('');
  const [pinAcara, setPinAcara] = useState<string>('202601');
  const [isCheckingIn, setIsCheckingIn] = useState<boolean>(false);

  // State Hasil Check-In & Alert Detail Haversine + Accuracy
  const [checkinFeedback, setCheckinFeedback] = useState<{
    type: 'success' | 'error';
    title: string;
    message: string;
    distanceMeters?: number | null;
    accuracyMeters?: number | null;
  } | null>(null);

  // State Relawan Aktif (Setelah Check-In)
  const [activeVolunteer, setActiveVolunteer] = useState<Volunteer | null>(() => {
    const saved = sessionStorage.getItem('unai_active_volunteer');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return null;
      }
    }
    return null;
  });

  // Informasi Sensor & Periodic Polling (UC-04)
  const [currentDistanceMeters, setCurrentDistanceMeters] = useState<number | null>(null);
  const [currentAccuracyMeters, setCurrentAccuracyMeters] = useState<number | null>(null);
  const [lastPollTime, setLastPollTime] = useState<string | null>(null);
  const [pollCountdown, setPollCountdown] = useState<number>(60);
  const [pollNotice, setPollNotice] = useState<string | null>(null);

  // Browser APIs: Screen Wake Lock API & Low-Power Dark Display + Page Visibility API
  const [lowPowerMode, setLowPowerMode] = useState<boolean>(true);
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [visibilityStatus, setVisibilityStatus] = useState<string>(
    typeof document !== 'undefined' ? document.visibilityState : 'visible'
  );
  const wakeLockSentinelRef = useRef<any>(null);

  // Mode Simulasi Uji Sensor GPS (Opsional untuk pengujian di PC / skenario skripsi)
  const [gpsSimulationMode, setGpsSimulationMode] = useState<
    'real' | 'inside_post' | 'outside_post' | 'poor_accuracy'
  >('real');

  // State Pelaporan Insiden SOS (Panel Kanan - UC-05)
  const [selectedCategory, setSelectedCategory] = useState<IncidentCategory>('Kram Otot / Spray');
  const [catatanInsiden, setCatatanInsiden] = useState<string>('');
  const [isSendingSos, setIsSendingSos] = useState<boolean>(false);
  const [myLatestIncidentId, setMyLatestIncidentId] = useState<number | null>(null);
  const [statusFeedbackMsg, setStatusFeedbackMsg] = useState<string | null>(null);

  // Pilihan insiden yang sedang dilihat di Peta Mini (UC-06)
  const [focusedIncidentId, setFocusedIncidentId] = useState<number | null>(null);

  // Filter otomatis Dropdown Titik Pos Tugas sesuai Kategori Peran (Langkah 3 Poin 1)
  const filteredCheckpoints = useMemo(() => {
    if (selectedRole === 'Water Station' || selectedRole === 'Medis Pos') {
      // Hanya Pos Utama (Pos 1, Pos 2, Pos 3 / radius_checkin === 50)
      return checkpoints.filter(
        (cp) => cp.radius_checkin === 50 || cp.nama_pos.toLowerCase().startsWith('pos')
      );
    }
    if (selectedRole === 'Marshal') {
      // Hanya titik Simpang Marshal (radius_checkin === 30)
      return checkpoints.filter(
        (cp) => cp.radius_checkin === 30 || cp.nama_pos.toLowerCase().includes('marshal')
      );
    }
    // Pacer dan Tim Medis Mobile -> nonaktif (disabled)
    return [];
  }, [checkpoints, selectedRole]);

  const isMobileRoleSelected =
    selectedRole === 'Pacer' || selectedRole === 'Tim Medis Mobile';

  // Otomatis sesuaikan pilihan default pos saat berganti peran
  useEffect(() => {
    if (isMobileRoleSelected) {
      setSelectedCheckpointId('');
    } else if (filteredCheckpoints.length > 0) {
      const exists = filteredCheckpoints.some((cp) => cp.id === Number(selectedCheckpointId));
      if (!exists) {
        setSelectedCheckpointId(filteredCheckpoints[0].id);
      }
    }
  }, [selectedRole, filteredCheckpoints, isMobileRoleSelected, selectedCheckpointId]);

  // Ambil data awal dari /api/init
  const fetchInitData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/init`);
      const data = await res.json();
      if (data.success) {
        setEventData(data.event);
        setCheckpoints(data.checkpoints || []);
        setIncidents(data.incidents || []);
        if (data.incidents && data.incidents.length > 0 && !focusedIncidentId) {
          setFocusedIncidentId(data.incidents[0].id);
        }
        // Sinkronkan status relawan yang sedang login jika ada
        if (activeVolunteer) {
          const found = (data.volunteers || []).find(
            (v: Volunteer) => v.id === activeVolunteer.id
          );
          if (found) {
            setActiveVolunteer(found);
            sessionStorage.setItem('unai_active_volunteer', JSON.stringify(found));
          }
        }
      }
    } catch (err) {
      console.error('[VolunteerPortal] Gagal memuat /api/init:', err);
    }
  }, [activeVolunteer, focusedIncidentId]);

  useEffect(() => {
    fetchInitData();
  }, []);

  // Fungsi Akuisisi Screen Wake Lock API (Subbab 2.1)
  const requestScreenWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator && (navigator as any).wakeLock) {
        if (wakeLockSentinelRef.current) {
          try {
            await wakeLockSentinelRef.current.release();
          } catch {
            // ignore
          }
        }
        const sentinel = await (navigator as any).wakeLock.request('screen');
        wakeLockSentinelRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener('release', () => {
          setWakeLockActive(false);
        });
      }
    } catch (err) {
      console.warn('[WakeLock API] Tidak dapat mengunci layar:', (err as Error).message);
      setWakeLockActive(false);
    }
  }, []);

  // Helper pembungkus navigator.geolocation.getCurrentPosition(..., { enableHighAccuracy: true })
  const acquireGpsCoordinates = useCallback(
    (targetCheckpoint?: Checkpoint | null): Promise<{
      latitude: number;
      longitude: number;
      accuracy: number;
    }> => {
      return new Promise((resolve, reject) => {
        // Selalu panggil Web Geolocation API sesuai spesifikasi
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              // Jika mode pengujian simulasi dipilih oleh penguji di PC, terapkan koordinat uji
              if (gpsSimulationMode !== 'real' && targetCheckpoint) {
                if (gpsSimulationMode === 'inside_post') {
                  return resolve({
                    latitude: Number(targetCheckpoint.latitude) + 0.00008, // ~9 meter dari pos
                    longitude: Number(targetCheckpoint.longitude) + 0.00005,
                    accuracy: 12.5,
                  });
                }
                if (gpsSimulationMode === 'outside_post') {
                  return resolve({
                    latitude: Number(targetCheckpoint.latitude) + 0.0014, // ~155 meter dari pos
                    longitude: Number(targetCheckpoint.longitude) + 0.001,
                    accuracy: 15.0,
                  });
                }
                if (gpsSimulationMode === 'poor_accuracy') {
                  return resolve({
                    latitude: Number(targetCheckpoint.latitude),
                    longitude: Number(targetCheckpoint.longitude),
                    accuracy: 78.4, // > 50 meter (ditolak / diabaikan)
                  });
                }
              }

              resolve({
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
              });
            },
            (geoError) => {
              // Jika dijalankan pada PC tanpa sensor GPS atau izin ditolak saat mode simulasi aktif
              if (gpsSimulationMode !== 'real') {
                const refLat = targetCheckpoint ? Number(targetCheckpoint.latitude) : -6.817893;
                const refLng = targetCheckpoint ? Number(targetCheckpoint.longitude) : 107.587672;
                if (gpsSimulationMode === 'inside_post') {
                  return resolve({
                    latitude: refLat + 0.00008,
                    longitude: refLng + 0.00005,
                    accuracy: 12.5,
                  });
                }
                if (gpsSimulationMode === 'outside_post') {
                  return resolve({
                    latitude: refLat + 0.0014,
                    longitude: refLng + 0.001,
                    accuracy: 15.0,
                  });
                }
                if (gpsSimulationMode === 'poor_accuracy') {
                  return resolve({
                    latitude: refLat,
                    longitude: refLng,
                    accuracy: 78.4,
                  });
                }
              }
              reject(
                new Error(
                  `Gagal membaca Web Geolocation API (${geoError.message}). Pastikan izin lokasi aktif atau gunakan Mode Simulasi Koordinat Pos untuk pengujian di PC.`
                )
              );
            },
            {
              enableHighAccuracy: true,
              timeout: 12000,
              maximumAge: 0,
            }
          );
        } else {
          reject(new Error('Peramban ini tidak mendukung Web Geolocation API.'));
        }
      });
    },
    [gpsSimulationMode]
  );

  // Fungsi Pengiriman Lokasi Berkala (UC-04: Periodic Polling tiap 60 detik)
  const executePeriodicPoll = useCallback(
    async (volunteerToPoll?: Volunteer | null) => {
      const vol = volunteerToPoll || activeVolunteer;
      if (!vol) return;

      const assignedCp = checkpoints.find((c) => c.id === vol.id_checkpoint) || null;

      try {
        const coords = await acquireGpsCoordinates(assignedCp);
        setCurrentAccuracyMeters(Number(coords.accuracy.toFixed(1)));

        if (assignedCp) {
          const dist = calculateHaversineDistance(
            coords.latitude,
            coords.longitude,
            Number(assignedCp.latitude),
            Number(assignedCp.longitude)
          );
          setCurrentDistanceMeters(Number(dist.toFixed(1)));
        }

        const res = await fetch(`${API_BASE_URL}/api/volunteers/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id_volunteer: vol.id,
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy_meter: coords.accuracy,
          }),
        });

        const data = await res.json();
        if (data.success && data.volunteer) {
          setActiveVolunteer(data.volunteer);
          sessionStorage.setItem('unai_active_volunteer', JSON.stringify(data.volunteer));
          if (data.jarak_ke_pos_meter !== null && data.jarak_ke_pos_meter !== undefined) {
            setCurrentDistanceMeters(Number(data.jarak_ke_pos_meter));
          }
          setLastPollTime(new Date().toLocaleTimeString('id-ID'));
          setPollCountdown(60);
          setPollNotice(data.message || null);
        }
      } catch (err) {
        console.warn('[Periodic Poll 60s] Gagal mengambil lokasi:', (err as Error).message);
        setPollNotice(`Peringatan Polling: ${(err as Error).message}`);
      }
    },
    [activeVolunteer, checkpoints, acquireGpsCoordinates]
  );

  // Timer Interval 60 Detik untuk Periodic Polling (UC-04)
  useEffect(() => {
    if (!activeVolunteer) return;

    // Aktifkan Screen Wake Lock API secara otomatis saat relawan telah Check-In
    requestScreenWakeLock();

    const countdownTimer = setInterval(() => {
      setPollCountdown((prev) => {
        if (prev <= 1) {
          executePeriodicPoll(activeVolunteer);
          return 60;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdownTimer);
  }, [activeVolunteer, executePeriodicPoll, requestScreenWakeLock]);

  // Integrasi Page Visibility API (Subbab 2.1):
  // Saat layar ponsel kembali aktif (visibilityState === 'visible'), langsung picu pengiriman lokasi berkala
  // dan aktifkan kembali Screen Wake Lock API.
  useEffect(() => {
    const handleVisibilityChange = () => {
      setVisibilityStatus(document.visibilityState);
      if (document.visibilityState === 'visible' && activeVolunteer) {
        requestScreenWakeLock();
        executePeriodicPoll(activeVolunteer);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeVolunteer, executePeriodicPoll, requestScreenWakeLock]);

  // Listener Real-Time Socket.IO (Langkah 3 Poin 2: new_incident, status_updated, volunteer_updated)
  useEffect(() => {
    const onVolunteerUpdated = (updatedVol: Volunteer) => {
      if (activeVolunteer && updatedVol.id === activeVolunteer.id) {
        setActiveVolunteer(updatedVol);
        sessionStorage.setItem('unai_active_volunteer', JSON.stringify(updatedVol));
      }
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
      setFocusedIncidentId((prev) => prev ?? newInc.id);
    };

    const onStatusUpdated = (updatedInc: Incident) => {
      setIncidents((prev) =>
        prev.map((inc) => (inc.id === updatedInc.id ? updatedInc : inc))
      );
      if (
        (activeVolunteer && updatedInc.id_pelapor === activeVolunteer.id) ||
        updatedInc.id === myLatestIncidentId
      ) {
        setStatusFeedbackMsg(
          `Status Laporan #${updatedInc.id} diperbarui secara real-time menjadi: ${updatedInc.status_insiden.toUpperCase()}${
            updatedInc.nama_penangani ? ` (oleh ${updatedInc.nama_penangani})` : ''
          }`
        );
      }
    };

    const onStatusUpdateRejected = (payload: { incident_id?: number; message: string }) => {
      window.alert(payload.message);
      setStatusFeedbackMsg(payload.message);
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
  }, [activeVolunteer, myLatestIncidentId]);

  // Handler Check-In Kehadiran (Ambil GPS) (UC-01, UC-02, UC-03)
  const handleCheckInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCheckinFeedback(null);

    if (!namaRelawan.trim()) {
      window.alert('Silakan masukkan Nama Relawan terlebih dahulu.');
      return;
    }

    if (!pinAcara.trim()) {
      window.alert('Silakan masukkan Kode PIN Acara (6 Digit).');
      return;
    }

    const targetCheckpoint = !isMobileRoleSelected
      ? checkpoints.find((cp) => cp.id === Number(selectedCheckpointId)) || null
      : null;

    if (!isMobileRoleSelected && !targetCheckpoint) {
      window.alert('Silakan pilih Titik Pos Tugas terlebih dahulu.');
      return;
    }

    setIsCheckingIn(true);

    try {
      // Ambil koordinat GPS dari navigator.geolocation.getCurrentPosition(..., { enableHighAccuracy: true })
      const coords = await acquireGpsCoordinates(targetCheckpoint);
      const clientAccuracy = Number(coords.accuracy.toFixed(1));

      // Hitung jarak Haversine di sisi klien untuk ditampilkan secara transparan pada alert
      let clientHaversineMeters: number | null = null;
      if (targetCheckpoint) {
        clientHaversineMeters = Number(
          calculateHaversineDistance(
            coords.latitude,
            coords.longitude,
            Number(targetCheckpoint.latitude),
            Number(targetCheckpoint.longitude)
          ).toFixed(1)
        );
      }

      const response = await fetch(`${API_BASE_URL}/api/volunteers/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nama_relawan: namaRelawan.trim(),
          role: selectedRole,
          id_checkpoint: isMobileRoleSelected ? null : Number(selectedCheckpointId),
          pin_acara: pinAcara.trim(),
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy_meter: coords.accuracy,
          id_event: eventData?.id,
        }),
      });

      const result = await response.json();
      const reportedDist =
        result.jarak_ke_pos_meter !== undefined && result.jarak_ke_pos_meter !== null
          ? Number(result.jarak_ke_pos_meter)
          : clientHaversineMeters;

      if (!response.ok || !result.success) {
        const rejectSummary =
          reportedDist !== null
            ? `${result.message}\n\n• Jarak Haversine (d): ${reportedDist.toFixed(
                1
              )} meter\n• Akurasi Sensor (coords.accuracy): ${clientAccuracy.toFixed(1)} meter`
            : `${result.message}\n\n• Akurasi Sensor (coords.accuracy): ${clientAccuracy.toFixed(
                1
              )} meter`;

        setCheckinFeedback({
          type: 'error',
          title: 'Presensi Check-In Ditolak',
          message: result.message,
          distanceMeters: reportedDist,
          accuracyMeters: clientAccuracy,
        });
        window.alert(rejectSummary);
        return;
      }

      // Check-In Diterima
      const registeredVol: Volunteer = result.volunteer;
      setActiveVolunteer(registeredVol);
      sessionStorage.setItem('unai_active_volunteer', JSON.stringify(registeredVol));
      setCurrentDistanceMeters(reportedDist);
      setCurrentAccuracyMeters(clientAccuracy);
      setLastPollTime(new Date().toLocaleTimeString('id-ID'));
      setPollCountdown(60);

      // Aktifkan Screen Wake Lock API otomatis
      await requestScreenWakeLock();

      const acceptSummary =
        reportedDist !== null
          ? `${result.message}\n\n• Jarak Haversine (d): ${reportedDist.toFixed(
              1
            )} meter\n• Akurasi Sensor (coords.accuracy): ${clientAccuracy.toFixed(1)} meter`
          : `${result.message}\n\n• Status: Active (Mobile)\n• Akurasi Sensor (coords.accuracy): ${clientAccuracy.toFixed(
              1
            )} meter`;

      setCheckinFeedback({
        type: 'success',
        title: 'Presensi Check-In Diterima',
        message: result.message,
        distanceMeters: reportedDist,
        accuracyMeters: clientAccuracy,
      });
      window.alert(acceptSummary);
    } catch (err) {
      const errMsg = (err as Error).message;
      setCheckinFeedback({
        type: 'error',
        title: 'Gagal Mengambil Koordinat GPS',
        message: errMsg,
      });
      window.alert(errMsg);
    } finally {
      setIsCheckingIn(false);
    }
  };

  // Handler Pengiriman Laporan Darurat SOS (UC-05: Langkah 1–2 Sequence Diagram)
  const handleSendSosAlert = async () => {
    if (!activeVolunteer) {
      window.alert('Silakan lakukan Check-In Kehadiran terlebih dahulu sebelum mengirim SOS.');
      return;
    }

    setIsSendingSos(true);
    try {
      const assignedCp =
        checkpoints.find((cp) => cp.id === activeVolunteer.id_checkpoint) ||
        checkpoints[0] ||
        null;

      const coords = await acquireGpsCoordinates(assignedCp);

      socket.emit(
        'send_alert',
        {
          kategori: selectedCategory,
          lat: coords.latitude,
          lng: coords.longitude,
          catatan: catatanInsiden.trim() || null,
          id_pelapor: activeVolunteer.id,
          id_event: activeVolunteer.id_event || eventData?.id,
          client_timestamp: Date.now(),
        },
        (ack: { success: boolean; incident?: Incident; message?: string }) => {
          setIsSendingSos(false);
          if (ack && ack.success && ack.incident) {
            setMyLatestIncidentId(ack.incident.id);
            setFocusedIncidentId(ack.incident.id);
            setCatatanInsiden('');
            setStatusFeedbackMsg(
              `SOS Terkirim! ID Laporan #${ack.incident.id} (${ack.incident.kategori_insiden}) — ±${Number(
                ack.incident.jarak_pos_meter
              ).toFixed(0)} m dari ${ack.incident.nama_pos_terdekat}`
            );
          } else if (ack && !ack.success) {
            window.alert(`Gagal mengirim SOS: ${ack.message}`);
          }
        }
      );
    } catch (err) {
      setIsSendingSos(false);
      window.alert(`Gagal mengambil lokasi GPS untuk SOS: ${(err as Error).message}`);
    }
  };

  // Handler Pembaruan Status Lapangan (UC-06: Langkah 7 & Langkah 11 Sequence Diagram)
  const handleFieldStatusUpdate = (incidentId: number, nextStatus: 'Handled' | 'Resolved') => {
    if (!activeVolunteer) {
      window.alert('Anda harus Check-In terlebih dahulu untuk memperbarui status penanganan.');
      return;
    }

    socket.emit(
      'update_status',
      {
        incident_id: incidentId,
        id_penangani: activeVolunteer.id,
        status: nextStatus,
        client_timestamp: Date.now(),
      },
      (ack: {
        success: boolean;
        locked?: boolean;
        incident?: Incident;
        message?: string;
      }) => {
        if (ack && !ack.success && ack.message) {
          window.alert(ack.message);
        }
      }
    );
  };

  // Laporan terbaru milik relawan yang sedang login (untuk Kotak Status Real-Time di bawah tombol SOS)
  const myLatestIncident = useMemo(() => {
    if (myLatestIncidentId) {
      const byId = incidents.find((i) => i.id === myLatestIncidentId);
      if (byId) return byId;
    }
    if (activeVolunteer) {
      return incidents.find((i) => i.id_pelapor === activeVolunteer.id) || null;
    }
    return null;
  }, [incidents, myLatestIncidentId, activeVolunteer]);

  // Insiden yang ditampilkan pada peta mini UC-06
  const focusedIncident = useMemo(() => {
    if (focusedIncidentId) {
      const found = incidents.find((i) => i.id === focusedIncidentId);
      if (found) return found;
    }
    return incidents[0] || null;
  }, [incidents, focusedIncidentId]);

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

  const dynamicMapCenter = useMemo<[number, number]>(() => {
    if (!checkpoints || checkpoints.length === 0) {
      return [-6.814834, 107.582814];
    }
    const sumLat = checkpoints.reduce((acc, cp) => acc + Number(cp.latitude), 0);
    const sumLng = checkpoints.reduce((acc, cp) => acc + Number(cp.longitude), 0);
    return [sumLat / checkpoints.length, sumLng / checkpoints.length];
  }, [checkpoints]);

  // Badge Warna & Label Indikator Status Lokasi (Langkah 3 Poin 2)
  const getLocationBadgeProps = () => {
    if (!activeVolunteer) {
      return {
        label: 'BELUM CHECK-IN (MENUNGGU PRESENSI)',
        bgClass: 'bg-slate-800 border-slate-600 text-slate-300',
        dotClass: 'bg-slate-400',
      };
    }
    const status = activeVolunteer.status_lokasi;
    if (status === 'Active') {
      return {
        label: 'STATUS: ACTIVE (<= 100m Pos / <= 50m Marshal)',
        bgClass: 'bg-emerald-950/90 border-emerald-500 text-emerald-300',
        dotClass: 'bg-emerald-400 animate-pulse',
      };
    }
    if (status === 'Active (Mobile)') {
      return {
        label: 'STATUS: ACTIVE (MOBILE)',
        bgClass: 'bg-blue-950/90 border-blue-500 text-blue-300',
        dotClass: 'bg-blue-400 animate-pulse',
      };
    }
    if (status === 'Out of Area') {
      return {
        label: 'STATUS: OUT OF AREA',
        bgClass: 'bg-orange-950/90 border-orange-500 text-orange-300',
        dotClass: 'bg-orange-400 animate-ping',
      };
    }
    return {
      label: 'STATUS: UNKNOWN (> 180s)',
      bgClass: 'bg-slate-800/95 border-slate-500 text-slate-300',
      dotClass: 'bg-slate-400',
    };
  };

  const badgeProps = getLocationBadgeProps();

  return (
    <div
      className={`min-h-screen transition-colors duration-200 ${
        lowPowerMode
          ? 'bg-black text-slate-100'
          : 'bg-slate-900 text-slate-100'
      }`}
    >
      {/* Top Bar Navigasi & Status Browser APIs */}
      <header
        className={`border-b px-4 py-3 ${
          lowPowerMode ? 'bg-zinc-950 border-zinc-800' : 'bg-slate-950 border-slate-800'
        }`}
      >
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold">
              FR
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white">
                Portal Web Relawan — {eventData?.nama_event || 'UNAI Fun Run 2026'}
              </h1>
              <p className="text-xs text-slate-400">
                Presensi Geofencing Berdiferensiasi, Periodic Polling 60s &amp; Real-Time SOS Alert
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Tombol Toggle Low-Power Dark Display (Screen Wake Lock API UI) */}
            <button
              type="button"
              onClick={() => {
                setLowPowerMode((prev) => !prev);
                requestScreenWakeLock();
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition ${
                lowPowerMode
                  ? 'bg-zinc-900 border-emerald-500/50 text-emerald-300'
                  : 'bg-slate-800 border-slate-700 text-slate-300'
              }`}
              title="Mode Layar Hemat Daya (OLED Low-Power Dark Display) & Screen Wake Lock"
            >
              {lowPowerMode ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
              <span>Low-Power Dark Display: {lowPowerMode ? 'ON' : 'OFF'}</span>
            </button>

            <Link
              to="/dashboard"
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition"
            >
              Buka Dashboard Koordinator &rarr;
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Grid: Persis Tata Letak Wireframe Gambar 5 (Panel Kiri & Panel Kanan) */}
      <main className="max-w-7xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ===================================================================
            PANEL KIRI: FORM SELF-ONBOARDING & CHECK-IN (UC-01, UC-02, UC-03)
        =================================================================== */}
        <section
          className={`lg:col-span-5 rounded-xl border p-5 flex flex-col justify-between ${
            lowPowerMode
              ? 'bg-zinc-950 border-zinc-800'
              : 'bg-slate-950/90 border-slate-800'
          }`}
        >
          <div>
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
              <div>
                <span className="text-[11px] uppercase tracking-wider font-semibold text-emerald-400">
                  UC-01 &bull; UC-02 &bull; UC-03
                </span>
                <h2 className="text-base font-bold text-white mt-0.5">
                  Form Self-Onboarding &amp; Check-In
                </h2>
              </div>
              <UserCheck className="w-5 h-5 text-emerald-400" />
            </div>

            <form onSubmit={handleCheckInSubmit} className="space-y-4">
              {/* 1. Input Nama Relawan */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Nama Relawan
                </label>
                <input
                  type="text"
                  value={namaRelawan}
                  onChange={(e) => setNamaRelawan(e.target.value)}
                  placeholder="Masukkan nama lengkap Anda"
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>

              {/* 2. Dropdown Kategori Peran */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Kategori Peran Tugas
                </label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value as VolunteerRole)}
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                >
                  {ALL_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}{' '}
                      {role === 'Water Station' || role === 'Medis Pos'
                        ? '(Pos Statis - Radius Check-In <= 50m)'
                        : role === 'Marshal'
                        ? '(Simpang - Radius Check-In <= 30m)'
                        : '(Relawan Bergerak / Mobile)'}
                    </option>
                  ))}
                </select>
              </div>

              {/* 3. Dropdown Titik Pos Tugas (Otomatis memfilter Pos Utama vs Simpang Marshal vs Disabled) */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Titik Pos Tugas
                </label>
                <select
                  value={isMobileRoleSelected ? '' : selectedCheckpointId}
                  onChange={(e) =>
                    setSelectedCheckpointId(e.target.value ? Number(e.target.value) : '')
                  }
                  disabled={isMobileRoleSelected}
                  className={`w-full rounded-lg border px-3.5 py-2.5 text-sm focus:outline-none ${
                    isMobileRoleSelected
                      ? 'bg-slate-900/40 border-slate-800 text-slate-500 cursor-not-allowed'
                      : 'bg-slate-900 border-slate-700 text-white focus:border-emerald-500'
                  }`}
                >
                  {isMobileRoleSelected ? (
                    <option value="">
                      Tidak memerlukan pos statis (Relawan Bergerak: {selectedRole})
                    </option>
                  ) : (
                    filteredCheckpoints.map((cp) => (
                      <option key={cp.id} value={cp.id}>
                        {cp.nama_pos} — Radius Check-In &le; {cp.radius_checkin}m / Pantau &le;{' '}
                        {cp.radius_monitoring}m
                      </option>
                    ))
                  )}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  {selectedRole === 'Water Station' || selectedRole === 'Medis Pos'
                    ? 'Menampilkan 3 Pos Utama (Water Station & Medis Pos: Check-In <= 50 m).'
                    : selectedRole === 'Marshal'
                    ? 'Menampilkan 5 Titik Persimpangan Marshal (Check-In <= 30 m).'
                    : 'Peran bergerak langsung mengaktifkan status Active (Mobile) tanpa batas radius pos statis.'}
                </p>
              </div>

              {/* 4. Input Kode PIN Acara (6 Digit) */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Kode PIN Acara (6 Digit)
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={pinAcara}
                  onChange={(e) => setPinAcara(e.target.value)}
                  placeholder="Masukkan 6 digit PIN Acara (202601)"
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2.5 text-sm font-mono tracking-widest text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>

              {/* Opsi Bantu Simulasi Sensor GPS untuk Pengujian di PC/Laptop */}
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-3">
                <label className="block text-[11px] font-semibold text-amber-400 mb-1">
                  Mode Pembacaan Sensor GPS (`navigator.geolocation`)
                </label>
                <select
                  value={gpsSimulationMode}
                  onChange={(e) => setGpsSimulationMode(e.target.value as any)}
                  className="w-full rounded bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200"
                >
                  <option value="real">
                    Sensor GPS Asli Perangkat (enableHighAccuracy: true)
                  </option>
                  <option value="inside_post">
                    Simulasi Di Dalam Radius Pos (&plusmn;10 m, Akurasi 12.5 m &rarr; Diterima)
                  </option>
                  <option value="outside_post">
                    Simulasi Di Luar Radius Pos (&plusmn;180 m, Akurasi 15.0 m &rarr; Ditolak / Out of Area)
                  </option>
                  <option value="poor_accuracy">
                    Simulasi Galat Sensor Tinggi (Akurasi 78.4 m &gt; 50 m &rarr; Ditolak / Diabaikan)
                  </option>
                </select>
              </div>

              {/* 5. Tombol Check-In Kehadiran (Ambil GPS) */}
              <button
                type="submit"
                disabled={isCheckingIn}
                className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 text-white font-bold py-3 px-4 text-sm shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-2 transition"
              >
                <Navigation className="w-4 h-4" />
                <span>
                  {isCheckingIn
                    ? 'Mengambil Koordinat GPS & Memvalidasi Geofencing...'
                    : 'Check-In Kehadiran (Ambil GPS)'}
                </span>
              </button>
            </form>

            {/* Kotak Alert Detail Jarak Haversine & coords.accuracy */}
            {checkinFeedback && (
              <div
                className={`mt-4 rounded-xl border p-3.5 text-xs ${
                  checkinFeedback.type === 'success'
                    ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200'
                    : 'bg-red-950/60 border-red-500/60 text-red-200'
                }`}
              >
                <div className="font-bold text-sm mb-1 flex items-center gap-1.5">
                  {checkinFeedback.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  )}
                  <span>{checkinFeedback.title}</span>
                </div>
                <p className="leading-relaxed mb-2">{checkinFeedback.message}</p>
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/10 font-mono text-[11px]">
                  <div>
                    <span className="text-slate-400 block">Jarak Haversine (d):</span>
                    <strong className="text-white">
                      {checkinFeedback.distanceMeters !== null &&
                      checkinFeedback.distanceMeters !== undefined
                        ? `${checkinFeedback.distanceMeters.toFixed(1)} meter`
                        : 'Mobile (Tanpa Pos Statis)'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">coords.accuracy:</span>
                    <strong className="text-white">
                      {checkinFeedback.accuracyMeters !== null &&
                      checkinFeedback.accuracyMeters !== undefined
                        ? `±${checkinFeedback.accuracyMeters.toFixed(1)} meter`
                        : '-'}
                    </strong>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Info Sesi Relawan Aktif */}
          {activeVolunteer && (
            <div className="mt-5 pt-4 border-t border-slate-800 text-xs text-slate-300 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Relawan Aktif:</span>
                <strong className="text-white">
                  {activeVolunteer.nama_relawan} (#{activeVolunteer.id})
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Peran &amp; Pos Tugas:</span>
                <span className="text-emerald-300 font-medium">
                  {activeVolunteer.role}{' '}
                  {activeVolunteer.nama_pos ? `— ${activeVolunteer.nama_pos}` : '(Mobile)'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Waktu Check-In:</span>
                <span className="font-mono">
                  {activeVolunteer.check_in_time
                    ? new Date(activeVolunteer.check_in_time).toLocaleTimeString('id-ID')
                    : '-'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  sessionStorage.removeItem('unai_active_volunteer');
                  setActiveVolunteer(null);
                  setCheckinFeedback(null);
                }}
                className="w-full mt-2 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs transition"
              >
                Ganti Akun / Check-In Relawan Lain
              </button>
            </div>
          )}
        </section>

        {/* ===================================================================
            PANEL KANAN: PANEL AKTIF PERIODIC POLLING & SOS (UC-04, UC-05, UC-06)
        =================================================================== */}
        <section className="lg:col-span-7 space-y-5">
          {/* 1. BADGE INDIKATOR BESAR STATUS LOKASI & PERIODIC POLLING (UC-04) */}
          <div
            className={`rounded-xl border p-5 ${
              lowPowerMode
                ? 'bg-zinc-950 border-zinc-800'
                : 'bg-slate-950/90 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] uppercase tracking-wider font-semibold text-emerald-400">
                Panel Aktif Periodic Polling &amp; SOS (UC-04 &bull; UC-05)
              </span>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span className="flex items-center gap-1">
                  <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
                  WakeLock: <strong className="text-slate-200">{wakeLockActive ? 'Aktif' : 'Siaga'}</strong>
                </span>
                <span>&bull;</span>
                <span className="flex items-center gap-1">
                  <Eye className="w-3.5 h-3.5 text-blue-400" />
                  Layar: <strong className="text-slate-200">{visibilityStatus}</strong>
                </span>
              </div>
            </div>

            {/* Badge Status Besar */}
            <div
              className={`rounded-xl border-2 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3 ${badgeProps.bgClass}`}
            >
              <div className="flex items-center gap-3">
                <span className={`w-3.5 h-3.5 rounded-full shrink-0 ${badgeProps.dotClass}`} />
                <span className="font-extrabold text-sm md:text-base tracking-wide">
                  {badgeProps.label}
                </span>
              </div>

              {activeVolunteer && (
                <button
                  type="button"
                  onClick={() => executePeriodicPoll(activeVolunteer)}
                  className="px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-xs font-medium flex items-center gap-1 transition"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Kirim Lokasi Sekarang</span>
                </button>
              )}
            </div>

            {/* Baris Metrik Jarak Haversine, coords.accuracy, dan Hitung Mundur Periodic Polling */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 text-xs">
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-3">
                <span className="text-slate-400 block text-[11px]">Jarak Haversine Saat Ini (d)</span>
                <strong className="text-white text-sm font-mono">
                  {currentDistanceMeters !== null
                    ? `${currentDistanceMeters.toFixed(1)} m`
                    : activeVolunteer?.status_lokasi === 'Active (Mobile)'
                    ? 'Mobile (Dinamis)'
                    : '-'}
                </strong>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-3">
                <span className="text-slate-400 block text-[11px]">Akurasi Sensor (coords.accuracy)</span>
                <strong className="text-white text-sm font-mono">
                  {currentAccuracyMeters !== null ? `±${currentAccuracyMeters.toFixed(1)} m` : '-'}
                </strong>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-3">
                <span className="text-slate-400 block text-[11px]">Siklus Polling Berikutnya</span>
                <strong className="text-emerald-400 text-sm font-mono">
                  {activeVolunteer ? `${pollCountdown} detik` : 'Menunggu Check-In'}
                </strong>
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center justify-between text-[11px] text-slate-400 gap-2">
              <span>
                Periodic Polling: Tiap 60 detik (Timeout &gt; 180s = Unknown | Filter Akurasi &le; 50m)
              </span>
              {lastPollTime && <span>Update Terakhir: {lastPollTime}</span>}
            </div>

            {pollNotice && (
              <p className="mt-2 text-[11px] text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded px-2.5 py-1">
                {pollNotice}
              </p>
            )}
          </div>

          {/* 2. FORM KIRIM LAPORAN INCIDENT ALERT (SOS & GPS) (UC-05) */}
          <div
            className={`rounded-xl border p-5 ${
              lowPowerMode
                ? 'bg-zinc-950 border-zinc-800'
                : 'bg-slate-950/90 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-[11px] uppercase tracking-wider font-semibold text-red-400">
                  UC-05 &bull; Real-Time Incident Alert
                </span>
                <h3 className="text-base font-bold text-white">
                  Kirim Laporan Incident Alert (SOS &amp; GPS)
                </h3>
              </div>
              <ShieldAlert className="w-5 h-5 text-red-500" />
            </div>

            {/* 4 Tombol Pilihan Kategori Insiden */}
            <label className="block text-xs font-semibold text-slate-300 mb-2">
              Pilih Kategori Insiden:
            </label>
            <div className="grid grid-cols-2 gap-2.5 mb-4">
              {INCIDENT_CATEGORIES.map((kategori) => {
                const isSelected = selectedCategory === kategori;
                return (
                  <button
                    key={kategori}
                    type="button"
                    onClick={() => setSelectedCategory(kategori)}
                    className={`p-3 rounded-xl border text-left text-xs font-bold transition flex items-center justify-between ${
                      isSelected
                        ? 'bg-red-950/80 border-red-500 text-red-200 ring-2 ring-red-500/30'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <span>{kategori}</span>
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        isSelected ? 'bg-red-400' : 'bg-slate-700'
                      }`}
                    />
                  </button>
                );
              })}
            </div>

            {/* Input Catatan Insiden */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Catatan Insiden (Opsional)
              </label>
              <input
                type="text"
                value={catatanInsiden}
                onChange={(e) => setCatatanInsiden(e.target.value)}
                placeholder="Tulis catatan insiden..."
                className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-500"
              />
            </div>

            {/* Tombol Merah Mencolok KIRIM INCIDENT ALERT (SOS) */}
            <button
              type="button"
              disabled={isSendingSos}
              onClick={handleSendSosAlert}
              className="w-full rounded-xl bg-red-600 hover:bg-red-500 disabled:bg-red-900 text-white font-extrabold py-3.5 px-4 text-sm tracking-wide shadow-lg shadow-red-950/60 flex items-center justify-center gap-2 transition"
            >
              <Send className="w-4 h-4" />
              <span>
                {isSendingSos
                  ? 'MENGAMBIL KOORDINAT GPS & MENGIRIM SOS...'
                  : 'KIRIM INCIDENT ALERT (SOS)'}
              </span>
            </button>

            {/* Kotak Status Real-Time di Bawah Tombol SOS */}
            <div className="mt-4 rounded-xl bg-slate-900 border border-slate-700 px-4 py-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-300">
                  Status Laporan Anda:{' '}
                  {myLatestIncident ? (
                    <strong
                      className={
                        myLatestIncident.status_insiden === 'New'
                          ? 'text-red-400'
                          : myLatestIncident.status_insiden === 'Handled'
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                      }
                    >
                      {myLatestIncident.status_insiden === 'New' && 'NEW'}
                      {myLatestIncident.status_insiden === 'Handled' &&
                        `HANDLED oleh ${myLatestIncident.nama_penangani || 'Petugas'}`}
                      {myLatestIncident.status_insiden === 'Resolved' && 'RESOLVED'}
                    </strong>
                  ) : (
                    <strong className="text-slate-400">NEW / HANDLED / RESOLVED</strong>
                  )}{' '}
                  <span className="text-slate-400">(Real-Time via Socket.IO)</span>
                </span>

                {myLatestIncident && (
                  <span className="font-mono text-[11px] text-slate-400">
                    #{myLatestIncident.id} &bull; &plusmn;
                    {Number(myLatestIncident.jarak_pos_meter).toFixed(0)} m dari{' '}
                    {myLatestIncident.nama_pos_terdekat}
                  </span>
                )}
              </div>
              {statusFeedbackMsg && (
                <p className="mt-1.5 text-[11px] text-emerald-300">{statusFeedbackMsg}</p>
              )}
            </div>
          </div>

          {/* 3. SEKSI LIHAT TITIK INSIDEN & PERBARUI STATUS LAPANGAN (UC-06) */}
          <div
            className={`rounded-xl border p-5 ${
              lowPowerMode
                ? 'bg-zinc-950 border-zinc-800'
                : 'bg-slate-950/90 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-[11px] uppercase tracking-wider font-semibold text-amber-400">
                  UC-06 &bull; Respons Petugas Lapangan &amp; Medis
                </span>
                <h3 className="text-base font-bold text-white">
                  Lihat Titik Insiden &amp; Perbarui Status Lapangan
                </h3>
              </div>
              <Activity className="w-5 h-5 text-amber-400" />
            </div>

            {/* Peta Mini Lokasi Insiden & Patokan Pos Terdekat */}
            <div className="h-56 w-full rounded-xl overflow-hidden border border-slate-800 mb-4 relative z-0">
              <MapContainer
                center={
                  focusedIncident
                    ? [Number(focusedIncident.incident_lat), Number(focusedIncident.incident_lng)]
                    : dynamicMapCenter
                }
                zoom={15}
                style={{ height: '100%', width: '100%' }}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MiniMapBoundsUpdater checkpoints={checkpoints} />
                {dynamicRoutePositions.length > 1 && (
                  <Polyline
                    positions={dynamicRoutePositions}
                    pathOptions={{
                      color: '#6366f1',
                      weight: 3,
                      opacity: 0.8,
                      dashArray: '6, 6',
                    }}
                  />
                )}
                {checkpoints.map((cp) => (
                  <React.Fragment key={cp.id}>
                    <Marker
                      position={[Number(cp.latitude), Number(cp.longitude)]}
                      icon={checkpointPinIcon}
                    >
                      <Popup>
                        <strong>{cp.nama_pos}</strong>
                        <br />
                        Radius Check-In: {cp.radius_checkin}m
                      </Popup>
                    </Marker>
                    <Circle
                      center={[Number(cp.latitude), Number(cp.longitude)]}
                      radius={cp.radius_monitoring}
                      pathOptions={{
                        color: cp.radius_checkin === 50 ? '#10b981' : '#3b82f6',
                        fillOpacity: 0.08,
                        weight: 1,
                      }}
                    />
                  </React.Fragment>
                ))}
                {incidents.map((inc) => (
                  <Marker
                    key={inc.id}
                    position={[Number(inc.incident_lat), Number(inc.incident_lng)]}
                    icon={incidentPinIcon}
                  >
                    <Popup>
                      <div className="text-xs">
                        <strong>
                          #{inc.id} - {inc.kategori_insiden}
                        </strong>
                        <br />
                        Patokan: &plusmn;{Number(inc.jarak_pos_meter).toFixed(0)} m dari{' '}
                        {inc.nama_pos_terdekat}
                        <br />
                        Status: <strong>{inc.status_insiden}</strong>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>

            {/* Daftar Insiden Aktif Beserta Patokan Jarak Pos Terdekat & Tombol Tangani / Selesai */}
            {incidents.length === 0 ? (
              <div className="rounded-lg bg-slate-900/60 border border-slate-800 p-4 text-center text-xs text-slate-400">
                Belum ada laporan insiden darurat yang masuk.
              </div>
            ) : (
              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                {incidents.map((inc) => {
                  const isLockedByOther =
                    inc.id_penangani !== null &&
                    activeVolunteer &&
                    inc.id_penangani !== activeVolunteer.id;

                  return (
                    <div
                      key={inc.id}
                      onClick={() => setFocusedIncidentId(inc.id)}
                      className={`rounded-xl border p-3.5 text-xs transition cursor-pointer ${
                        inc.status_insiden === 'New'
                          ? 'bg-red-950/30 border-red-500/50'
                          : inc.status_insiden === 'Handled'
                          ? 'bg-amber-950/30 border-amber-500/50'
                          : 'bg-slate-900/60 border-slate-800'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-white">#{inc.id}</span>
                          <span className="font-bold text-sm text-white">
                            {inc.kategori_insiden}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                              inc.status_insiden === 'New'
                                ? 'bg-red-600 text-white'
                                : inc.status_insiden === 'Handled'
                                ? 'bg-amber-500 text-slate-950'
                                : 'bg-emerald-600 text-white'
                            }`}
                          >
                            {inc.status_insiden}
                          </span>
                        </div>
                        <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(inc.created_at).toLocaleTimeString('id-ID')}
                        </span>
                      </div>

                      <div className="text-emerald-300 font-semibold mb-1 flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          Jarak Pos Terdekat: &plusmn;{Number(inc.jarak_pos_meter).toFixed(0)} m dari{' '}
                          {inc.nama_pos_terdekat || `Pos #${inc.id_checkpoint_terdekat}`}
                        </span>
                      </div>

                      {inc.catatan && (
                        <p className="text-slate-300 italic mb-1.5">Catatan: "{inc.catatan}"</p>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 mb-2.5">
                        <span>
                          Pelapor: <strong className="text-slate-200">{inc.nama_pelapor || `#${inc.id_pelapor}`}</strong>
                        </span>
                        <span>
                          Penangani:{' '}
                          <strong className="text-amber-300">
                            {inc.nama_penangani ? (
                              <span className="inline-flex items-center gap-1">
                                <Lock className="w-3 h-3" />
                                {inc.nama_penangani}
                              </span>
                            ) : (
                              'Belum Dikunci'
                            )}
                          </strong>
                        </span>
                      </div>

                      {/* Tombol Aksi Lapangan UC-06: Tangani (Set Handled) & Selesai (Set Resolved) */}
                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/10">
                        <button
                          type="button"
                          disabled={inc.status_insiden !== 'New'}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFieldStatusUpdate(inc.id, 'Handled');
                          }}
                          className={`px-3 py-1.5 rounded-lg font-bold text-xs transition ${
                            inc.status_insiden === 'New'
                              ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          {inc.status_insiden === 'New'
                            ? 'Tangani (Set Handled)'
                            : isLockedByOther
                            ? `Dikunci oleh ${inc.nama_penangani}`
                            : 'Sudah Handled'}
                        </button>

                        <button
                          type="button"
                          disabled={inc.status_insiden === 'Resolved'}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFieldStatusUpdate(inc.id, 'Resolved');
                          }}
                          className={`px-3 py-1.5 rounded-lg font-bold text-xs transition ${
                            inc.status_insiden !== 'Resolved'
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          {inc.status_insiden === 'Resolved'
                            ? 'Sudah Resolved'
                            : 'Selesai (Set Resolved)'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

