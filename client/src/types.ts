export type VolunteerRole =
  | 'Water Station'
  | 'Medis Pos'
  | 'Marshal'
  | 'Pacer'
  | 'Tim Medis Mobile';

export type IncidentCategory =
  | 'Kram Otot / Spray'
  | 'Pelari Kolaps'
  | 'Peserta Tersesat'
  | 'Stok Air Menipis';

export type LocationStatus = 'Active' | 'Active (Mobile)' | 'Out of Area' | 'Unknown';

export type IncidentStatus = 'New' | 'Handled' | 'Resolved';

export interface EventData {
  id: number;
  nama_event: string;
  tanggal: string;
  pin_acara: string;
}

export interface Checkpoint {
  id: number;
  id_event: number;
  nama_pos: string;
  kilometer: number;
  latitude: number;
  longitude: number;
  radius_checkin: number;
  radius_monitoring: number;
}

export interface Volunteer {
  id: number;
  id_event: number;
  id_checkpoint: number | null;
  nama_relawan: string;
  role: VolunteerRole;
  current_lat: number | null;
  current_lng: number | null;
  status_lokasi: LocationStatus | string;
  check_in_time: string | null;
  last_seen_at: string | null;
  nama_pos?: string | null;
  checkpoint_kilometer?: number | null;
  checkpoint_lat?: number | null;
  checkpoint_lng?: number | null;
  radius_checkin?: number | null;
  radius_monitoring?: number | null;
}

export interface Incident {
  id: number;
  incident_id?: number;
  id_event: number;
  id_pelapor: number;
  id_penangani: number | null;
  id_checkpoint_terdekat: number;
  kategori_insiden: IncidentCategory | string;
  catatan: string | null;
  incident_lat: number;
  incident_lng: number;
  jarak_pos_meter: number;
  status_insiden: IncidentStatus;
  created_at: string;
  handled_at: string | null;
  resolved_at: string | null;
  nama_pelapor?: string | null;
  role_pelapor?: string | null;
  nama_penangani?: string | null;
  role_penangani?: string | null;
  nama_pos_terdekat?: string | null;
  kilometer_pos_terdekat?: number | null;
  durasi_tanggap_detik?: number | null;
  durasi_selesai_detik?: number | null;
  server_timestamp?: number;
  client_timestamp?: number;
}

