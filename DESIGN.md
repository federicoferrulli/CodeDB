---
name: CodeDB
description: Ambiente operativo compatto per query e modifica intensiva dei dati.
colors:
  accent: "#585aee"
  accent-fg: "#818cf8"
  accent-2: "#4f46e5"
  accent-soft: "rgba(99, 102, 241, 0.12)"
  on-accent: "#ffffff"
  bg: "#0d1117"
  bg-2: "#090d12"
  bg-1: "#0b0f14"
  bg-surface: "#161b22"
  bg-elevated: "#1f2937"
  bg-4: "#1a2236"
  fg: "#e2e8f0"
  fg-dim: "#8892a4"
  border: "rgba(255, 255, 255, 0.07)"
  border-3: "rgba(255, 255, 255, 0.18)"
  danger: "#f87171"
  success: "#86efac"
  warning: "#fbbf24"
  info: "#60a5fa"
  light-accent: "#4f46e5"
  light-accent-fg: "#4f46e5"
  light-accent-2: "#4338ca"
  light-accent-soft: "rgba(79, 70, 229, 0.10)"
  light-on-accent: "#ffffff"
  light-bg: "#ffffff"
  light-bg-2: "#f2f5f9"
  light-bg-1: "#f4f7fa"
  light-bg-surface: "#ffffff"
  light-bg-elevated: "#ffffff"
  light-bg-4: "#e2e8f0"
  light-fg: "#1f2937"
  light-fg-dim: "#5b6673"
  light-border: "rgba(15, 23, 42, 0.10)"
  light-border-3: "rgba(15, 23, 42, 0.22)"
  light-danger: "#c92a2a"
  light-success: "#12805c"
  light-warning: "#96601a"
  light-info: "#0b62d0"
typography:
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  headline-mobile:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 500
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
  control:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  code:
    fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace"
    fontSize: "15px"
    lineHeight: 1.6
    letterSpacing: "0px"
  data:
    fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace"
    fontSize: "13px"
    lineHeight: 1.4
rounded:
  sm: "4px"
  control: "6px"
  panel: "10px"
  surface: "12px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.fg-dim}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  view-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
    height: "32px"
  statistic-panel:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.fg}"
    rounded: "{rounded.panel}"
    padding: "12px"
  dialog:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.surface}"
    padding: "24px"
---

# Design System: CodeDB

## Overview

**Creative North Star: "L'ambiente operativo CodeDB"**

CodeDB è un banco di lavoro per query ed editing intensivo: denso nei dati, leggibile nei form, sobrio nelle superfici. Connessione, tabella e vista mantengono identità distinte mentre codice e risultati occupano il centro. L'indaco segnala azioni e selezione; Inter e JetBrains Mono separano comandi e contenuto tecnico.

La direzione deriva dall'identità e dall'uso indicati da Keus in [PRODUCT.md](PRODUCT.md), non da un nuovo concept. Card decorative e composizioni da sito marketing non appartengono al workspace. Le superfici funzionali, le finestre e i riepiloghi esistenti restano parte del sistema.

Questa documentazione è una scansione dell'implementazione. Le fonti sono [tokens.css](public/css/tokens.css), [base.css](public/css/base.css), [arc-theme.css](public/css/arc-theme.css), [workbench.css](public/css/workbench.css), [style.css](public/css/style.css) e i [componenti Arc](ui/components/arc). La foundation Arc viene caricata prima del tema CodeDB: i suoi valori sovrascritti non sono regole dell'applicazione. Il contratto di direzione è nel `body` di [index.html](public/index.html); non è stato prodotto un seed o un comp approvato separatamente.

**Key Characteristics:**

- Superfici neutre e indaco funzionale.
- Densità compatta senza ridurre la radice tipografica.
- Codice e dati monospaziati, comandi in Inter.
- Temi chiaro, scuro e personalizzati sullo stesso sistema di ruoli.
- Focus visibile e controlli adattati a tastiera e touch.

## Colors

La palette accosta un indaco netto a neutri freddi: profondi nel tema scuro, chiari e leggibili nel tema chiaro.

### Primary

- **Indaco operativo** (`accent`): riempimento delle azioni primarie e dei controlli selezionati; il testo usa `on-accent`.
- **Indaco di lettura** (`accent-fg`): testo, icone e focus; resta distinto dal riempimento, soprattutto sullo scuro.
- **Indaco profondo** (`accent-2`): stato di enfasi dei controlli DOM; il bridge Arc lo espone come `accent-strong`.
- **Velo indaco** (`accent-soft`): selezioni e viste attive, senza colorare l'intera cornice del workspace.

### Neutral

- **Piano di lavoro** (`bg`) e **piano incassato** (`bg-1`): contenuto e codice/output.
- **Cornice di navigazione** (`bg-2`): barre delle connessioni e regioni laterali.
- **Superficie dei controlli** (`bg-surface`): campi, intestazioni e finestre.
- **Superficie sovrapposta** (`bg-elevated`) e **superficie di interazione** (`bg-4`): menu, livelli temporanei e hover.
- **Testo principale** (`fg`), **testo secondario** (`fg-dim`) e **bordi** (`border`, `border-3`): gerarchia senza nuove tinte decorative.

I token senza prefisso nel frontmatter rappresentano il tema scuro; `light-` riporta lo stesso ruolo nel tema chiaro. Il prefisso è documentale: nel CSS i nomi rimangono identici e cambia `data-theme`. I componenti del frontmatter illustrano la base scura; i componenti reali e gli esempi del sidecar leggono le variabili del tema attivo. [theme.js](public/js/theme.js) applica i temi personalizzati come scarti su una base chiara o scura. La preferenza automatica segue il sistema operativo; in assenza di una selezione CSS valida resta la base scura.

I colori semantici `danger`, `success`, `warning` e `info` comunicano esiti e avvisi. Le famiglie per stato, sintassi dell'editor, nodi JSON, tipi delle celle e motori database hanno significati propri: non sono accenti di marca aggiuntivi e non vanno fuse. Grafici, mappe e grafi conservano la propria codifica informativa.

Le rampe a otto passi nel sidecar sono anteprime OKLCH sintetiche per il pannello, non palette aggiuntive adottate dall'applicazione.

**The Colore per funzione Rule.** Usa i token del ruolo e del tema: non sostituire il testo d'accento con il colore di riempimento e non cablare nuove tinte nelle superfici comuni.

## Typography

**Body Font:** Inter, con fallback di sistema definiti nel frontmatter.
**Label/Mono Font:** Inter per etichette; JetBrains Mono, Fira Code e Consolas per codice e valori tecnici.

**Character:** una coppia da strumento operativo, con titoli contenuti e differenze di peso moderate. Non è prevista una tipografia display da apertura marketing.

### Hierarchy

- **Headline:** titoli delle finestre; su mobile passa al ruolo `headline-mobile`.
- **Title:** titoli delle sezioni e degli stati vuoti. Il marchio usa un peso maggiore (600).
- **Body:** testo dell'interfaccia; suggerimenti lunghi nei form usano un'interlinea più aperta e una lunghezza massima (75ch).
- **Label:** metadati, intestazioni della griglia, toolbar, schede e suggerimenti brevi.
- **Control:** pulsanti e azioni, con peso medio.
- **Code:** editor, evidenziazione e numeri di riga condividono le stesse metriche, anche su mobile.
- **Data:** valori delle griglie; cifre tabulari per colonne numeriche e metriche. Le intestazioni restano in Inter.

La scala applicata dal bridge è compatta (12, 13, 14, 16, 20px per i ruoli qui registrati). Il gradino da 24px è disponibile nel bridge ma non definisce una gerarchia ricorrente nelle viste rilevate. Il frontmatter conserva solo i ruoli effettivamente usati.

**The Densità leggibile Rule.** La radice resta a 16px. Ottieni compattezza con righe, padding e disposizione, senza ridurre lo zoom globale o disallineare i livelli dell'editor.

## Layout

Il workspace occupa il viewport e assegna lo scorrimento alle regioni operative. La navigazione è laterale; schede di connessione, schede di tabella e selettore di vista formano livelli distinti. La testata è compatta (48px). Le due sidebar principali partono da 208px e scendono a 184px fra 901 e 1100px; lo Schema Browser delle query parte da 184px, passa a 160px nello stesso intervallo ed è richiudibile su desktop. Queste misure descrivono la shell attuale, non una griglia obbligatoria per ogni nuova finestra.

La scala di spaziatura nel frontmatter ordina distanza fra icone, gruppi, righe di form e margini delle finestre. Arc usa anche alias numerici in rem: con la radice invariata, 2/3/4/6 corrispondono a `sm`/`md`/`lg`/`xl`. Le toolbar stanno accanto al contenuto comandato; le azioni delle finestre chiudono il form, separate da un bordo.

Le righe dei dati hanno una sorgente condivisa con il motore virtuale (`--grid-row-h`: 32px). Con puntatore grossolano oppure viewport fino a 600px diventano 48px; i controlli piccoli e medi passano a un minimo di 44px. Su desktop i controlli usano altezze minime di 32, 36 e 44px secondo il contesto; le altezze dei componenti nel frontmatter descrivono la taglia media, non un limite al contenuto.

Fino a 900px la shell adotta la navigazione mobile. La toolbar Dati dispone filtro, ordinamento e azioni in una griglia su più righe; la toolbar Query manda a capo bersaglio, esecuzione e metriche. Il pulsante di esecuzione resta visibile. Le finestre riducono il padding e i titoli; fino a 600px l'editor del tema porta i controlli sotto le rispettive etichette. Codice e tabelle possono scorrere orizzontalmente senza comprimere i valori.

**Contesto vicino.** Mantieni bersaglio, azione ed esito nel pannello che governano; quando lo spazio diminuisce, ricomponi i gruppi prima di ridurre la leggibilità.

## Elevation & Depth

La profondità ordinaria nasce da superfici tonali e bordi sottili. Testata, toolbar, navigazione mobile e riepiloghi non ricevono ombre ornamentali. Menu, palette dei comandi e finestre usano le ombre del tema per distinguersi dal contenuto sottostante; le modali aggiungono un velo. La superficie dei pulsanti rimane ferma all'hover.

### Shadow Vocabulary

- **Riposo:** `--shadow-resting` è nullo nel bridge CodeDB.
- **Sollevato:** `--shadow-raised` rimanda a `--shadow-md` del tema.
- **Fluttuante:** `--shadow-floating` rimanda a `--shadow-lg` del tema, usato per finestre e menu.

Le definizioni complete di ombre, transizioni e breakpoint sono nel [sidecar](.impeccable/design.json), fuori dallo schema dei token primitivi. Le transizioni brevi rispondono allo stato dei controlli; i componenti Arc conservano il proprio feedback di pressione. La preferenza di movimento ridotto abbrevia le transizioni e disattiva i movimenti non necessari.

**The Profondità di servizio Rule.** Usa l'elevazione per distinguere un livello temporaneo; non aggiungerla a ogni regione del workspace.

## Shapes

Gli angoli sono contenuti: `control` per pulsanti e campi, `panel` per menu e pannelli, `surface` per finestre. Il raggio `sm` serve alle etichette compatte dei valori. Bordi sottili e allineamenti definiscono le regioni; le impostazioni privilegiano righe separate, non una card per etichetta.

Le schede di connessione e tabella conservano il raccordo sagomato con il pannello: raggio e spalla condivisi (10px), fondo della scheda attiva uguale alla superficie di arrivo. Le forme circolari di indicatori, checkbox e controlli colore restano funzionali; non estendere il linguaggio delle pillole a ogni contenitore.

## Components

### Buttons

Azioni compatte con etichette riconoscibili e peso medio. Le varianti Arc sono `primary`, `secondary`, `ghost` e `danger`: riempimento indaco per l'azione principale; superficie neutra o trasparente per le altre; testo semantico per le azioni distruttive. Il padding e la taglia media sono nel frontmatter; le toolbar usano la taglia piccola.

L'hover dei pulsanti Arc usa opacità o superficie più evidente secondo la variante; i pulsanti DOM primari usano l'indaco profondo. Il focus visibile usa `--focus-ring`, derivato dall'accento di lettura, con contorno e distanza dal bordo (2px). I controlli disabilitati sono attenuati; il caricamento Arc mantiene il focus e impedisce una nuova attivazione. Le sole icone conservano un nome accessibile.

### Inputs / Fields

Campi neutri con bordo marcato, raggio `control`, etichetta e messaggio vicini. Hover e focus modificano il bordo; il focus da tastiera mantiene il contorno comune. Gli errori usano testo e bordo semantici; un placeholder non sostituisce l'etichetta. I selettori, calendari e controlli colore condividono token e geometria dei campi.

### Navigation

Connessioni, tabelle e viste restano riconoscibili senza intestazioni decorative. La selezione degli alberi usa un velo indaco e un segno laterale; la vista attiva usa velo e testo d'accento. Gli stati inattivi sono secondari, l'hover li rende più leggibili. Le schede dei documenti mantengono chiusura, nome e relazione visiva con il pannello. Su mobile la navigazione si adatta e offre bersagli touch adeguati.

### Chips

Le etichette compatte comunicano tipi ed esiti. I booleani associano testo esplicito, bordo e fondo semantico; il colore non sostituisce il valore. Badge database e indicatori di connessione mantengono le famiglie specifiche già definite nei token.

### Cards / Containers

I riepiloghi statistici e di stato sono contenitori funzionali con superficie neutra, bordo e nessuna ombra a riposo. Le impostazioni del tema, i gruppi backup e le serie dei grafici si ordinano in righe e sezioni. Non estrarre una card universale dalle eccezioni locali.

### Dialogs

Finestre con raggio `surface`, superficie del tema, bordo marcato e ombra fluttuante. Titolo, contenuto e azioni hanno una gerarchia distinta; i form hanno più spazio della griglia. I componenti Arc/Radix gestiscono focus e sovrapposizione entro gli overlay dell'app. Menu e selettori aperti rimangono sopra la finestra che li ospita.

### Workspace dati e query

L'unità caratteristica è il pannello operativo: contesto e comandi, editor o griglia, risultati e stato. Mantieni la riga condivisa con la virtualizzazione e le metriche comuni a textarea, evidenziazione e gutter. I canvas di Leaflet, ECharts, JointJS e Three.js conservano i propri motori; la cromatura intorno ad essi usa le stesse superfici delle altre viste. Gli stati vuoti spiegano il prossimo passo senza un involucro ornamentale.

I controlli riusano i componenti reali in `ui/components/arc`, con CSS Modules e isole React. I controller del workspace restano moduli ESM vanilla. Gli esempi HTML/CSS del sidecar sono anteprime autonome del linguaggio visivo, non sostituti dei componenti o dei loro comportamenti.

## Do's and Don'ts

### Do:

- **Do** usare i token CodeDB attraverso il bridge Arc anche nei temi personalizzati.
- **Do** distinguere accento di riempimento, accento di lettura e colori informativi.
- **Do** mantenere la radice a 16px e condividere l'altezza delle righe con la virtualizzazione.
- **Do** preservare focus visibile, etichette accessibili e movimento ridotto.
- **Do** ricomporre toolbar e form su schermi stretti mantenendo visibili bersaglio ed esecuzione.
- **Do** riusare i controlli Arc e la cromatura comune intorno ai motori specializzati.

### Don't:

- **Don't** introdurre card decorative o composizioni marketing nel workspace.
- **Don't** ripristinare i default della foundation Arc che il tema CodeDB sovrascrive.
- **Don't** fondere sintassi, tipi dei dati, stati e identità dei database in un'unica palette decorativa.
- **Don't** ridurre il testo o tagliare le azioni per far stare una toolbar su una sola riga.
- **Don't** alterare separatamente le metriche di editor, evidenziazione e numeri di riga.
- **Don't** trattare le rampe esplorative del sidecar o i valori locali non registrati come nuovi token dell'app.
