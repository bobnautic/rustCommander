import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/base.css';
import './styles/layout.css';
import './styles/panel.css';
import './styles/dialogs.css';
import './styles/dock.css';
import './styles/editor.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
