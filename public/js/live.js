import { state } from './state.js';
import { socket } from './socket.js';
import { $, emit } from './utils.js';
import { runQuery } from './grid.js';

export function togglePolling() {
  const isEnabled = $('#polling-checkbox').checked;
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
  if (isEnabled) {
    state.pollingInterval = setInterval(() => {
      if (document.hidden) return;
      if (document.querySelector('.editing')) return;
      if (!$('#editdoc-overlay').classList.contains('hidden')) return;
      if (!$('#insert-overlay').classList.contains('hidden')) return;
      runQuery();
    }, 5000);
  }
}

export function startWatch() {
  $('#polling-toggle').classList.add('hidden');
  $('#polling-checkbox').checked = false;
  togglePolling();
  emit('collection:watch', { db: state.db, coll: state.coll }).then(() => {
    $('#live-badge').classList.remove('hidden');
  }).catch(() => {
    // If it throws an error or watch is unavailable, it will be handled by the unavailable listener.
  });
}

export function initLive() {
  $('#polling-checkbox').addEventListener('change', togglePolling);

  socket.on('collection:changed', (change) => {
    if (change.db !== state.db || change.coll !== state.coll) return;
    clearTimeout(state.liveTimer);
    state.liveTimer = setTimeout(runQuery, 300);
  });

  socket.on('watch:unavailable', () => {
    $('#live-badge').classList.add('hidden');
    $('#polling-toggle').classList.remove('hidden');
  });
}
