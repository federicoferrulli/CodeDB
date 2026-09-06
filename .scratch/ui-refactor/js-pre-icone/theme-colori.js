/**
 * Strato PURO dei temi: dai colori scelti dall'utente all'insieme di token da
 * scrivere nel CSS. Nessun DOM, nessun `localStorage`, nessun import — come
 * `chart-option.js` e `cell-stats.js`, e per la stessa ragione: è la parte che
 * sbagliata non si rompe, MENTE. Un tema con il testo a un passo dallo sfondo
 * non lancia alcun errore, si apre normalmente e rende illeggibile mezza
 * interfaccia; un contrasto va quindi calcolato, non stimato a occhio, e va
 * provato in Node (`test/unit-tema.js`).
 *
 * Le due idee portanti:
 *
 *   1. Un tema personalizzato è un INSIEME DI SCARTI su una delle due palette
 *      di base, non una palette completa. Chi lo crea sceglie otto colori;
 *      tutti gli altri token — e sono più di cento — restano quelli del tema
 *      di base. Così un tema salvato oggi non si presenta "mezzo nudo" quando
 *      domani si aggiunge un token nuovo, che è esattamente il modo in cui
 *      questa funzione di solito marcisce.
 *
 *   2. Da ogni colore scelto si DERIVA la sua famiglia. Se l'utente sposta
 *      l'accento e restassero fissi il velo della selezione, il bordo di fuoco
 *      e l'alone, otterrebbe un'interfaccia indaco con un pulsante verde: il
 *      tema sembrerebbe rotto, e la colpa parrebbe sua.
 */

/* ==========================================================================
   Conversioni di colore
   ========================================================================== */

/** `#abc` / `#aabbcc` / `#aabbccdd` → `{r,g,b,a}` (0-255, alfa 0-1), o null. */
export function leggiHex(hex) {
  if (typeof hex !== 'string') return null;
  const s = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const dupl = (c) => parseInt(c + c, 16);
  if (s.length === 3) return { r: dupl(s[0]), g: dupl(s[1]), b: dupl(s[2]), a: 1 };
  if (s.length === 4) return { r: dupl(s[0]), g: dupl(s[1]), b: dupl(s[2]), a: dupl(s[3]) / 255 };
  if (s.length === 6) {
    return {
      r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16), a: 1,
    };
  }
  if (s.length === 8) {
    return {
      r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16), a: parseInt(s.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

const limita = (n, min, max) => Math.min(max, Math.max(min, n));
const arrotonda255 = (n) => limita(Math.round(n), 0, 255);

/** `{r,g,b}` → `#rrggbb`. L'alfa non entra: i token opachi restano esadecimali. */
export function scriviHex({ r, g, b }) {
  const due = (n) => arrotonda255(n).toString(16).padStart(2, '0');
  return `#${due(r)}${due(g)}${due(b)}`;
}

/** `{r,g,b}` + alfa → `rgba(…)`. L'alfa è arrotondata a tre decimali: senza,
 *  una derivazione produce `rgba(99, 102, 241, 0.12000000000000001)`. */
export function rgba({ r, g, b }, a) {
  const alfa = Math.round(limita(a, 0, 1) * 1000) / 1000;
  return `rgba(${arrotonda255(r)}, ${arrotonda255(g)}, ${arrotonda255(b)}, ${alfa})`;
}

/** RGB (0-255) → HSL (h 0-360, s/l 0-1). */
export function versoHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0));
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h * 60, s, l };
}

/** HSL → RGB (0-255). */
export function daHsl({ h, s, l }) {
  const H = ((h % 360) + 360) % 360 / 360;
  const S = limita(s, 0, 1), L = limita(l, 0, 1);
  if (S === 0) { const v = L * 255; return { r: v, g: v, b: v }; }
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const canale = (t) => {
    let T = t;
    if (T < 0) T += 1;
    if (T > 1) T -= 1;
    if (T < 1 / 6) return p + (q - p) * 6 * T;
    if (T < 1 / 2) return q;
    if (T < 2 / 3) return p + (q - p) * (2 / 3 - T) * 6;
    return p;
  };
  return { r: canale(H + 1 / 3) * 255, g: canale(H) * 255, b: canale(H - 1 / 3) * 255 };
}

/** Sposta la luminosità di `delta` (in punti di L, -1..1) mantenendo la tinta. */
export function schiarisci(colore, delta) {
  const hsl = versoHsl(colore);
  return daHsl({ ...hsl, l: limita(hsl.l + delta, 0, 1) });
}

/* ==========================================================================
   Contrasto (WCAG 2.1)
   ==========================================================================
   Serve all'editor per dire "questo testo non si legge" PRIMA che il tema
   venga salvato, e per scegliere da sé se il testo sopra un colore pieno vada
   nero o bianco. Il calcolo è quello della norma: canali linearizzati,
   luminanza relativa, rapporto (L1+0.05)/(L2+0.05).
*/

export function luminanza({ r, g, b }) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Rapporto di contrasto fra due colori opachi: da 1 (identici) a 21. */
export function contrasto(a, b) {
  const la = luminanza(a), lb = luminanza(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Nero o bianco: il testo da mettere SOPRA `sfondo`.
 *
 * Non è "quello che vince": sulle tinte sature di media luminosità i due sono
 * quasi pari — sull'indaco #6366f1 dell'accento predefinito il nero misura
 * 4,70:1 e il bianco 4,46:1 — e prendere il massimo secco farebbe comparire
 * scritte NERE sul pulsante primario di un tema personalizzato mentre tutta
 * l'applicazione le ha bianche. La differenza è invisibile in leggibilità e
 * molto visibile come incoerenza.
 *
 * Quindi: a parità sostanziale (entro il 10%) vince il bianco, che è la scelta
 * del prodotto; quando il nero è nettamente migliore — le tinte chiare, ambra
 * e verde acido su tutte — vince il nero. Il bianco non viene mai imposto dove
 * è davvero illeggibile, che è l'unica garanzia che conta.
 */
export const TOLLERANZA_BIANCO = 0.9;

export function testoSu(sfondo) {
  const nero = { r: 0, g: 0, b: 0 }, bianco = { r: 255, g: 255, b: 255 };
  const cn = contrasto(sfondo, nero), cb = contrasto(sfondo, bianco);
  if (cb >= cn) return bianco;
  return cb / cn >= TOLLERANZA_BIANCO ? bianco : nero;
}

/* ==========================================================================
   Derivazione delle famiglie
   ==========================================================================
   `CAMPI` è il contratto fra questo modulo e l'editor: l'elenco dei colori che
   l'utente sceglie davvero. L'interfaccia ci disegna sopra i suoi controlli
   invece di ripetere la stessa lista, che divergerebbe al primo campo nuovo.
*/

export const CAMPI = [
  { chiave: 'bg',      etichetta: 'Sfondo',      token: '--bg',      descrizione: 'Il piano su cui si legge tutto il resto' },
  { chiave: 'fg',      etichetta: 'Testo',       token: '--fg',      descrizione: 'Colore del testo principale' },
  { chiave: 'accent',  etichetta: 'Accento',     token: '--accent',  descrizione: 'Azioni primarie, selezione, fuoco' },
  { chiave: 'success', etichetta: 'Successo',    token: '--success', descrizione: 'Esiti riusciti' },
  { chiave: 'warning', etichetta: 'Avviso',      token: '--warning', descrizione: 'Attenzione, scritture' },
  { chiave: 'danger',  etichetta: 'Errore',      token: '--danger',  descrizione: 'Errori e azioni distruttive' },
  { chiave: 'info',    etichetta: 'Informazione', token: '--info',   descrizione: 'Note e messaggi neutri' },
];

/**
 * Da un colore semantico (verde, rosso, ambra, blu) alla sua terna
 * testo / velo di sfondo / bordo, più la famiglia `--status-*` che la griglia
 * e i badge usano come etichetta.
 */
function famigliaSemantica(prefisso, colore, chiaro) {
  // Il velo di sfondo pesa meno su fondo chiaro: la stessa alfa che su navy è
  // un'ombra di colore, sul bianco è una campitura.
  const aBg = chiaro ? 0.10 : 0.10;
  const aBd = 0.30;
  return {
    [`--${prefisso}`]: scriviHex(colore),
    [`--${prefisso}-bg`]: rgba(colore, aBg),
    [`--${prefisso}-line`]: rgba(colore, aBd),
  };
}

function famigliaStato(prefisso, colore, chiaro) {
  return {
    [`--status-${prefisso}`]: scriviHex(colore),
    [`--status-${prefisso}-bg`]: rgba(colore, chiaro ? 0.12 : 0.15),
    [`--status-${prefisso}-bd`]: rgba(colore, 0.30),
  };
}

/**
 * Cuore del modulo: dagli otto colori scelti all'oggetto `{token: valore}` da
 * scrivere nel CSS.
 *
 * `base` ('dark' | 'light') non è solo un'etichetta: decide il VERSO delle
 * velature neutre e delle ombre. Su un tema personalizzato scuro le velature
 * restano bianche, su uno chiaro diventano nere — sbagliare verso qui produce
 * bordi invisibili e hover che non si vedono, cioè il difetto che rende
 * inutilizzabile un tema fatto in casa.
 */
export function derivaTokens(scelte, base = 'dark') {
  const chiaro = base === 'light';
  const out = {};

  const bg = leggiHex(scelte.bg);
  const fg = leggiHex(scelte.fg);
  const accent = leggiHex(scelte.accent);

  /* ── Superfici ──
     Le sei superfici sono scostamenti di luminosità dallo sfondo scelto. Il
     verso dipende dalla base: su un tema scuro "sollevato" vuol dire più
     chiaro, su uno chiaro vuol dire più grigio. */
  if (bg) {
    const v = chiaro ? -1 : 1;                 // verso del "sollevamento"
    out['--bg'] = scriviHex(bg);
    out['--bg-2'] = scriviHex(schiarisci(bg, v * -0.02));
    out['--bg-3'] = scriviHex(schiarisci(bg, v * 0.025));
    out['--bg-4'] = scriviHex(schiarisci(bg, v * 0.06));
    out['--bg-surface'] = scriviHex(schiarisci(bg, v * 0.02));
    out['--bg-elevated'] = scriviHex(schiarisci(bg, v * 0.05));
    out['--bg-1'] = scriviHex(schiarisci(bg, v * -0.015));
    out['--tab-merge'] = scriviHex(bg);
    out['--graph-bg'] = scriviHex(schiarisci(bg, v * -0.015));
    out['--graph-label-bg'] = rgba(schiarisci(bg, v * 0.05), chiaro ? 0.92 : 0.85);
    out['--graph-label-fg'] = scriviHex(testoSu(schiarisci(bg, v * 0.05)));
    // Nel grafo 3D "spento" vuol dire quasi il fondo: si deriva da lì, non da
    // un grigio fisso che sul tema chiaro sarebbe il colore più scuro in scena.
    const velo = chiaro ? { r: 15, g: 23, b: 42 } : schiarisci(bg, 0.14);
    out['--graph-dim'] = rgba(velo, chiaro ? 0.13 : 0.25);
    out['--graph-dim-strong'] = rgba(velo, chiaro ? 0.10 : 0.20);
    out['--graph-dim-link'] = rgba(velo, chiaro ? 0.09 : 0.15);
    out['--graph-dim-link-weak'] = rgba(velo, chiaro ? 0.07 : 0.12);
    out['--chart-grid'] = rgba(chiaro ? { r: 15, g: 23, b: 42 } : { r: 255, g: 255, b: 255 }, chiaro ? 0.09 : 0.07);
    out['--chart-axis'] = rgba(chiaro ? { r: 15, g: 23, b: 42 } : { r: 255, g: 255, b: 255 }, chiaro ? 0.22 : 0.18);
    out['--geo-handle-outline'] = scriviHex(chiaro ? { r: 31, g: 41, b: 55 } : { r: 255, g: 255, b: 255 });
    // Il velo dietro le modali: dello stesso colore dello sfondo, molto scuro,
    // così la finestra non "galleggia" su una tinta estranea al tema.
    const scuro = schiarisci(bg, chiaro ? -0.55 : -0.03);
    out['--scrim'] = rgba(scuro, chiaro ? 0.36 : 0.75);
    out['--scrim-strong'] = rgba(scuro, chiaro ? 0.52 : 0.88);
    out['--glass-bg'] = rgba(schiarisci(bg, v * 0.01), chiaro ? 0.86 : 0.82);
  }

  /* ── Testo ──
     Secondario e disabilitato non sono grigi fissi: sono il testo scelto
     avvicinato allo sfondo, così un testo caldo mantiene la sua tinta anche
     nelle sfumature. */
  if (fg) {
    out['--fg'] = scriviHex(fg);
    const verso = chiaro ? 1 : -1;             // "sbiadire" = andare verso lo sfondo
    out['--fg-dim'] = scriviHex(schiarisci(fg, verso * 0.20));
    out['--fg-muted'] = scriviHex(schiarisci(fg, verso * 0.38));
    out['--fg-bright'] = scriviHex(schiarisci(fg, verso * -0.10));
  }

  /* ── Accento e tutto ciò che ne discende ── */
  if (accent) {
    out['--accent'] = scriviHex(accent);
    out['--accent-2'] = scriviHex(schiarisci(accent, -0.08));
    out['--accent-hover'] = scriviHex(schiarisci(accent, chiaro ? 0.08 : 0.10));
    out['--accent-violet'] = scriviHex(accent);
    out['--accent-glow'] = rgba(accent, 0.18);
    out['--accent-soft'] = rgba(accent, 0.12);
    out['--accent-line'] = rgba(accent, 0.30);
    out['--accent-veil'] = rgba(accent, 0.06);
    out['--sel'] = rgba(accent, 0.15);
    out['--focus'] = scriviHex(accent);
    out['--border-focus'] = scriviHex(accent);
    out['--shadow-glow-indigo'] = `0 0 20px ${rgba(accent, 0.35)}`;
    out['--scrollbar-thumb'] = rgba(accent, 0.25);
    out['--scrollbar-thumb-hover'] = rgba(accent, 0.5);
    out['--glow-1'] = rgba(accent, chiaro ? 0.05 : 0.045);
    out['--graph-link-active'] = scriviHex(accent);
    out['--graph-label-bd'] = scriviHex(accent);
    // Il testo sopra l'accento si CALCOLA: con un accento giallo il bianco
    // fisso sparisce, ed è il modo più facile di rendersi illeggibile un
    // pulsante primario senza accorgersene.
    out['--on-accent'] = scriviHex(testoSu(accent));
    out['--on-accent-soft'] = scriviHex(testoSu(schiarisci(accent, chiaro ? 0.08 : 0.10)));
  }

  /* ── Semantici ── */
  const sem = [
    ['success', 'ok'], ['warning', 'warn'], ['danger', 'err'], ['info', 'info'],
  ];
  for (const [nome, stato] of sem) {
    const c = leggiHex(scelte[nome]);
    if (!c) continue;
    Object.assign(out, famigliaSemantica(nome, c, chiaro));
    Object.assign(out, famigliaStato(stato, c, chiaro));
    if (nome === 'danger') {
      out['--err-fg'] = scriviHex(c);
      out['--status-err-veil'] = rgba(c, chiaro ? 0.055 : 0.06);
      out['--diff-del-bg'] = rgba(c, chiaro ? 0.14 : 0.2);
    }
    if (nome === 'success') {
      out['--ok'] = scriviHex(c);
      out['--diff-add-bg'] = rgba(c, chiaro ? 0.16 : 0.2);
      out['--shadow-glow-green'] = `0 0 16px ${rgba(c, 0.25)}`;
    }
    if (nome === 'warning') out['--diff-chg-bg'] = rgba(c, chiaro ? 0.16 : 0.2);
  }

  return out;
}

/* ==========================================================================
   Diagnosi di leggibilità
   ==========================================================================
   L'editor la mostra mentre si sceglie, non dopo aver salvato: un tema con il
   testo a 1,8:1 sullo sfondo si apre senza errori e rende inutilizzabile
   l'applicazione, e chi l'ha fatto non ha modo di sapere perché.
*/

/** Soglie WCAG 2.1: 4.5 per il testo normale, 3 per il testo grande e i segni. */
export const SOGLIA_TESTO = 4.5;
export const SOGLIA_SEGNI = 3;

export function diagnostica(scelte) {
  const avvisi = [];
  const bg = leggiHex(scelte.bg);
  if (!bg) return avvisi;

  const controlla = (chiave, etichetta, soglia) => {
    const c = leggiHex(scelte[chiave]);
    if (!c) return;
    const r = contrasto(c, bg);
    if (r < soglia) {
      avvisi.push({
        campo: chiave,
        rapporto: Math.round(r * 10) / 10,
        soglia,
        messaggio: `${etichetta}: contrasto ${(Math.round(r * 10) / 10).toFixed(1)}:1 sullo sfondo, sotto il minimo di ${soglia}:1. Il testo risulterà difficile da leggere.`,
      });
    }
  };

  controlla('fg', 'Testo', SOGLIA_TESTO);
  // Gli altri colorano soprattutto segni, bordi e badge: soglia più bassa.
  controlla('accent', 'Accento', SOGLIA_SEGNI);
  controlla('success', 'Successo', SOGLIA_SEGNI);
  controlla('warning', 'Avviso', SOGLIA_SEGNI);
  controlla('danger', 'Errore', SOGLIA_SEGNI);
  controlla('info', 'Informazione', SOGLIA_SEGNI);
  return avvisi;
}

/* ==========================================================================
   Temi salvati: forma, validazione, import/export
   ========================================================================== */

/** I due temi predefiniti, che non sono modificabili né cancellabili. */
export const TEMI_BASE = [
  { id: 'auto',  nome: 'Automatico', base: null,    predefinito: true },
  { id: 'dark',  nome: 'Scuro',      base: 'dark',  predefinito: true },
  { id: 'light', nome: 'Chiaro',     base: 'light', predefinito: true },
];

export function eBase(id) {
  return TEMI_BASE.some((t) => t.id === id);
}

/** Colori di partenza per un tema nuovo: quelli della palette di base. */
export function scelteIniziali(base = 'dark') {
  return base === 'light'
    ? { bg: '#ffffff', fg: '#1f2937', accent: '#4f46e5', success: '#12805c', warning: '#96601a', danger: '#c92a2a', info: '#0b62d0' }
    : { bg: '#0d1117', fg: '#e2e8f0', accent: '#6366f1', success: '#86efac', warning: '#fbbf24', danger: '#f87171', info: '#60a5fa' };
}

/**
 * Normalizza un tema che arriva da `localStorage` o da un file importato.
 * Restituisce `{ ok, tema, errore }` invece di lanciare: un tema corrotto non
 * deve impedire l'avvio dell'applicazione, deve solo non essere applicato.
 *
 * Cosa si controlla, e perché: l'`id` finisce in un selettore CSS e in un
 * attributo, quindi è ristretto a un insieme sicuro di caratteri — un id con
 * un apice chiuderebbe la stringa del selettore e trasformerebbe un tema
 * importato in codice iniettato nel foglio di stile; i colori sono ammessi
 * SOLO in forma esadecimale, per la stessa ragione (`red; } :root{…` sarebbe
 * un valore CSS valido da scrivere).
 */
export function validaTema(grezzo) {
  if (!grezzo || typeof grezzo !== 'object') return { ok: false, errore: 'Non è un oggetto tema.' };
  const id = String(grezzo.id || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    return { ok: false, errore: 'Identificativo del tema non valido (ammessi lettere, cifre, - e _).' };
  }
  if (eBase(id)) return { ok: false, errore: `"${id}" è un tema predefinito e non può essere sovrascritto.` };

  const nome = String(grezzo.nome || '').trim().slice(0, 60) || id;
  const base = grezzo.base === 'light' ? 'light' : 'dark';

  const scelte = {};
  const attese = CAMPI.map((c) => c.chiave);
  const partenza = scelteIniziali(base);
  for (const chiave of attese) {
    const v = grezzo.scelte && grezzo.scelte[chiave];
    if (v === undefined || v === null || v === '') { scelte[chiave] = partenza[chiave]; continue; }
    if (!leggiHex(v)) return { ok: false, errore: `Colore non valido per "${chiave}": ${String(v).slice(0, 40)}` };
    scelte[chiave] = scriviHex(leggiHex(v));
  }

  return { ok: true, tema: { id, nome, base, scelte } };
}

/** Il CSS di un tema personalizzato: una sola regola, valori già validati. */
export function cssDelTema(tema) {
  const tokens = derivaTokens(tema.scelte, tema.base);
  const righe = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`);
  return `:root[data-theme-custom="${tema.id}"] {\n${righe.join('\n')}\n}`;
}

/** Nome file suggerito per l'esportazione. */
export function nomeFile(tema) {
  const pulito = String(tema.nome || tema.id).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tema';
  return `codedb-tema-${pulito}.json`;
}
