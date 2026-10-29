import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { LanguageProvider } from './i18n.jsx'
import './index.css'

// Apply the persisted theme before first paint to avoid a light-to-dark flash.
const savedTheme = localStorage.getItem('netanim-web-theme')
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
document.documentElement.dataset.theme = (savedTheme ?? (prefersDark ? 'dark' : 'light')) === 'dark' ? 'dark' : 'light'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
)
