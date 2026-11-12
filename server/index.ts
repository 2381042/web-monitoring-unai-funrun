import express, { Request, Response } from 'express';
import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase, pool } from './db';
import { calculateHaversineDistance, toRadians, EARTH_RADIUS_METERS } from './haversine';

dotenv.config();

export { calculateHaversineDistance, toRadians, EARTH_RADIUS_METERS };

const app = express();
const server = http.createServer(app);
export const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  },
});

app.use(cors());
app.use(express.json());

const STATIC_ROLES = ['Water Station', 'Medis Pos', 'Marshal'] as const;
const MOBILE_ROLES = ['Pacer', 'Tim Medis Mobile'] as const;
const ALL_ROLES = [...STATIC_ROLES, ...MOBILE_ROLES] as const;

// Helper: Ambil 1 data relawan lengkap beserta join nama pos tugasnya
async function getEnrichedVolunteer(volunteerId: number) {
  const res = await pool.query(
    `SELECT 
       v.*,
       cp.nama_pos,
       cp.kilometer AS checkpoint_kilometer,
       cp.latitude AS checkpoint_lat,
       cp.longitude AS checkpoint_lng,
       cp.radius_checkin,
       cp.radius_monitoring
     FROM volunteers v
     LEFT JOIN checkpoints cp ON v.id_checkpoint = cp.id
     WHERE v.id = $1`,
    [volunteerId]
  );
  return res.rows[0] || null;
}

// Helper: Ambil seluruh daftar relawan beserta join pos tugasnya
async function getAllEnrichedVolunteers(eventId?: number) {
  const params: unknown[] = [];
  let whereClause = '';
  if (eventId) {
    params.push(eventId);
    whereClause = 'WHERE v.id_event = $1';
  }
  const res = await pool.query(
    `SELECT 
       v.*,
       cp.nama_pos,
       cp.kilometer AS checkpoint_kilometer,
       cp.latitude AS checkpoint_lat,
       cp.longitude AS checkpoint_lng,
       cp.radius_checkin,
       cp.radius_monitoring
     FROM volunteers v
     LEFT JOIN checkpoints cp ON v.id_checkpoint = cp.id
     ${whereClause}
     ORDER BY v.id DESC`,
    params
  );
  return res.rows;
}

// Helper: Ambil 1 data insiden lengkap beserta join pelapor, penangani, dan pos terdekat
async function getEnrichedIncident(incidentId: number) {
  const res = await pool.query(
    `SELECT 
       i.*,
       v_pelapor.nama_relawan AS nama_pelapor,
       v_pelapor.role AS role_pelapor,
       v_penangani.nama_relawan AS nama_penangani,
       v_penangani.role AS role_penangani,
       cp.nama_pos AS nama_pos_terdekat,
       cp.kilometer AS kilometer_pos_terdekat,
       CASE 
         WHEN i.handled_at IS NOT NULL 
         THEN EXTRACT(EPOCH FROM (i.handled_at - i.created_at))::float 
         ELSE NULL 
       END AS durasi_tanggap_detik,
       CASE 
         WHEN i.resolved_at IS NOT NULL 
         THEN EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))::float 
         ELSE NULL 
       END AS durasi_selesai_detik
     FROM incidents i
     LEFT JOIN volunteers v_pelapor ON i.id_pelapor = v_pelapor.id
     LEFT JOIN volunteers v_penangani ON i.id_penangani = v_penangani.id
     LEFT JOIN checkpoints cp ON i.id_checkpoint_terdekat = cp.id
     WHERE i.id = $1`,
    [incidentId]
  );
  return res.rows[0] || null;
}

// Helper: Ambil seluruh daftar insiden lengkap beserta join pelapor, penangani, dan pos terdekat
async function getAllEnrichedIncidents(eventId?: number) {
  const params: unknown[] = [];
  let whereClause = '';
  if (eventId) {
    params.push(eventId);
    whereClause = 'WHERE i.id_event = $1';
  }
  const res = await pool.query(
    `SELECT 
       i.*,
       v_pelapor.nama_relawan AS nama_pelapor,
       v_pelapor.role AS role_pelapor,
       v_penangani.nama_relawan AS nama_penangani,
       v_penangani.role AS role_penangani,
       cp.nama_pos AS nama_pos_terdekat,
       cp.kilometer AS kilometer_pos_terdekat,
       CASE 
         WHEN i.handled_at IS NOT NULL 
         THEN EXTRACT(EPOCH FROM (i.handled_at - i.created_at))::float 
         ELSE NULL 
       END AS durasi_tanggap_detik,
       CASE 
         WHEN i.resolved_at IS NOT NULL 
         THEN EXTRACT(EPOCH FROM (i.resolved_at - i.created_at))::float 
         ELSE NULL 
       END AS durasi_selesai_detik
     FROM incidents i
     LEFT JOIN volunteers v_pelapor ON i.id_pelapor = v_pelapor.id
     LEFT JOIN volunteers v_penangani ON i.id_penangani = v_penangani.id
     LEFT JOIN checkpoints cp ON i.id_checkpoint_terdekat = cp.id
     ${whereClause}
     ORDER BY i.created_at DESC, i.id DESC`,
    params
  );
  return res.rows;
}

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    const dbRes = await pool.query('SELECT NOW() AS time');
    res.json({ status: 'ok', dbTime: dbRes.rows[0].time });
  } catch (err) {
    res.status(500).json({ status: 'error', message: (err as Error).message });
  }
});

/**
 * 1. POST /api/coordinator/login (UC-01)
 * Autentikasi kredensial khusus Koordinator (default username: admin, password: unai2026)
 */
app.post('/api/coordinator/login', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  const validUsername = process.env.COORDINATOR_USERNAME || 'admin';
  const validPassword = process.env.COORDINATOR_PASSWORD || 'unai2026';

  if (username === validUsername && password === validPassword) {
    return res.json({
      success: true,
      role: 'Coordinator',
      username: validUsername,
      message: 'Autentikasi Koordinator (Race Director & Admin) berhasil.',
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Kredensial Koordinator tidak valid. Periksa kembali username dan password Anda.',
  });
});

/**
 * 2. GET /api/init
 * Mengambil data event aktif, daftar Checkpoints, daftar Volunteers, dan daftar Incidents
 * beserta join nama pelapor, nama penangani, dan nama pos terdekat.
 */
app.get('/api/init', async (_req: Request, res: Response) => {
  try {
    const eventRes = await pool.query('SELECT * FROM events ORDER BY id ASC LIMIT 1');
    const activeEvent = eventRes.rows[0] || null;
    const eventId = activeEvent ? activeEvent.id : undefined;

    const checkpointsRes = await pool.query(
      eventId
        ? 'SELECT * FROM checkpoints WHERE id_event = $1 ORDER BY id ASC'
        : 'SELECT * FROM checkpoints ORDER BY id ASC',
      eventId ? [eventId] : []
    );

    const volunteers = await getAllEnrichedVolunteers(eventId);
    const incidents = await getAllEnrichedIncidents(eventId);

    return res.json({
      success: true,
      event: activeEvent,
      checkpoints: checkpointsRes.rows,
      volunteers,
      incidents,
    });
  } catch (error) {
    console.error('[API /api/init] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data inisialisasi sistem.',
      error: (error as Error).message,
    });
  }
});

/**
 * 3. PUT /api/checkpoints/:id (Subbab 2.2.B)
 * Memperbarui latitude dan longitude titik pos pada tabel Checkpoints oleh Koordinator
 * saat kalibrasi lapangan sebelum acara dimulai.
 */
app.put('/api/checkpoints/:id', async (req: Request, res: Response) => {
  try {
    const checkpointId = Number(req.params.id);
    const { latitude, longitude } = req.body || {};

    if (!Number.isInteger(checkpointId) || checkpointId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'ID Checkpoint tidak valid.',
      });
    }

    const latNum = Number(latitude);
    const lngNum = Number(longitude);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({
        success: false,
        message: 'Koordinat latitude dan longitude harus berupa angka desimal yang valid.',
      });
    }

    const updateRes = await pool.query(
      `UPDATE checkpoints
       SET latitude = $1,
           longitude = $2
       WHERE id = $3
       RETURNING *`,
      [latNum, lngNum, checkpointId]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Titik pos (Checkpoint) tidak ditemukan.',
      });
    }

    const updatedCheckpoint = updateRes.rows[0];

    // Pancarkan pembaruan koordinat pos ke seluruh klien (Dashboard & Relawan)
    io.emit('checkpoint_updated', updatedCheckpoint);

    return res.json({
      success: true,
      message: `Koordinat ${updatedCheckpoint.nama_pos} berhasil dikalibrasi.`,
      checkpoint: updatedCheckpoint,
    });
  } catch (error) {
    console.error('[API PUT /api/checkpoints/:id] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui koordinat titik pos.',
      error: (error as Error).message,
    });
  }
});

/**
 * 4. POST /api/volunteers/checkin (UC-01, UC-02, UC-03)
 * - Validasi pin_acara ("202601") pada tabel Events.
 * - Periksa accuracy_meter: jika > 50 m, tolak dengan pesan galat akurasi sensor (> 50 m).
 * - Untuk Water Station & Medis Pos: hitung jarak Haversine ke pos yang dipilih; terima menjadi Active
 *   dan catat check_in_time = NOW() hanya jika d <= 50 m (tolak jika d > 50 m).
 * - Untuk Marshal: terima menjadi Active hanya jika d <= 30 m (tolak jika d > 30 m).
 * - Untuk Pacer & Tim Medis Mobile: langsung catat check_in_time = NOW(), id_checkpoint = NULL,
 *   dan status_lokasi = 'Active (Mobile)'.
 * - Simpan log pertama ke Location_Logs dan pancarkan pembaruan relawan via Socket.IO ke Dashboard.
 */
app.post('/api/volunteers/checkin', async (req: Request, res: Response) => {
  try {
    const {
      nama_relawan,
      role,
      id_checkpoint,
      pin_acara,
      latitude,
      longitude,
      accuracy_meter,
      accuracy,
      id_event,
    } = req.body || {};

    if (!nama_relawan || typeof nama_relawan !== 'string' || !nama_relawan.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Nama relawan wajib diisi.',
      });
    }

    if (!role || !ALL_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Peran tugas tidak valid. Pilih salah satu dari: ${ALL_ROLES.join(', ')}.`,
      });
    }

    // UC-01: Validasi kode PIN sesi acara relawan terhadap tabel Events
    const eventQuery = id_event
      ? await pool.query('SELECT * FROM events WHERE id = $1 LIMIT 1', [Number(id_event)])
      : await pool.query('SELECT * FROM events ORDER BY id ASC LIMIT 1');

    const activeEvent = eventQuery.rows[0];
    if (!activeEvent) {
      return res.status(404).json({
        success: false,
        message: 'Data event aktif tidak ditemukan di basis data.',
      });
    }

    if (String(pin_acara || '').trim() !== String(activeEvent.pin_acara).trim()) {
      return res.status(401).json({
        success: false,
        message: 'Kode PIN Acara tidak valid. Masukkan kode PIN sesi acara yang benar (202601).',
      });
    }

    // Filter akurasi sensor (coords.accuracy <= 50 m)
    const rawAccuracy = accuracy_meter !== undefined ? accuracy_meter : accuracy;
    const accValue = rawAccuracy !== undefined && rawAccuracy !== null ? Number(rawAccuracy) : 10;

    if (!Number.isFinite(accValue) || accValue > 50) {
      return res.status(400).json({
        success: false,
        code: 'ACCURACY_TOO_LOW',
        accuracy_meter: accValue,
        message: `Presensi ditolak sementara: Galat akurasi sensor GPS (${accValue.toFixed(
          1
        )} m) melebihi batas maksimal 50 m. Pastikan GPS aktif di ruang terbuka lalu coba lagi.`,
      });
    }

    const isMobileRole = (MOBILE_ROLES as readonly string[]).includes(role);

    // UC-03: Check-In Kesiapan Tugas untuk Relawan Bergerak (Pacer & Tim Medis Mobile)
    if (isMobileRole) {
      const latNum =
        latitude !== undefined && latitude !== null && Number.isFinite(Number(latitude))
          ? Number(latitude)
          : -6.817893;
      const lngNum =
        longitude !== undefined && longitude !== null && Number.isFinite(Number(longitude))
          ? Number(longitude)
          : 107.587672;

      const insertVolRes = await pool.query(
        `INSERT INTO volunteers (
           id_event, id_checkpoint, nama_relawan, role,
           current_lat, current_lng, status_lokasi, check_in_time, last_seen_at
         )
         VALUES ($1, NULL, $2, $3, $4, $5, 'Active (Mobile)', NOW(), NOW())
         RETURNING *`,
        [activeEvent.id, nama_relawan.trim(), role, latNum, lngNum]
      );

      const newVolunteer = insertVolRes.rows[0];

      // Simpan log pertama ke tabel Location_Logs
      await pool.query(
        `INSERT INTO location_logs (
           id_volunteer, latitude, longitude, accuracy_meter,
           jarak_ke_pos_meter, status_lokasi, recorded_at
         )
         VALUES ($1, $2, $3, $4, NULL, 'Active (Mobile)', NOW())`,
        [newVolunteer.id, latNum, lngNum, accValue]
      );

      const enrichedVolunteer = await getEnrichedVolunteer(newVolunteer.id);

      // Pancarkan pembaruan relawan via Socket.IO ke Dashboard
      io.emit('volunteer_updated', enrichedVolunteer);

      return res.status(201).json({
        success: true,
        message: `Check-In Kesiapan Tugas berhasil! Status Anda kini Active (Mobile).`,
        volunteer: enrichedVolunteer,
        jarak_ke_pos_meter: null,
        accuracy_meter: accValue,
      });
    }

    // UC-02: Check-In Geofencing untuk Relawan Pos Statis (Water Station, Medis Pos, Marshal)
    if (!id_checkpoint) {
      return res.status(400).json({
        success: false,
        message: 'Titik Pos Tugas wajib dipilih untuk peran Relawan Pos Statis / Marshal.',
      });
    }

    const latNum = Number(latitude);
    const lngNum = Number(longitude);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({
        success: false,
        message: 'Koordinat GPS (latitude dan longitude) wajib disertakan untuk validasi Geofencing.',
      });
    }

    const cpRes = await pool.query('SELECT * FROM checkpoints WHERE id = $1 LIMIT 1', [
      Number(id_checkpoint),
    ]);
    const checkpoint = cpRes.rows[0];

    if (!checkpoint) {
      return res.status(404).json({
        success: false,
        message: 'Titik Pos Tugas (Checkpoint) tidak ditemukan.',
      });
    }

    // Hitung jarak Haversine d terhadap koordinat pos yang dipilih
    const distanceMeters = calculateHaversineDistance(
      latNum,
      lngNum,
      Number(checkpoint.latitude),
      Number(checkpoint.longitude)
    );

    // Ambang batas radius check-in berdiferensiasi:
    // Pos Utama (Water Station, Medis Pos) <= 50 m; Marshal <= 30 m
    const maxCheckinRadius = role === 'Marshal' ? 30 : 50;

    if (distanceMeters > maxCheckinRadius) {
      return res.status(400).json({
        success: false,
        code: 'OUTSIDE_GEOFENCE_CHECKIN',
        jarak_ke_pos_meter: Number(distanceMeters.toFixed(2)),
        batas_radius_meter: maxCheckinRadius,
        nama_pos: checkpoint.nama_pos,
        message: `Presensi Geofencing ditolak: Jarak Anda ke ${checkpoint.nama_pos} adalah ${distanceMeters.toFixed(
          1
        )} m, melebihi batas radius check-in peran ${role} (<= ${maxCheckinRadius} m). Silakan mendekat ke titik tugas.`,
      });
    }

    // Jarak memenuhi ambang peran -> terima menjadi Active dan catat check_in_time = NOW()
    const insertVolRes = await pool.query(
      `INSERT INTO volunteers (
         id_event, id_checkpoint, nama_relawan, role,
         current_lat, current_lng, status_lokasi, check_in_time, last_seen_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'Active', NOW(), NOW())
       RETURNING *`,
      [activeEvent.id, checkpoint.id, nama_relawan.trim(), role, latNum, lngNum]
    );

    const newVolunteer = insertVolRes.rows[0];

    // Rekam log pertama ke tabel Location_Logs
    await pool.query(
      `INSERT INTO location_logs (
         id_volunteer, latitude, longitude, accuracy_meter,
         jarak_ke_pos_meter, status_lokasi, recorded_at
       )
       VALUES ($1, $2, $3, $4, $5, 'Active', NOW())`,
      [newVolunteer.id, latNum, lngNum, accValue, Number(distanceMeters.toFixed(2))]
    );

    const enrichedVolunteer = await getEnrichedVolunteer(newVolunteer.id);

    // Pancarkan pembaruan relawan via Socket.IO ke Dashboard
    io.emit('volunteer_updated', enrichedVolunteer);

    return res.status(201).json({
      success: true,
      message: `Check-In Geofencing berhasil di ${checkpoint.nama_pos} (Jarak: ${distanceMeters.toFixed(
        1
      )} m <= ${maxCheckinRadius} m). Status: Active.`,
      volunteer: enrichedVolunteer,
      jarak_ke_pos_meter: Number(distanceMeters.toFixed(2)),
      accuracy_meter: accValue,
    });
  } catch (error) {
    console.error('[API POST /api/volunteers/checkin] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server saat memproses check-in relawan.',
      error: (error as Error).message,
    });
  }
});

/**
 * 5. POST /api/volunteers/poll (UC-04)
 * Periodic polling koordinat GPS setiap 60 detik:
 * - Menerima id_volunteer, latitude, longitude, accuracy_meter.
 * - Perbarui last_seen_at = NOW().
 * - Jika accuracy_meter > 50 m: abaikan perubahan status (pertahankan status sebelumnya agar tidak terjadi
 *   false out-of-area) namun tetap catat ke Location_Logs.
 * - Jika accuracy_meter <= 50 m: hitung ulang jarak Haversine d terhadap titik tugasnya:
 *   jika d <= radius_monitoring (100 m Pos Utama / 50 m Marshal) set status_lokasi = 'Active',
 *   jika melampaui batas set status_lokasi = 'Out of Area'.
 * - Rekam ke Location_Logs dan pancarkan ke Dashboard via Socket.IO.
 */
app.post('/api/volunteers/poll', async (req: Request, res: Response) => {
  try {
    const { id_volunteer, latitude, longitude, accuracy_meter, accuracy } = req.body || {};
    const volunteerId = Number(id_volunteer);
    const latNum = Number(latitude);
    const lngNum = Number(longitude);
    const rawAcc = accuracy_meter !== undefined ? accuracy_meter : accuracy;
    const accNum = rawAcc !== undefined && rawAcc !== null ? Number(rawAcc) : 10;

    if (!Number.isInteger(volunteerId) || volunteerId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'id_volunteer tidak valid.',
      });
    }

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum) || !Number.isFinite(accNum)) {
      return res.status(400).json({
        success: false,
        message: 'Data koordinat (latitude, longitude, accuracy_meter) tidak valid.',
      });
    }

    const currentVol = await getEnrichedVolunteer(volunteerId);
    if (!currentVol) {
      return res.status(404).json({
        success: false,
        message: 'Data relawan tidak ditemukan.',
      });
    }

    const isMobileRole = (MOBILE_ROLES as readonly string[]).includes(currentVol.role);

    // Hitung jarak Haversine ke pos tugas jika relawan memiliki pos statis
    let distanceToPost: number | null = null;
    if (
      currentVol.id_checkpoint &&
      currentVol.checkpoint_lat !== null &&
      currentVol.checkpoint_lng !== null
    ) {
      distanceToPost = Number(
        calculateHaversineDistance(
          latNum,
          lngNum,
          Number(currentVol.checkpoint_lat),
          Number(currentVol.checkpoint_lng)
        ).toFixed(2)
      );
    }

    // Kasus 1: Filter akurasi sensor -> jika accuracy_meter > 50 m, abaikan perubahan status
    // (pertahankan status sebelumnya guna mencegah false out-of-area), perbarui last_seen_at = NOW(),
    // dan tetap catat ke Location_Logs.
    if (accNum > 50) {
      const preservedStatus: string = currentVol.status_lokasi;

      await pool.query(
        `UPDATE volunteers
         SET last_seen_at = NOW()
         WHERE id = $1`,
        [volunteerId]
      );

      await pool.query(
        `INSERT INTO location_logs (
           id_volunteer, latitude, longitude, accuracy_meter,
           jarak_ke_pos_meter, status_lokasi, recorded_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [volunteerId, latNum, lngNum, accNum, distanceToPost, preservedStatus]
      );

      const updatedVolunteer = await getEnrichedVolunteer(volunteerId);
      io.emit('volunteer_updated', updatedVolunteer);

      return res.json({
        success: true,
        ignored_accuracy: true,
        message: `Pembacaan sensor diabaikan sementara karena akurasi (${accNum.toFixed(
          1
        )} m) > 50 m. Status dipertahankan: ${preservedStatus}.`,
        volunteer: updatedVolunteer,
        jarak_ke_pos_meter: distanceToPost,
        accuracy_meter: accNum,
      });
    }

    // Kasus 2: accuracy_meter <= 50 m -> evaluasi jarak Haversine terhadap radius_monitoring
    let nextStatus = currentVol.status_lokasi;

    if (isMobileRole || !currentVol.id_checkpoint) {
      nextStatus = 'Active (Mobile)';
    } else {
      const radiusMonitoring =
        currentVol.radius_monitoring !== null && currentVol.radius_monitoring !== undefined
          ? Number(currentVol.radius_monitoring)
          : currentVol.role === 'Marshal'
          ? 50
          : 100;

      if (distanceToPost !== null && distanceToPost <= radiusMonitoring) {
        nextStatus = 'Active';
      } else {
        nextStatus = 'Out of Area';
      }
    }

    await pool.query(
      `UPDATE volunteers
       SET current_lat = $1,
           current_lng = $2,
           status_lokasi = $3,
           last_seen_at = NOW()
       WHERE id = $4`,
      [latNum, lngNum, nextStatus, volunteerId]
    );

    await pool.query(
      `INSERT INTO location_logs (
         id_volunteer, latitude, longitude, accuracy_meter,
         jarak_ke_pos_meter, status_lokasi, recorded_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [volunteerId, latNum, lngNum, accNum, distanceToPost, nextStatus]
    );

    const updatedVolunteer = await getEnrichedVolunteer(volunteerId);
    io.emit('volunteer_updated', updatedVolunteer);

    return res.json({
      success: true,
      ignored_accuracy: false,
      message: `Lokasi berkala diperbarui. Status: ${nextStatus}.`,
      volunteer: updatedVolunteer,
      jarak_ke_pos_meter: distanceToPost,
      accuracy_meter: accNum,
    });
  } catch (error) {
    console.error('[API POST /api/volunteers/poll] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memproses pembaruan lokasi berkala relawan.',
      error: (error as Error).message,
    });
  }
});

// ============================================================================
// BACKGROUND INTERVAL TIAP 10 DETIK: EVALUASI BATAS WAKTU TUNGGU > 180 DETIK
// ============================================================================

export async function checkStaleVolunteers(): Promise<void> {
  try {
    // Periksa semua relawan Pos Statis/Marshal yang memiliki NOW() - last_seen_at > 180 seconds
    // dan status_lokasi != 'Unknown'
    const staleRes = await pool.query(
      `SELECT 
         v.*,
         cp.latitude AS cp_lat,
         cp.longitude AS cp_lng
       FROM volunteers v
       LEFT JOIN checkpoints cp ON v.id_checkpoint = cp.id
       WHERE v.role IN ('Water Station', 'Medis Pos', 'Marshal')
         AND v.last_seen_at IS NOT NULL
         AND EXTRACT(EPOCH FROM (NOW() - v.last_seen_at)) > 180
         AND v.status_lokasi != 'Unknown'`
    );

    if (staleRes.rowCount && staleRes.rowCount > 0) {
      for (const vol of staleRes.rows) {
        await pool.query(
          `UPDATE volunteers
           SET status_lokasi = 'Unknown'
           WHERE id = $1`,
          [vol.id]
        );

        const logLat =
          vol.current_lat !== null && vol.current_lat !== undefined
            ? Number(vol.current_lat)
            : Number(vol.cp_lat || -6.817893);
        const logLng =
          vol.current_lng !== null && vol.current_lng !== undefined
            ? Number(vol.current_lng)
            : Number(vol.cp_lng || 107.587672);

        let distanceToPost: number | null = null;
        if (vol.cp_lat !== null && vol.cp_lng !== null) {
          distanceToPost = Number(
            calculateHaversineDistance(
              logLat,
              logLng,
              Number(vol.cp_lat),
              Number(vol.cp_lng)
            ).toFixed(2)
          );
        }

        await pool.query(
          `INSERT INTO location_logs (
             id_volunteer, latitude, longitude, accuracy_meter,
             jarak_ke_pos_meter, status_lokasi, recorded_at
           )
           VALUES ($1, $2, $3, $4, $5, 'Unknown', NOW())`,
          [vol.id, logLat, logLng, 0, distanceToPost]
        );

        const updatedVolunteer = await getEnrichedVolunteer(vol.id);
        io.emit('volunteer_updated', updatedVolunteer);
      }
    }
  } catch (error) {
    console.error('[Background Interval 10s] Error memeriksa timeout relawan:', error);
  }
}

// ============================================================================
// ALUR 14 LANGKAH SEQUENCE DIAGRAM SOCKET.IO (BAGIAN 5 & GAMBAR 3)
// ============================================================================

interface SendAlertPayload {
  kategori?: string;
  kategori_insiden?: string;
  lat?: number;
  incident_lat?: number;
  lng?: number;
  incident_lng?: number;
  catatan?: string | null;
  id_pelapor: number;
  id_event?: number;
  client_timestamp?: number;
}

interface UpdateStatusPayload {
  incident_id?: number;
  id?: number;
  id_penangani?: number | null;
  status: 'Handled' | 'Resolved';
  client_timestamp?: number;
}

async function handleSendAlert(payload: SendAlertPayload) {
  const kategoriInsiden = (payload.kategori || payload.kategori_insiden || '').trim();
  const latNum = Number(payload.lat !== undefined ? payload.lat : payload.incident_lat);
  const lngNum = Number(payload.lng !== undefined ? payload.lng : payload.incident_lng);
  const idPelapor = Number(payload.id_pelapor);
  const catatan = payload.catatan ? String(payload.catatan).trim() : null;

  if (!kategoriInsiden) {
    throw new Error('Kategori insiden wajib dipilih.');
  }
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new Error('Koordinat lokasi insiden (lat, lng) tidak valid.');
  }
  if (!Number.isInteger(idPelapor) || idPelapor <= 0) {
    throw new Error('ID relawan pelapor (id_pelapor) tidak valid.');
  }

  // Ambil event aktif jika id_event tidak dikirim
  let eventId = payload.id_event ? Number(payload.id_event) : null;
  if (!eventId) {
    const evRes = await pool.query('SELECT id FROM events ORDER BY id ASC LIMIT 1');
    if (evRes.rowCount === 0) {
      throw new Error('Event aktif tidak ditemukan.');
    }
    eventId = evRes.rows[0].id;
  }

  // Langkah 3 Sequence Diagram: Hitung jarak Haversine terhadap seluruh baris di tabel Checkpoints
  // untuk menentukan pos acuan terdekat (id_checkpoint_terdekat dan jarak_pos_meter terkecil)
  const cpRes = await pool.query('SELECT * FROM checkpoints WHERE id_event = $1 ORDER BY id ASC', [
    eventId,
  ]);
  const checkpoints = cpRes.rows;

  if (checkpoints.length === 0) {
    throw new Error('Daftar Checkpoints kosong, tidak dapat menghitung pos terdekat.');
  }

  let nearestCheckpoint = checkpoints[0];
  let minDistance = calculateHaversineDistance(
    latNum,
    lngNum,
    Number(nearestCheckpoint.latitude),
    Number(nearestCheckpoint.longitude)
  );

  for (let i = 1; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    const dist = calculateHaversineDistance(
      latNum,
      lngNum,
      Number(cp.latitude),
      Number(cp.longitude)
    );
    if (dist < minDistance) {
      minDistance = dist;
      nearestCheckpoint = cp;
    }
  }

  const roundedMinDistance = Number(minDistance.toFixed(2));

  // Langkah 4 & 5 Sequence Diagram: INSERT INTO Incidents dengan status_insiden = 'New' dan created_at = NOW()
  const insertRes = await pool.query(
    `INSERT INTO incidents (
       id_event, id_pelapor, id_penangani, id_checkpoint_terdekat,
       kategori_insiden, catatan, incident_lat, incident_lng,
       jarak_pos_meter, status_insiden, created_at
     )
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, 'New', NOW())
     RETURNING id`,
    [
      eventId,
      idPelapor,
      nearestCheckpoint.id,
      kategoriInsiden,
      catatan,
      latNum,
      lngNum,
      roundedMinDistance,
    ]
  );

  const incidentId: number = insertRes.rows[0].id;
  const enrichedIncident = await getEnrichedIncident(incidentId);

  const broadcastPayload = {
    ...enrichedIncident,
    incident_id: incidentId,
    server_timestamp: Date.now(),
    client_timestamp: payload.client_timestamp || Date.now(),
  };

  // Langkah 6 Sequence Diagram: Pancarkan io.emit("new_incident", ...) ke Dashboard Monitoring & medis lapangan
  io.emit('new_incident', broadcastPayload);

  return broadcastPayload;
}

async function handleUpdateIncidentStatus(payload: UpdateStatusPayload) {
  const incidentId = Number(
    payload.incident_id !== undefined ? payload.incident_id : payload.id
  );
  const targetStatus = payload.status;

  if (!Number.isInteger(incidentId) || incidentId <= 0) {
    throw new Error('incident_id tidak valid.');
  }

  // Tahap 2 (Langkah 7–10): Status === 'Handled' & Penguncian Petugas Penangani
  if (targetStatus === 'Handled') {
    let handlerId: number | null =
      payload.id_penangani !== undefined && payload.id_penangani !== null
        ? Number(payload.id_penangani)
        : null;

    // Pastikan handlerId merujuk pada baris valid di tabel Volunteers agar kunci (id_penangani IS NOT NULL)
    // bekerja sesuai FK constraint sekalipun dipicu langsung oleh Koordinator dari Dashboard
    if (!handlerId || !Number.isInteger(handlerId) || handlerId <= 0) {
      const medVolRes = await pool.query(
        `SELECT id FROM volunteers
         WHERE role IN ('Tim Medis Mobile', 'Medis Pos')
         ORDER BY last_seen_at DESC NULLS LAST, id ASC
         LIMIT 1`
      );
      if (medVolRes.rowCount && medVolRes.rowCount > 0) {
        handlerId = medVolRes.rows[0].id;
      } else {
        const incRes = await pool.query('SELECT id_pelapor FROM incidents WHERE id = $1', [
          incidentId,
        ]);
        if (incRes.rowCount && incRes.rowCount > 0) {
          handlerId = incRes.rows[0].id_pelapor;
        }
      }
    }

    // Langkah 8 Sequence Diagram:
    // UPDATE Incidents SET status_insiden = 'Handled', id_penangani = $1, handled_at = NOW()
    // WHERE id = $2 AND id_penangani IS NULL RETURNING *
    const updateRes = await pool.query(
      `UPDATE incidents
       SET status_insiden = 'Handled',
           id_penangani = $1,
           handled_at = NOW()
       WHERE id = $2
         AND id_penangani IS NULL
       RETURNING *`,
      [handlerId, incidentId]
    );

    if (updateRes.rowCount === 0) {
      const existingIncident = await getEnrichedIncident(incidentId);
      const lockedBy = existingIncident?.nama_penangani || 'petugas lain';
      return {
        locked: true,
        incident: existingIncident,
        message: `Penanganan ditolak: Laporan insiden #${incidentId} sudah dikunci dan sedang ditangani oleh ${lockedBy}.`,
      };
    }

    const enrichedIncident = await getEnrichedIncident(incidentId);
    const broadcastPayload = {
      ...enrichedIncident,
      incident_id: incidentId,
      server_timestamp: Date.now(),
      client_timestamp: payload.client_timestamp || Date.now(),
    };

    // Langkah 9 & 10 Sequence Diagram: Pancarkan io.emit("status_updated", ...) dua arah
    io.emit('status_updated', broadcastPayload);

    return {
      locked: false,
      incident: broadcastPayload,
    };
  }

  // Tahap 3 (Langkah 11–14): Status === 'Resolved'
  if (targetStatus === 'Resolved') {
    // Langkah 12 Sequence Diagram:
    // UPDATE Incidents SET status_insiden = 'Resolved', resolved_at = NOW() WHERE id = $1 RETURNING *
    const updateRes = await pool.query(
      `UPDATE incidents
       SET status_insiden = 'Resolved',
           resolved_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [incidentId]
    );

    if (updateRes.rowCount === 0) {
      throw new Error(`Insiden dengan ID #${incidentId} tidak ditemukan.`);
    }

    const enrichedIncident = await getEnrichedIncident(incidentId);
    const broadcastPayload = {
      ...enrichedIncident,
      incident_id: incidentId,
      server_timestamp: Date.now(),
      client_timestamp: payload.client_timestamp || Date.now(),
    };

    // Langkah 13 & 14 Sequence Diagram: Pancarkan io.emit("status_updated", ...)
    io.emit('status_updated', broadcastPayload);

    return {
      locked: false,
      incident: broadcastPayload,
    };
  }

  throw new Error(`Status insiden "${targetStatus}" tidak dikenali.`);
}

// Endpoint REST pendamping untuk pengiriman dan pembaruan insiden (opsional/fallback selain Socket.IO)
app.post('/api/incidents', async (req: Request, res: Response) => {
  try {
    const incident = await handleSendAlert(req.body || {});
    return res.status(201).json({ success: true, incident });
  } catch (error) {
    return res.status(400).json({ success: false, message: (error as Error).message });
  }
});

app.patch('/api/incidents/:id/status', async (req: Request, res: Response) => {
  try {
    const result = await handleUpdateIncidentStatus({
      ...req.body,
      incident_id: Number(req.params.id),
    });
    if (result.locked) {
      return res.status(409).json({
        success: false,
        locked: true,
        message: result.message,
        incident: result.incident,
      });
    }
    return res.json({ success: true, incident: result.incident });
  } catch (error) {
    return res.status(400).json({ success: false, message: (error as Error).message });
  }
});

// Handler koneksi WebSocket (Socket.IO)
io.on('connection', (socket: Socket) => {
  console.log(`[Socket.IO] Klien terhubung: ${socket.id}`);

  // Langkah 2–6 Sequence Diagram: socket.on("send_alert", ...)
  socket.on(
    'send_alert',
    async (
      payload: SendAlertPayload,
      callback?: (response: {
        success: boolean;
        incident?: unknown;
        message?: string;
      }) => void
    ) => {
      try {
        const incident = await handleSendAlert(payload);
        if (typeof callback === 'function') {
          callback({ success: true, incident });
        }
      } catch (error) {
        console.error('[Socket.IO send_alert] Error:', error);
        const errMsg = (error as Error).message;
        socket.emit('alert_error', { message: errMsg });
        if (typeof callback === 'function') {
          callback({ success: false, message: errMsg });
        }
      }
    }
  );

  // Langkah 7–14 Sequence Diagram: socket.on("update_status", ...)
  socket.on(
    'update_status',
    async (
      payload: UpdateStatusPayload,
      callback?: (response: {
        success: boolean;
        locked?: boolean;
        incident?: unknown;
        message?: string;
      }) => void
    ) => {
      try {
        const result = await handleUpdateIncidentStatus(payload);
        if (result.locked) {
          socket.emit('status_update_rejected', {
            incident_id: payload.incident_id ?? payload.id,
            message: result.message,
            incident: result.incident,
          });
          if (typeof callback === 'function') {
            callback({
              success: false,
              locked: true,
              message: result.message,
              incident: result.incident,
            });
          }
          return;
        }

        if (typeof callback === 'function') {
          callback({ success: true, locked: false, incident: result.incident });
        }
      } catch (error) {
        console.error('[Socket.IO update_status] Error:', error);
        const errMsg = (error as Error).message;
        socket.emit('status_update_rejected', {
          incident_id: payload?.incident_id ?? payload?.id,
          message: errMsg,
        });
        if (typeof callback === 'function') {
          callback({ success: false, message: errMsg });
        }
      }
    }
  );

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Klien terputus: ${socket.id}`);
  });
});

const PORT = Number(process.env.PORT) || 3001;
let staleCheckTimer: NodeJS.Timeout | null = null;

export async function startServer() {
  await initDatabase();

  // Jalankan background interval setiap 10 detik untuk evaluasi timeout > 180 detik
  if (!staleCheckTimer) {
    staleCheckTimer = setInterval(() => {
      checkStaleVolunteers();
    }, 10000);
  }

  server.listen(PORT, () => {
    console.log(`[Server] Backend & Socket.IO berjalan di http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Server] Gagal menjalankan server:', err);
    process.exit(1);
  });
}

export { app, server };
