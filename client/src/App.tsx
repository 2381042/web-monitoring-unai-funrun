import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import VolunteerPortal from './pages/VolunteerPortal';
import CoordinatorDashboard from './pages/CoordinatorDashboard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/relawan" replace />} />
        <Route path="/relawan" element={<VolunteerPortal />} />
        <Route path="/dashboard" element={<CoordinatorDashboard />} />
        <Route path="*" element={<Navigate to="/relawan" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
