'use strict';

/* ---------------------------------------------------------------------------
 * Accesso utente (RBAC). Con CODEDB_RBAC spento sul server questo modulo non
 * fa nulla di visibile: l'handshake passa senza token e la schermata di login
 * non compare mai.
 *
 * Con RBAC acceso il server rifiuta l'handshake Socket.IO senza un token
 * valido (`connect_error` con messaggio "auth_required"): è quello l'unico
 * segnale che serve per mostrare il login, senza endpoint di stato dedicati.
 * ------------------------------------------------------------------------- */

import { socket, setToken, getToken } from './socket.js';
import { $, emit } from './utils.js';

let currentUser = null;

/** Utente autenticato (null finché non si è connessi). */
export function getCurrentUser() {
  return currentUser;
}

/** true se l'utente corrente possiede la capability indicata (fuori scope). */
export function hasCapability(cap) {
  return !!(currentUser && Array.isArray(currentUser.capabilities) && currentUser.capabilities.includes(cap));
}

function showLogin() {
  const overlay = $('#login-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const email = $('#login-email');
  if (email) email.focus();
}

function hideLogin() {
  const overlay = $('#login-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function showError(message) {
  const el = $('#login-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

async function login(email, password) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Risposta non valida dal server.' }));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Accesso non riuscito.');
  return data;
}

export async function logout() {
  const token = getToken();
  setToken('');
  currentUser = null;
  await fetch('/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => { /* la sessione locale è comunque già scartata */ });
  // Ricaricare è il modo più sicuro di ripulire lo stato dei tab aperti
  // (connessioni, griglie, cronologia) prima di un nuovo accesso.
  window.location.reload();
}

export function initAuth() {
  const form = $('#login-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#login-submit');
      const errorEl = $('#login-error');
      if (errorEl) errorEl.classList.add('hidden');
      if (btn) btn.disabled = true;
      try {
        const data = await login($('#login-email').value.trim(), $('#login-password').value);
        setToken(data.token || '');
        currentUser = data.user || null;
        $('#login-password').value = '';
        hideLogin();
        // L'errore di autenticazione dell'handshake è fatale per Socket.IO
        // (nessun retry automatico): la riconnessione va richiesta a mano.
        if (!socket.connected) socket.connect();
      } catch (err) {
        showError(err.message || 'Accesso non riuscito.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  const logoutBtn = $('#btn-logout');
  const dockLogout = $('#conn-dock-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', () => { logout(); });
  if (dockLogout) dockLogout.addEventListener('click', () => { logout(); });

  socket.on('connect_error', (err) => {
    if (err && err.message === 'auth_required') {
      setToken('');
      currentUser = null;
      showLogin();
    }
  });

  socket.on('connect', async () => {
    hideLogin();
    const res = await emit('auth:me', {}).catch(() => null);
    if (res && res.ok) {
      currentUser = res.user;
      const rbacActive = !!(res.user && res.user.rbac);
      const canManage = hasCapability('manage');

      if (logoutBtn) logoutBtn.classList.toggle('hidden', !rbacActive);
      if (dockLogout) dockLogout.classList.toggle('hidden', !rbacActive);

      const adminBtn = $('#btn-admin-rbac');
      const dockAdmin = $('#conn-dock-admin');
      if (adminBtn) adminBtn.classList.toggle('hidden', !rbacActive || !canManage);
      if (dockAdmin) dockAdmin.classList.toggle('hidden', !rbacActive || !canManage);
    }
  });
}
