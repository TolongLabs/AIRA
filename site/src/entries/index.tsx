import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles.css'
import DashboardPage from '@/pages/dashboard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DashboardPage />
  </StrictMode>
)
