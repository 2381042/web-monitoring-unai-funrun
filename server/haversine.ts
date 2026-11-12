/**
 * Implementasi Rumus Haversine Formula (Persamaan 1–4 pada Subbab 2.2.A PROJECT_SPEC.md)
 * Menghitung jarak permukaan lengkung bumi antara dua titik koordinat GPS (latitude, longitude) dalam satuan meter.
 */

export const EARTH_RADIUS_METERS = 6371000;

/**
 * Persamaan (1): Konversi derajat desimal ke radian
 * rad = derajat * (Math.PI / 180)
 */
export function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Persamaan (2), (3), dan (4): Perhitungan jarak Haversine d (dalam meter)
 * @param lat1 Latitude titik 1 (derajat desimal)
 * @param lng1 Longitude titik 1 (derajat desimal)
 * @param lat2 Latitude titik 2 (derajat desimal)
 * @param lng2 Longitude titik 2 (derajat desimal)
 * @returns Jarak d dalam satuan meter
 */
export function calculateHaversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lng2 - lng1);

  // Persamaan (2): a = sin^2(Δφ / 2) + cos(φ1) * cos(φ2) * sin^2(Δλ / 2)
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * (Math.sin(deltaLambda / 2) ** 2);

  // Persamaan (3): c = 2 * atan2(sqrt(a), sqrt(1 - a))
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Persamaan (4): d = r * c (dalam meter)
  const d = EARTH_RADIUS_METERS * c;

  return d;
}

