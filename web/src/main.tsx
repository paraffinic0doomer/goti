import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found in index.html.');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      {/* AuthProvider wires the API client to the session before any page
          renders, so the very first request already carries a token. */}
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
