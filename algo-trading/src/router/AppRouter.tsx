import { Navigate, Route, Routes } from 'react-router-dom'

import LoginPage from '../pages/LoginPage/LoginPage'
import RegisterPage from '../pages/RegisterPage/RegisterPage'
import ExpiryStrategyPage from '../pages/StrategiesPage/ExpiryStrategyPage'
import FiveMinBreakoutPage from '../pages/StrategiesPage/FiveMinBreakoutPage'
import IchimokuStrategyPage from '../pages/StrategiesPage/IchimokuStrategyPage'
import StrategiesPage from '../pages/StrategiesPage/StrategiesPage'
import ManualTradingPage from '../pages/StrategiesPage/ManualTradingPage'
import VwapSmmaPage from '../pages/StrategiesPage/VwapSmmaPage'
import HeikenashiPage from '../pages/StrategiesPage/HeikenashiPage'
import ModifiedHeikenashiPage from '../pages/StrategiesPage/ModifiedHeikenashiPage'
import DashboardPage from '../pages/DashboardPage/DashboardPage'
import TradesPage from '../pages/TradesPage/TradesPage'
import SearchPage from '../pages/SearchPage/SearchPage'
import DashboardLayout from '../components/Layout/DashboardLayout'
import ProtectedRoute from './ProtectedRoute'

import DynamicStrategyPage from '../pages/StrategiesPage/DynamicStrategyPage'

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Protected Routes Wrapper */}
      <Route element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/strategies" element={<StrategiesPage />} />
        <Route path="/strategies/manual-trading" element={<ManualTradingPage />} />
        <Route path="/strategies/ichimoku" element={<IchimokuStrategyPage />} />
        <Route path="/strategies/5-min-breakout" element={<FiveMinBreakoutPage />} />
        <Route path="/strategies/vwap-smma" element={<VwapSmmaPage />} />
        <Route path="/strategies/expiry" element={<ExpiryStrategyPage />} />
        <Route path="/strategies/heikenashi" element={<HeikenashiPage />} />
        <Route path="/strategies/modified-heikenashi" element={<ModifiedHeikenashiPage />} />
        <Route path="/strategies/plugin/:strategyId" element={<DynamicStrategyPage />} />
        <Route path="/trades" element={<TradesPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}
