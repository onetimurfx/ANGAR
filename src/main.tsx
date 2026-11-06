import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { initTelegram } from './lib/telegram'
import { BackendProvider } from './lib/backendContext'

initTelegram()

// BrowserRouter (not HashRouter): Telegram passes launch parameters in the URL hash, which a hash router would hijack.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <BackendProvider>
        <App />
      </BackendProvider>
    </BrowserRouter>
  </StrictMode>,
)
