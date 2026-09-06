'use strict';

/* ---------------------------------------------------------------------------
 * Schermata "Informazioni & Licenza" (menu Impostazioni).
 *
 * Quattro cose, in quest'ordine: versione installata, MANLEVA per esteso,
 * l'EULA (contratto con l'utente finale), la licenza AGPL-3.0 con il testo
 * completo consultabile qui dentro, e l'elenco delle librerie di terze parti
 * con le loro licenze.
 *
 * Nulla di questo è scritto nel client: arriva dall'evento `app:license`, che
 * legge `MANLEVA.md` ed `EULA.md` (le stesse sorgenti da cui si genera la
 * pagina di accettazione dell'installer NSIS) e le licenze dai loro
 * `package.json`. Un elenco scritto a mano nel frontend resterebbe indietro al
 * primo aggiornamento, dichiarando il falso proprio nella schermata che esiste
 * per dire il vero.
 * ------------------------------------------------------------------------- */

import { $, emit, esc, toast, conCaricamento } from './utils.js';

let dati = null;


/**
 * Voce "Controlla Aggiornamenti" nel menu Impostazioni.
 *
 * Compare SOLO se il server risponde che c'è un'installazione desktop da
 * aggiornare (`app:info` → `aggiornamenti: true`): nel browser, o con una
 * finestra Electron appoggiata a un server avviato a parte, non c'è nulla da
 * aggiornare e una voce che fallisce al clic sarebbe peggio di nessuna voce.
 *
 * Esiste perché il menu nativo di Electron — dove la voce c'è da sempre — è
 * nascosto da `autoHideMenuBar: true` e compare solo premendo Alt: per chi usa
 * l'applicazione, di fatto non esisteva.
 */
async function initAggiornamentiDesktop() {
  const btn = $('#btn-updates');
  if (!btn) return;

  let info;
  try {
    info = await emit('app:info');
  } catch {
    return; // server muto: nessuna voce, nessun errore mostrato
  }
  if (!info || !info.aggiornamenti) return;

  btn.classList.remove('hidden');
  btn.addEventListener('click', async () => {
    // La chiusura del menu la fa `initSettingsMenu` (main.js) su ogni clic a
    // una .menu-item, con la sua animazione: farla anche qui la salterebbe.
    try {
      // Il controllo interroga GitHub: dura, e l'esito arriva in un dialog
      // NATIVO che può metterci qualche secondo a comparire — nel frattempo
      // l'unica cosa a schermo è questa voce di menu.
      await conCaricamento(btn, () => emit('app:updates:check'), 'Controllo…');
      // Il resto avviene nei dialog NATIVI del processo principale: qui non
      // c'è altro da mostrare, e un toast in più coprirebbe la finestra che
      // sta per aprirsi.
    } catch (err) {
      toast(`Controllo aggiornamenti non riuscito: ${err.message}`, true);
    }
  });
}

export function initAbout() {
  initAggiornamentiDesktop();

  const btn = $('#btn-about');
  if (btn) {
    btn.addEventListener('click', () => apriAbout()); // il menu lo chiude main.js
  }

  const chiudi = $('#about-close');
  if (chiudi) chiudi.addEventListener('click', chiudiAbout);

  const overlay = $('#about-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) chiudiAbout(); });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const ov = $('#about-overlay');
    if (ov && !ov.classList.contains('hidden')) chiudiAbout();
  });
}

function chiudiAbout() {
  const ov = $('#about-overlay');
  if (ov) ov.classList.add('hidden');
}

export async function apriAbout() {
  const ov = $('#about-overlay');
  const corpo = $('#about-body');
  if (!ov || !corpo) return;

  ov.classList.remove('hidden');
  if (!dati) {
    corpo.innerHTML = '<p class="about-attesa">Lettura della licenza…</p>';
    try {
      dati = await emit('app:license');
    } catch (err) {
      corpo.innerHTML = `<p class="about-attesa">Impossibile leggere i dati di licenza: ${esc(err.message)}</p>`;
      return;
    }
  }
  disegna(corpo);
}

function disegna(corpo) {
  corpo.innerHTML = `
    <div class="about-intestazione">
      <img src="/codedb.png" alt="" class="about-logo" />
      <div>
        <h2>CodeDB${dati.version ? ` <span class="about-versione">${esc(dati.version)}</span>` : ''}</h2>
        <p class="about-sotto">
          Client multi-database per MongoDB, MySQL e PostgreSQL${dati.autore ? ` · ${esc(dati.autore)}` : ''}
        </p>
        <p class="about-sotto">Licenza <strong>${esc(dati.licenza)}</strong></p>
      </div>
    </div>

    <section class="about-sezione">
      ${markdownSemplice(dati.manleva || 'Manleva non disponibile in questa copia.')}
    </section>

    <details class="about-dettaglio">
      <summary>Contratto di licenza con l'utente finale (EULA)</summary>
      <div class="about-eula">
        ${markdownSemplice(dati.eula || 'EULA non disponibile in questa copia.')}
      </div>
    </details>

    <details class="about-dettaglio">
      <summary>Testo completo della licenza (${esc(dati.licenza)})</summary>
      <pre class="about-licenza">${esc(dati.testoLicenza || 'Testo della licenza non disponibile in questa copia.')}</pre>
    </details>

    <details class="about-dettaglio">
      <summary>Librerie di terze parti (${dati.dipendenze.length})</summary>
      <table class="about-tabella">
        <thead><tr><th>Libreria</th><th>Versione</th><th>Licenza</th></tr></thead>
        <tbody>
          ${dati.dipendenze.map((d) => `
            <tr>
              <td>${esc(d.nome)}${d.nota ? `<em> — ${esc(d.nota)}</em>` : ''}</td>
              <td>${esc(d.versione || '—')}</td>
              <td>${esc(d.licenza || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="about-nota">Ogni libreria resta soggetta alla propria licenza; le copie complete
        sono nei rispettivi pacchetti.</p>
    </details>

    <div class="about-azioni">
      <button type="button" class="mini-btn" id="about-copia">Copia le informazioni</button>
    </div>
  `;

  const copia = $('#about-copia');
  if (copia) {
    copia.addEventListener('click', async () => {
      const testo = [
        `CodeDB ${dati.version || ''}`.trim(),
        `Licenza: ${dati.licenza}`,
        dati.repository ? `Repository: ${dati.repository}` : '',
        '',
        (dati.manleva || '').trim(),
      ].filter(Boolean).join('\n');
      try {
        await navigator.clipboard.writeText(testo);
        toast('Informazioni di licenza copiate.');
      } catch {
        toast('Copia non riuscita: il browser l\'ha negata.', true);
      }
    });
  }
}

/**
 * Il sottoinsieme di markdown effettivamente usato in `MANLEVA.md` ed
 * `EULA.md`: titoli, grassetto, codice inline, elenchi puntati e paragrafi.
 * Non è un parser generico — l'input non è arbitrario, è un file del progetto —
 * ma l'escape viene comunque prima di qualunque sostituzione, così un testo
 * modificato domani non può iniettare markup nella pagina.
 */
function markdownSemplice(md) {
  const html = esc(md)
    .replace(/\r\n?/g, '\n')
    .replace(/^#{2,}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^#\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  return html.split(/\n{2,}/).map((blocco) => {
    const testo = blocco.trim();
    if (/^<h\d/.test(testo)) return blocco;
    // Elenco puntato: gli `- ` a inizio riga aprono una voce, le righe
    // rientrate sotto una voce ne sono la continuazione (l'EULA manda a capo a
    // 79 colonne, quindi quasi ogni voce occupa più righe).
    if (/^-\s+/.test(testo)) {
      const voci = testo.split(/\n(?=-\s+)/).map((v) => v.replace(/^-\s+/, '').replace(/\s*\n\s*/g, ' '));
      return `<ul>${voci.map((v) => `<li>${v}</li>`).join('')}</ul>`;
    }
    return `<p>${blocco.replace(/\n/g, ' ')}</p>`;
  }).join('');
}
