/**
 * CodeDB — Cambio della passphrase del vault (voce "Cambia Passphrase" nel menu Impostazioni)
 *
 * Fino a ieri la passphrase si poteva solo SUBIRE: era la chiave stessa dei
 * segreti, quindi cambiarla significava ri-cifrare a mano l'intero
 * `connections.ini` (export con la nuova passphrase, sostituzione del file,
 * riavvio). Ora il vault usa la cifratura a busta (`db/vault.js`) e cambiarla
 * è un'operazione piccola e reversibile: si riavvolge la chiave dati.
 *
 * Il modulo fa poco di suo — la sostanza è lato server — ma si prende cura
 * delle tre cose che qui contano davvero:
 *
 *  · chiedere la passphrase ATTUALE anche a vault sbloccato (chi si siede a
 *    una sessione lasciata aperta non deve poter cambiare la chiave altrui);
 *  · dire prima, non dopo, che il primo cambio su un vault storico ri-cifra i
 *    segreti e crea una copia di sicurezza;
 *  · avvisare che non esiste recupero, e che dal prossimo avvio serve la
 *    passphrase nuova.
 */

import { $, emit, toast, conCaricamento } from './utils.js';

const MIN_LUNGHEZZA = 8;

function mostra(el, visibile) {
  if (el) el.classList.toggle('hidden', !visibile);
}

function errore(testo) {
  const el = $('#passphrase-error');
  if (!el) return;
  el.textContent = testo;
  mostra(el, !!testo);
}

function apriModale() {
  const overlay = $('#passphrase-overlay');
  if (!overlay) return;

  errore('');
  ['#passphrase-current', '#passphrase-next', '#passphrase-confirm'].forEach((sel) => {
    const el = $(sel);
    if (el) el.value = '';
  });

  // Lo stato del vault decide cosa mostrare: su un vault ancora nel formato
  // storico il primo cambio comporta una migrazione, e va detto prima.
  emit('vault:status', {})
    .then((res) => {
      if (res && res.locked) {
        toast('Il vault è bloccato: sbloccalo con la passphrase attuale prima di cambiarla.', true);
        overlay.classList.add('hidden');
        return;
      }
      mostra($('#passphrase-migration-note'), !!res && res.formato === 1);
      const attuale = $('#passphrase-current');
      if (attuale) {
        attuale.placeholder = res && res.protetto
          ? 'La passphrase con cui è aperto il vault'
          : 'Lascia vuoto: non ne è mai stata impostata una';
      }
    })
    .catch(() => { /* la modale funziona comunque */ });

  overlay.classList.remove('hidden');
  const primo = $('#passphrase-current');
  if (primo) primo.focus();
}

function chiudiModale() {
  const overlay = $('#passphrase-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function invia(e) {
  e.preventDefault();
  errore('');

  const current = $('#passphrase-current')?.value ?? '';
  const next = $('#passphrase-next')?.value ?? '';
  const confirm = $('#passphrase-confirm')?.value ?? '';

  if (next.length < MIN_LUNGHEZZA) {
    errore(`La nuova passphrase deve essere lunga almeno ${MIN_LUNGHEZZA} caratteri.`);
    return;
  }
  if (next !== confirm) {
    errore('Le due passphrase non coincidono.');
    return;
  }
  if (next === current) {
    errore('La nuova passphrase è identica a quella attuale.');
    return;
  }

  // Riavvolgere la DEK e riscrivere il vault non è istantaneo (scrypt è lento
  // di proposito), e questo è il pulsante da cui NON si deve poter partire due
  // volte: il secondo tentativo troverebbe la passphrase attuale già cambiata.
  const bottone = $('#passphrase-form')?.querySelector('button[type="submit"]');

  conCaricamento(bottone, () => emit('vault:setPassphrase', { current, next }), 'Cambio in corso…')
    .then((res) => {
      chiudiAvviso(false); // i segreti ora sono protetti davvero
      // A operazione riuscita la modale ha finito il suo lavoro e si chiude
      // subito: restare aperta quattro secondi davanti a un messaggio già letto
      // significa un pannello che non risponde più a niente in mezzo allo
      // schermo, e l'utente che ci clicca sopra per farlo sparire.
      chiudiModale();
      // L'avviso sul prossimo avvio è la cosa più importante dell'operazione e
      // NON deve andare perso con la modale: viaggia nel toast, la cui durata
      // cresce con la lunghezza del testo (vedi `toast` in utils.js), quindi
      // resta a schermo il tempo di leggerlo.
      const esito = res.migrated
        ? 'Vault migrato e passphrase impostata.'
        : 'Passphrase cambiata.';
      toast(`${esito} ${res.avviso || ''}`.trim());
    })
    .catch((err) => {
      errore((err && err.message) || 'Cambio passphrase non riuscito.');
    });
}

/* ---------------------------------------------------------------------------
 * Avviso "i segreti non sono protetti".
 *
 * Chi non ha mai impostato una passphrase ha i segreti cifrati con la CHIAVE
 * VUOTA: il file è illeggibile a occhio, quindi sembra al sicuro, ma chiunque
 * possa leggerlo lo decifra senza sapere nulla. È il caso peggiore — un rischio
 * che non si manifesta e che l'utente non ha modo di sospettare — e l'unica
 * risposta onesta è dirlo.
 *
 * Tre scelte per non trasformarlo in molestia: si mostra SOLO se ci sono
 * davvero segreti salvati (`vault:status` → `segreti`), non è modale (non
 * blocca nulla), e "Più tardi" lo mette a tacere per la sessione del browser —
 * non per sempre, perché il rischio resta finché resta la chiave vuota.
 * ------------------------------------------------------------------------- */

const CHIAVE_RIMANDO = 'codedb:vault-avviso-rimandato';

function chiudiAvviso(perLaSessione) {
  const box = $('#vault-hint');
  if (box) box.classList.add('hidden');
  if (perLaSessione) {
    try { sessionStorage.setItem(CHIAVE_RIMANDO, '1'); } catch { /* niente storage: pazienza */ }
  }
}

/**
 * Da chiamare quando il vault risulta SBLOCCATO (vedi `checkVaultStatus`).
 * Non interroga il server di suo: usa la risposta già ottenuta.
 */
export function valutaAvvisoVault(stato) {
  const box = $('#vault-hint');
  if (!box || !stato || stato.locked) return;
  if (stato.protetto || !stato.segreti) { box.classList.add('hidden'); return; }
  try {
    if (sessionStorage.getItem(CHIAVE_RIMANDO)) return;
  } catch { /* storage non disponibile: si mostra comunque */ }
  box.classList.remove('hidden');
}

/**
 * Adegua l'interfaccia a chi sta guardando: con RBAC attivo il cambio
 * passphrase e l'azzeramento del vault sono riservati all'amministratore
 * dell'INSTALLAZIONE, perché la chiave dei segreti è una sola per tutti i
 * tenant. Un comando offerto e poi rifiutato è peggio di un comando assente —
 * sembra un guasto — quindi si nasconde: la voce "Cambia Passphrase" nel menu
 * Impostazioni e il "Ho dimenticato la passphrase" della modale di sblocco.
 *
 * `amministrabile` assente (server più vecchio) vale "sì": nessuna installazione
 * esistente perde un comando per colpa di una risposta incompleta.
 */
export function applicaPermessiVault(stato) {
  const puo = !stato || stato.amministrabile !== false;
  $('#btn-change-passphrase')?.classList.toggle('hidden', !puo);
  $('#vault-forgot')?.classList.toggle('hidden', !puo);
}

export function initPassphrase() {
  const imposta = $('#vault-hint-set');
  const rimanda = $('#vault-hint-later');
  if (imposta) imposta.addEventListener('click', () => { chiudiAvviso(false); apriModale(); });
  if (rimanda) rimanda.addEventListener('click', () => chiudiAvviso(true));

  const apri = $('#btn-change-passphrase');
  const form = $('#passphrase-form');
  const annulla = $('#passphrase-cancel');
  const overlay = $('#passphrase-overlay');

  if (apri) {
    apri.addEventListener('click', () => apriModale()); // il menu lo chiude main.js
  }
  if (form) form.addEventListener('submit', invia);
  if (annulla) annulla.addEventListener('click', chiudiModale);
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) chiudiModale();
    });
  }
}
