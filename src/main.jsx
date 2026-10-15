import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// Note: intentionally no StrictMode — its double-invoked mount effects
// interact badly with the cannon physics worker (duplicate bodies).
createRoot(document.getElementById('root')).render(<App />)
