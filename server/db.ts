import { Pool, Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_DB_URL = 'postgresql://postgres:postgres123@localhost:5432/funrun_db';
export const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DB_URL;

export const pool = new Pool({
  connectionString: DATABASE_URL,
});

export const query = (text: string, params?: unknown[]) => pool.query(text, params);

async function ensureDatabaseExists(): Promise<void> {
  try {
    const url = new URL(DATABASE_URL);
    const dbName = url.pathname.replace(/^\//, '') || 'funrun_db';
    const adminUrl = new URL(DATABASE_URL);
    adminUrl.pathname = '/postgres';

    const adminClient = new Client({ connectionString: adminUrl.toString() });
    await adminClient.connect();
    try {
      const res = await adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );
      if (res.rowCount === 0) {
        await adminClient.query(`CREATE DATABASE "${dbName}"`);
        console.log(`[DB] Database "${dbName}" berhasil dibuat.`);
      }
    } finally {
      await adminClient.end();
    }
  } catch (err) {
    // Jika database sudah ada atau user tidak punya akses ke postgres default db, lanjutkan koneksi langsung
    console.warn('[DB] Lewati pemeriksaan pembuatan database awal:', (err as Error).message);
  }
}

export async function initDatabase(): Promise<void> {
  await ensureDatabaseExists();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Baca dan jalankan schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    await client.query(schemaSql);
    console.log('[DB] Skema 5 tabel (events, checkpoints, volunteers, location_logs, incidents) siap.');

    // Cek apakah tabel events masih kosong
    const eventCountRes = await client.query('SELECT COUNT(*)::int AS count FROM events');
    const eventCount: number = eventCountRes.rows[0].count;

    let eventId: number;

    if (eventCount === 0) {
      const insertEventRes = await client.query(
        `INSERT INTO events (nama_event, tanggal, pin_acara)
         VALUES ($1, $2, $3)
         RETURNING id`,
        ['UNAI Fun Run 2026', '2026-11-29', '202601']
      );
      eventId = insertEventRes.rows[0].id;
      console.log(`[DB] Seed awal Event "UNAI Fun Run 2026" (ID: ${eventId}, PIN: 202601) berhasil dibuat.`);
    } else {
      const existingEventRes = await client.query('SELECT id FROM events ORDER BY id ASC LIMIT 1');
      eventId = existingEventRes.rows[0].id;
    }

    // Cek apakah tabel checkpoints masih kosong
    const checkpointCountRes = await client.query('SELECT COUNT(*)::int AS count FROM checkpoints');
    const checkpointCount: number = checkpointCountRes.rows[0].count;

    if (checkpointCount === 0) {
      const initialCheckpoints = [
        // 3 Pos Utama (Water Station dan Medis Pos): radius_checkin = 50, radius_monitoring = 100
        {
          nama_pos: 'Pos 1 (KM 3,31)',
          kilometer: 3.31,
          latitude: -6.817893,
          longitude: 107.587672,
          radius_checkin: 50,
          radius_monitoring: 100,
        },
        {
          nama_pos: 'Pos 2 (KM 5,61)',
          kilometer: 5.61,
          latitude: -6.815126,
          longitude: 107.575957,
          radius_checkin: 50,
          radius_monitoring: 100,
        },
        {
          nama_pos: 'Pos 3 (KM 7,03)',
          kilometer: 7.03,
          latitude: -6.802151,
          longitude: 107.579192,
          radius_checkin: 50,
          radius_monitoring: 100,
        },
        // 5 Titik Persimpangan Marshal: radius_checkin = 30, radius_monitoring = 50
        {
          nama_pos: 'Simpang Marshal 1 (KM 1,20)',
          kilometer: 1.20,
          latitude: -6.804189,
          longitude: 107.588176,
          radius_checkin: 30,
          radius_monitoring: 50,
        },
        {
          nama_pos: 'Simpang Marshal 2 (KM 2,50)',
          kilometer: 2.50,
          latitude: -6.818847,
          longitude: 107.586691,
          radius_checkin: 30,
          radius_monitoring: 50,
        },
        {
          nama_pos: 'Simpang Marshal 3 (KM 4,10)',
          kilometer: 4.10,
          latitude: -6.818416,
          longitude: 107.585828,
          radius_checkin: 30,
          radius_monitoring: 50,
        },
        {
          nama_pos: 'Simpang Marshal 4 (KM 6,10)',
          kilometer: 6.10,
          latitude: -6.821511,
          longitude: 107.580966,
          radius_checkin: 30,
          radius_monitoring: 50,
        },
        {
          nama_pos: 'Simpang Marshal 5 (KM 6,80)',
          kilometer: 6.80,
          latitude: -6.820536,
          longitude: 107.578028,
          radius_checkin: 30,
          radius_monitoring: 50,
        },
      ];

      for (const cp of initialCheckpoints) {
        await client.query(
          `INSERT INTO checkpoints (id_event, nama_pos, kilometer, latitude, longitude, radius_checkin, radius_monitoring)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            eventId,
            cp.nama_pos,
            cp.kilometer,
            cp.latitude,
            cp.longitude,
            cp.radius_checkin,
            cp.radius_monitoring,
          ]
        );
      }
      console.log('[DB] Seed awal 8 titik Checkpoints (3 Pos Utama & 5 Simpang Marshal) berhasil dimasukkan.');
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[DB] Gagal menginisialisasi database:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('[DB] Inisialisasi database selesai.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[DB] Error inisialisasi:', err);
      process.exit(1);
    });
}

