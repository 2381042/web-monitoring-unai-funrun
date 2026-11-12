import { io, Socket } from 'socket.io-client';

// Gunakan relative URL agar koneksi WebSocket & HTTP melewati proxy satu pintu Vite (port 5173 / Cloudflare Tunnel)
export const socket: Socket = io('/', {
  path: '/socket.io',
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

export const API_BASE_URL = '';
