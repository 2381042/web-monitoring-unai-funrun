-- Skema Basis Data PostgreSQL UNAI Fun Run 2026 (100% Sesuai Bagian 3 PROJECT_SPEC.md / Gambar 4 ERD)

-- 1. Tabel Events
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    nama_event VARCHAR(100) NOT NULL,
    tanggal DATE NOT NULL,
    pin_acara VARCHAR(20) NOT NULL
);

-- 2. Tabel Checkpoints (Relasi N:1 ke Events)
CREATE TABLE IF NOT EXISTS checkpoints (
    id SERIAL PRIMARY KEY,
    id_event INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    nama_pos VARCHAR(100) NOT NULL,
    kilometer FLOAT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    radius_checkin INT NOT NULL,
    radius_monitoring INT NOT NULL
);

-- 3. Tabel Volunteers (Relasi N:1 ke Events dan N:1 ke Checkpoints)
CREATE TABLE IF NOT EXISTS volunteers (
    id SERIAL PRIMARY KEY,
    id_event INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    id_checkpoint INT NULL REFERENCES checkpoints(id) ON DELETE SET NULL,
    nama_relawan VARCHAR(100) NOT NULL,
    role VARCHAR(50) NOT NULL,
    current_lat DOUBLE PRECISION NULL,
    current_lng DOUBLE PRECISION NULL,
    status_lokasi VARCHAR(20) NOT NULL,
    check_in_time TIMESTAMP NULL,
    last_seen_at TIMESTAMP NULL
);

-- 4. Tabel Location_Logs (Relasi N:1 ke Volunteers)
CREATE TABLE IF NOT EXISTS location_logs (
    id SERIAL PRIMARY KEY,
    id_volunteer INT NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    accuracy_meter FLOAT NOT NULL,
    jarak_ke_pos_meter FLOAT NULL,
    status_lokasi VARCHAR(20) NOT NULL,
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 5. Tabel Incidents (Relasi N:1 ke Events, N:1 ke Checkpoints, dan 2 kunci tamu N:1 ke Volunteers)
CREATE TABLE IF NOT EXISTS incidents (
    id SERIAL PRIMARY KEY,
    id_event INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    id_pelapor INT NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
    id_penangani INT NULL REFERENCES volunteers(id) ON DELETE SET NULL,
    id_checkpoint_terdekat INT NOT NULL REFERENCES checkpoints(id),
    kategori_insiden VARCHAR(50) NOT NULL,
    catatan TEXT NULL,
    incident_lat DOUBLE PRECISION NOT NULL,
    incident_lng DOUBLE PRECISION NOT NULL,
    jarak_pos_meter FLOAT NOT NULL,
    status_insiden VARCHAR(20) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    handled_at TIMESTAMP NULL,
    resolved_at TIMESTAMP NULL
);

