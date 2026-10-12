---
name: CodeDB
description: Ambiente operativo compatto per query e modifica intensiva dei dati.
colors:
  accent: "#585aee"
  accent-fg: "#818cf8"
  accent-2: "#4f46e5"
  accent-soft: "rgba(99, 102, 241, 0.12)"
  on-accent: "#ffffff"
  bg: "#121419"
  bg-2: "#17191f"
  bg-1: "#101217"
  bg-surface: "#1b1e25"
  bg-elevated: "#252932"
  bg-4: "#272b35"
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
  column-header:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
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
  panel: "6px"
  surface: "8px"
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
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.fg-dim}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "32px"
  input:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  view-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
    height: "28px"
  column-header:
    textColor: "{colors.fg}"
    typography: "{typography.column-header}"
    height: "36px"
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
  navigation-sheet:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.fg}"
    rounded: "{rounded.panel}"
    width: "min(100%, 36rem)"
---

# Design System: CodeDB

## Overview

**Creative North Star: "L'ambiente operativo CodeDB"**

CodeDB è un banco di lavoro per query ed editing intensivo: denso nei dati, leggibile nei form, sobrio nelle superfici. Connessione, database o schema e documento aperto mantengono identità distinte mentre codice e risultati occupano il centro. Ogni pannello affiancato mostra il proprio contesto. L'indaco segnala azioni e selezione; Inter e JetBrains Mono separano comandi e contenuto tecnico.

La direzione deriva dall'identità e dall'uso indicati da Keus in [PRODUCT.md](PRODUCT.md), non da un nuovo concept. Card decorative e composizioni da sito marketing non appartengono al workspace. Le superfici funzionali, le finestre e i riepiloghi esistenti restano parte del sistema.

Questa documentazione è una scansione dell'implementazione. Le fonti sono [tokens.css](public/css/tokens.css), [base.css](public/css/base.css), [arc-theme.css](public/css/arc-theme.css), [workbench.css](public/css/workbench.css), [style.css](public/css/style.css) e i [componenti Arc](ui/components/arc). La foundation Arc viene caricata prima del tema CodeDB: i suoi valori sovrascritti non sono regole dell'applicazione. Il contratto di direzione è nel `body` di [index.html](public/index.html); non è stato prodotto un seed o un comp approvato separatamente.

Le regole descrivono il sistema nel codice; copertura dei flussi, prove e limiti sono nella matrice di [revisione grafica](docs/revisione-grafica.md). Questa descrizione non certifica la conformità WCAG né sostituisce le verifiche nei contenitori nativi.

**Key Characteristics:**

- Superfici neutre e indaco funzionale.
- Densità compatta senza ridurre la radice tipografica.
- Codice e dati monospaziati, comandi in Inter.
- Contesto esplicito in ogni pannello, bordo superiore e stato accessibile del pannello attivo.
- Connessioni salvate, sessioni, documenti e viste riconoscibili come livelli distinti.
- Un navigatore desktop a sezioni; gli stessi alberi nei pannelli di navigazione mobile.
- Strumenti sotto l'esploratore, ancorato al fondo del navigatore anche quando le sezioni sono collassate.
- Intestazioni leggibili e colonne ridimensionabili senza cambiare i dati.
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

I booleani usano la stessa famiglia viola per `true` e `false`, con fondo e bordo neutri: è il testo a distinguere il valore. `false`, zero e `NULL` non rappresentano un errore. Le celle distinguono esplicitamente `NULL`, campo `mancante` e stringa vuota (`""`); non usare lo stile disabilitato per nascondere questa informazione.

Le rampe a otto passi nel sidecar sono anteprime OKLCH sintetiche per il pannello, non palette aggiuntive adottate dall'applicazione.

**The Colore per funzione Rule.** Usa i token del ruolo e del tema: non sostituire il testo d'accento con il colore di riempimento e non cablare nuove tinte nelle superfici comuni.

## Typography

**Body Font:** Inter, con fallback di sistema definiti nel frontmatter.
**Label/Mono Font:** Inter per etichette; JetBrains Mono, Fira Code e Consolas per codice e valori tecnici.

**Character:** una coppia da strumento operativo, con titoli contenuti e differenze di peso moderate. Non è prevista una tipografia display da apertura marketing.

### Hierarchy

- **Headline:** titoli delle finestre, con la stessa misura contenuta su desktop e mobile.
- **Title:** titoli delle sezioni e degli stati vuoti. Il marchio usa un peso maggiore (600).
- **Body:** testo dell'interfaccia; suggerimenti lunghi nei form usano un'interlinea più aperta e una lunghezza massima (75ch).
- **Label:** metadati, toolbar, schede e suggerimenti brevi.
- **Column header:** nomi delle colonne delle griglie, più marcati delle etichette secondarie e con spazio riservato al ridimensionamento.
- **Control:** pulsanti e azioni, con peso medio.
- **Code:** editor, evidenziazione e numeri di riga condividono le stesse metriche, anche su mobile.
- **Data:** valori delle griglie; cifre tabulari per colonne numeriche e metriche. Le intestazioni restano in Inter.

La scala operativa del bridge usa 12, 13, 14 e 16px. I gradini da 20 e 24px restano disponibili nella foundation, ma non sono la gerarchia dei titoli della shell e delle finestre qui registrata. L'editor conserva la propria metrica monospaziata.

**The Densità leggibile Rule.** La radice resta a 16px. Ottieni compattezza con righe, padding e disposizione, senza ridurre lo zoom globale o disallineare i livelli dell'editor.

## Layout

Il workspace occupa il viewport e assegna lo scorrimento alle regioni operative. Su desktop un solo navigatore ridimensionabile contiene le sezioni «Connessioni», sempre espansa, e «Database» o «Schemi», collassabile dalla propria testata. Il pulsante in alto a sinistra e Ctrl+B chiudono e riaprono l'intero navigatore, ricordandone lo stato. Il separatore orizzontale ripartisce l'altezza con trascinamento o tastiera; larghezza, ripartizione e stato dell'esploratore sono ricordati. Le azioni di aggiunta rimangono nelle testate. Il menu «Strumenti» occupa un footer indipendente sotto l'esploratore, ancorato al fondo del navigatore. Quando «Database» o «Schemi» è collassato, la sua testata resta immediatamente sopra il footer: entrambi rimangono in basso e lo spazio libero appartiene alla regione superiore. La larghezza iniziale del navigatore è 244px, ridotta a 224px fra 901 e 1100px; la testata della shell usa `--shell-header-height` (44px). A destra la barra delle connessioni attive, senza l'etichetta ridondante «Sessioni», la riga dei documenti aperti e il selettore di vista hanno posizioni distinte. Il comando «Schede» compare solo nella navigazione mobile, fino a 900px. Le schede dei documenti occupano l'intera riga disponibile; le modalità Dati, Dettagli, Query e Visualizza stanno nella riga successiva. Lo Schema Browser delle query parte da 184px, passa a 160px nello stesso intervallo ed è richiudibile su desktop. Queste misure descrivono la shell, non una griglia obbligatoria per ogni nuova finestra.

La scala di spaziatura nel frontmatter ordina distanza fra icone, gruppi, righe di form e margini delle finestre. Arc usa anche alias numerici in rem: con la radice invariata, 2/3/4/6 corrispondono a `sm`/`md`/`lg`/`xl`. Le toolbar stanno accanto al contenuto comandato; le azioni delle finestre chiudono il form, separate da un bordo.

Le righe dei dati hanno una sorgente condivisa con il motore virtuale (`--grid-row-h`: 30px). Con puntatore grossolano oppure viewport fino a 600px diventano 48px; i controlli piccoli e medi passano a un minimo di 44px. Su desktop i controlli usano altezze minime di 28, 32 e 44px secondo il contesto; le altezze dei componenti nel frontmatter descrivono la taglia media, non un limite al contenuto. I documenti incorporati nei pannelli conservano la densità desktop con un puntatore preciso.

Fino a 900px la shell adotta una barra inferiore di 64px con tre voci: «Connessioni», «Database» e «Schede». La stessa barra entra nel BottomSheet Arc locale e torna nella shell alla chiusura: consente di cambiare sezione anche dentro il dialogo, senza duplicare i controlli. La voce del pannello aperto usa accento e indicatore superiore; «Database» è disabilitato finché non c'è una connessione attiva. I comandi duplicati nella testata, le barre delle connessioni e dei documenti e il contatore delle sessioni sono nascosti. Il pannello offre due altezze, 70% e 94% dell'area disponibile; sotto 600px di altezza del viewport visibile si apre al 94%. Solo la testata trascina il pannello; il contenuto conserva lo scorrimento e la selezione del testo. «Schede» raggruppa i documenti per connessione, distingue la selezione dal menu delle azioni e indica testualmente «In uso», anteprima e modifiche non salvate; mantiene riordino, chiusura e nuova connessione. Lo Schema Browser delle query rimane un drawer laterale. Le viste Dati, Dettagli e Query restano nel workspace; Salute rimane in «Strumenti». Tornando al desktop il drawer si chiude e ricompaiono le barre. Questa composizione riguarda la navigazione: editor, JSON e form complessi mantengono le proprie superfici ampie.

La toolbar Dati dimensiona i gruppi di filtro e ordinamento, compresi i contenitori del completamento automatico. Su desktop le azioni restano insieme e vanno a capo quando lo spazio non basta; su mobile filtro, ordinamento e azioni occupano aree esplicite di una griglia su più righe. La cronologia si apre sotto la toolbar e ne rispetta la larghezza. La toolbar Query manda a capo bersaglio, esecuzione e metriche. Il pulsante di esecuzione resta visibile. Nelle query i comandi «Editor», «Risultati» ed «Entrambi» cambiano la superficie visibile mantenendo lo stato del documento. Le finestre riducono il padding; fino a 600px l'editor del tema porta i controlli sotto le rispettive etichette. Codice, griglie e tabelle amministrative larghe scorrono nel proprio contenitore, senza trascinare orizzontalmente la shell.

Il footer Dati distingue totale, modalità «Scroll continuo» e navigazione. Su desktop resta una riga compatta; nei contenitori sotto 600px i gruppi possono andare a capo. Su mobile occupa una sola riga: frecce, intervallo con totale sottostante e pulsante «Opzioni dei risultati». Il pulsante apre un BottomSheet Arc ad altezza naturale: titolo e chiusura compatti, «Righe» accanto al selettore e spunta accanto a «Scroll continuo». Le opzioni condividono una riga quando entrano, altrimenti vanno a capo; il pannello non riserva una percentuale dello schermo. Usa gli stessi controlli e valori del desktop, ripristinati alla chiusura. L'intervallo non si spezza e i controlli mobile hanno bersagli di almeno 44px. Un risultato esatto di una sola pagina può ridursi al riepilogo; apertura e chiusura funzionano anche da tastiera e conservano il focus. Le opzioni restano accessibili anche dal riepilogo ridotto.

I pannelli affiancati si ridimensionano con separatori e possono mostrare contesti di connessioni diverse. La Split-View è disponibile solo su desktop, oltre 900px. Su mobile comandi, trascinamento e aree affiancate nel drawer Schede non sono disponibili: il workspace passa a una scheda singola. Le aree e le bozze restano conservate per il ritorno a desktop; il ridimensionamento non le chiude.

**Contesto vicino.** Mantieni bersaglio, azione ed esito nel pannello che governano; quando lo spazio diminuisce, ricomponi i gruppi prima di ridurre la leggibilità.

## Elevation & Depth

La profondità ordinaria nasce da superfici tonali e bordi sottili. Testata, toolbar, navigazione mobile e riepiloghi non ricevono ombre ornamentali. Menu, palette dei comandi e finestre usano le ombre del tema per distinguersi dal contenuto sottostante; le modali aggiungono un velo. La superficie dei pulsanti rimane ferma all'hover.

### Shadow Vocabulary

- **Riposo:** `--shadow-resting` è nullo nel bridge CodeDB.
- **Sollevato:** `--shadow-raised` rimanda a `--shadow-md` del tema.
- **Fluttuante:** `--shadow-floating` rimanda a `--shadow-lg` del tema, usato per finestre e menu.

Ombre, transizioni dei controlli e breakpoint sono nel [sidecar](.impeccable/design.json), fuori dallo schema dei token primitivi; i preset di entrata e uscita delle superfici sono in [motion-tokens.ts](ui/components/arc/motion-tokens.ts). Le transizioni brevi rispondono allo stato dei controlli; i componenti Arc conservano il proprio feedback di pressione. La preferenza di movimento ridotto abbrevia le transizioni e disattiva i movimenti non necessari.

Le righe virtualizzate non animano il fondo durante lo scorrimento: l'alternanza segue l'indice del record, non la posizione momentanea nel DOM. Drawer, BottomSheet e backdrop usano livelli condivisi. Al rilascio del trascinamento il BottomSheet torna a una delle sue altezze con la molla `smooth` Arc, senza rimbalzo. Menu e selettori restano sopra il contenitore di apertura senza introdurre valori locali arbitrari.

Le finestre desktop animano soltanto l'opacità dell'overlay e la trasformazione del pannello: entrata decelerata in 240ms da 8px più in basso e scala .99, uscita accelerata in 180ms verso 6px e scala .995. Il BottomSheet entra in 320ms con decelerazione ed esce in 220ms con accelerazione, senza rimbalzo; lo spazio utile del contenuto cambia solo al cambio di altezza scelta o viewport, non a ogni fotogramma. Con movimento ridotto entrambe le superfici usano una dissolvenza di 80ms senza traslazione o scala animate.

Il drawer laterale dello schema mantiene gli stessi tempi di 320/220ms, scorrendo orizzontalmente; lo sfondo sfuma e perde visibilità solo a fine uscita. Con movimento ridotto lo scorrimento è immediato. Un cambio fra desktop e mobile durante la chiusura completa la rimozione del contenitore, senza lasciare overlay attivi.

Le barre delle connessioni e dei documenti condividono un indicatore di selezione persistente: superficie e sottolineatura scorrono in 280ms con curva `cubic-bezier(0.16,1,0.3,1)`. Durante il cambio di selezione i nomi restano nel flusso. Una nuova scheda compare con dissolvenza di 180ms. Il riordino segue il comportamento delle tab di Chrome: la scheda originale, opaca, segue il puntatore; le vicine scorrono in 180ms della sua larghezza più il distacco, aprendo un varco reale. Ai bordi la barra scorre automaticamente. Il rilascio conferma l'ordine una sola volta e assesta le tab, mentre annullamento o ri-render ripristinano la barra. Il payload nativo resta disponibile per trascinare le tabelle verso la split view. Un cambio rapido riparte dal fotogramma corrente. I dati e lo stato attivo cambiano subito, senza animare la griglia o attendere il movimento della barra. Con movimento ridotto selezione, spostamento delle vicine e assestamento sono immediati; la scheda in mano continua a seguire il gesto.

**The Profondità di servizio Rule.** Usa l'elevazione per distinguere un livello temporaneo; non aggiungerla a ogni regione del workspace.

## Shapes

Gli angoli sono contenuti: `control` per pulsanti e campi, `panel` per menu e pannelli, `surface` per finestre. Il raggio `sm` serve alle etichette compatte dei valori. Bordi sottili e allineamenti definiscono le regioni; le impostazioni privilegiano righe separate, non una card per etichetta.

Le schede di connessione e documento sono piatte, senza spalle o raccordi sagomati, con angoli `sm`. La connessione attiva usa una superficie neutra tinta d'accento; il documento attivo un velo più leggero, aperto verso il contenuto. Entrambi hanno una sottolineatura d'accento e nomi di peso stabile, così il cambio non sposta le etichette. I pannelli affiancati hanno angoli retti. Le forme circolari di indicatori, checkbox e controlli colore restano funzionali; non estendere il linguaggio delle pillole a ogni contenitore.

## Components

### Buttons

Azioni compatte con etichette riconoscibili e peso medio. Le varianti Arc sono `primary`, `secondary`, `ghost` e `danger`: riempimento indaco per l'azione principale; superficie neutra o trasparente per le altre; testo semantico per le azioni distruttive. Il padding e la taglia media sono nel frontmatter; le toolbar usano la taglia piccola.

L'hover dei pulsanti Arc usa opacità o superficie più evidente secondo la variante; i pulsanti DOM primari usano l'indaco profondo. Il focus visibile usa `--focus-ring`, derivato dall'accento di lettura, con contorno e distanza dal bordo (2px). I controlli disabilitati sono attenuati; il caricamento Arc mantiene il focus e impedisce una nuova attivazione. Le sole icone conservano un nome accessibile.

### Inputs / Fields

Campi neutri con bordo marcato, raggio `control`, etichetta e messaggio vicini. Hover e focus modificano il bordo; il focus da tastiera mantiene il contorno comune. Gli errori usano testo e bordo semantici; un placeholder non sostituisce l'etichetta. I selettori, calendari e controlli colore condividono token e geometria dei campi.

### Navigation

Connessioni, database o schemi, documenti e viste restano riconoscibili senza intestazioni decorative. La selezione degli alberi usa un velo indaco e un segno laterale; la vista attiva usa velo e testo d'accento. Gli stati inattivi sono secondari, l'hover li rende più leggibili. Le schede delle connessioni esplicitano il motore in un'etichetta compatta; quelle dei documenti mantengono icona del tipo, prefisso del database o schema, nome e chiusura. Non viene mostrato un contatore delle connessioni. Le schede hanno semantica e navigazione da tastiera; i nomi lunghi mantengono il testo completo nei tooltip e la selezione viene portata nella parte visibile della barra. Su mobile le due barre sono nascoste: la selezione resta nel drawer «Schede».

Aprire una connessione salvata già connessa riprende la sessione esistente. «Apri un'altra sessione» nel suo menu crea esplicitamente una sessione aggiuntiva. L'esploratore mostra il nome della connessione corrente; su PostgreSQL il livello database del prodotto è presentato come «Schemi». Ricerca delle connessioni, ricerca di database/oggetti e filtro dei dati rimangono separati.

Nel navigatore le connessioni hanno icona del motore, nome e indirizzo su due righe; cartelle e oggetti usano una gerarchia più densa con guide sottili. La connessione attiva e la tabella selezionata condividono un indicatore che scorre in 260 ms, ripartendo dal fotogramma corrente se interrotto. Il cambio di connessione introduce il relativo albero in 180 ms, senza ritardare le azioni. Il movimento usa solo trasformazioni e opacità e si disattiva con movimento ridotto. Gli stati di connessione hanno anche un nome accessibile. Sul touch azioni e righe mantengono almeno 44 px; il pannello resta richiudibile e la sezione Connessioni rimane sempre aperta.

La ricerca rapida usa le schede Tutto, Comandi, Database e Tabelle, sincronizzate con i richiami testuali `>`, `#` e `@`. Il risultato mette il nome in primo piano, tipo e database nella seconda riga; il contesto della connessione rimane nella testata desktop. Campo e icona condividono un solo contorno di focus. La selezione delle categorie riusa il movimento delle tab; quella dei risultati scorre in 160 ms e segue tastiera e mouse. La lista resta virtualizzata e conserva il bersaglio quando arrivano altre tabelle. Su mobile rimane nel BottomSheet Arc, con righe da 56 px e filtri da 44 px. Chiusura, movimento ridotto e ritorno del focus seguono il contratto delle finestre.

Le anteprime espongono «Mantieni» per fissare la scheda senza doppio clic. Una bozza di cella, una query modificata o un'esecuzione in corso impediscono che l'apertura di un'altra anteprima sostituisca quel documento. Il selettore «Schede» mostra appartenenza, anteprima e modifiche non salvate; la selezione è separata dal menu con riordino, copia del nome e chiusura. I menu degli alberi hanno un pulsante visibile e accesso da tastiera.

Il [BottomSheet locale](ui/components/arc/bottom-sheet/bottom-sheet.tsx) usa Radix per modalità, focus ed Escape. L'[adattatore di navigazione](ui/navigation-sheet.tsx) sposta gli stessi nodi e controller degli alberi nel pannello e li riporta alla posizione originale alla chiusura: non clona i controlli e conserva lo scroll. La sezione è visibile nello sheet anche se collassata sul desktop; al ritorno recupera quello stato. Il comando sulla presa espande o riduce il pannello con clic, Invio o frecce; il pulsante «Chiudi» resta distinto. La testata mostra il titolo e, per database o schemi, la connessione corrente. Il ritorno al controllo di apertura è coordinato da `responsive.js`; menu e finestre annidati hanno precedenza nella gestione di Escape. Questo contratto non presume che le prove della tastiera virtuale Android siano complete: stato e limiti delle verifiche restano nella matrice.

Anche il footer «Strumenti» entra nel BottomSheet insieme all'albero, usando lo stesso nodo e lo stesso menu del desktop. Rimane sotto il contenuto di navigazione e torna nel navigatore alla chiusura, senza duplicare comandi o stato.

### Pannelli affiancati

Ogni pannello desktop ospita gli stessi controller della scheda singola: Dati, Query, Dettagli, UML e Grafo 3D. Connessione, database/schema e tabella rimangono nella testata; le viste agiscono sul proprio riquadro. Il pulsante Espandi restituisce temporaneamente tutto lo spazio al pannello senza perdere il layout. Toolbar e intestazioni si ricompongono quando il riquadro si restringe, mantenendo densità desktop con un puntatore preciso e dialog desktop. Il numero di pixel del riquadro non lo trasforma in un dispositivo mobile.

Runtime e controlli Arc restano montati anche cambiando area o passando alla scheda singola mobile: bozze, selezioni, larghezze, risultati e scorrimento appartengono al documento. Trasporto, annullamento e aggiornamenti live restano isolati per connessione e pannello. Il backend rilascia soltanto lo stream del pannello chiuso.

### Chips

Le etichette compatte comunicano tipi ed esiti. I booleani associano testo esplicito, fondo e bordo neutri: non diventano badge di successo o errore. Badge database e indicatori di connessione mantengono le famiglie specifiche già definite nei token.

### Cards / Containers

I riepiloghi statistici e di stato sono contenitori funzionali con superficie neutra, bordo e nessuna ombra a riposo. Le impostazioni del tema, i gruppi backup e le serie dei grafici si ordinano in righe e sezioni. Non estrarre una card universale dalle eccezioni locali.

### Dialogs

Finestre con raggio `surface`, superficie del tema, bordo marcato e ombra fluttuante. Titolo, contenuto e azioni hanno una gerarchia distinta; i form hanno più spazio della griglia. I componenti Arc/Radix gestiscono focus e sovrapposizione entro gli overlay dell'app. Menu e selettori aperti rimangono sopra la finestra che li ospita.

Il contenuto resta montato fino al completamento dell'uscita. Anche palette e finestre dinamiche delle scorciatoie passano da `removeDialog`, senza rimuovere prima il pannello. Il drawer di navigazione restituisce nodi e callback alla chiusura conclusa; il passaggio diretto a un altro pannello è immediato e conserva i controller esistenti.

Fino a 900px tutte le finestre modali, incluse quelle dinamiche, la palette e le conferme, usano il BottomSheet Arc. Il pannello mantiene gli stessi nodi del form passando da desktop a mobile: valori, selezione e focus restano nel documento aperto. Il drawer offre le altezze 70% e 94% dell'area utile, parte espanso su schermi bassi e rispetta safe area e tastiera. La chiusura passa dal controller originale; scartare una bozza richiede conferma. Login e sblocco del vault restano barriere non annullabili. Le conferme mobile sono asincrone e le operazioni mantengono il bersaglio scelto prima dell'attesa.

Nel wizard di connessione il primo «Connetti» dai parametri o dal tunnel SSH apre il terzo passo «Riepilogo e conferma» e porta il focus al titolo; solo «Conferma e connetti» richiede l'apertura della sessione. Il riepilogo usa righe chiave-valore compatte per motore, parametri e SSH, con segreti mascherati e stato esplicito delle credenziali già salvate. Nome e cartella rimangono modificabili nello stesso passo; il messaggio accanto alle azioni distingue nuova connessione salvata, aggiornamento di una esistente e uso senza salvataggio, precisando che il salvataggio associato al collegamento avviene solo se riesce. «Indietro» permette di correggere i parametri e «Annulla» di uscire. Desktop e mobile riusano lo stesso form nelle superfici Arc: il riepilogo scorre nel drawer senza aprire una seconda conferma annidata.

Il passo SSH distingue «Password», «File dal dispositivo» e «Percorso sul server CodeDB», mostrando solo i campi del metodo scelto. «Scegli file…» usa un pulsante Arc; il form e il riepilogo espongono nome e stato della chiave caricata o già salvata, senza mostrarne il contenuto segreto. Un percorso sul server indica invece un file leggibile dal processo CodeDB. Questi controlli restano gli stessi nel dialogo desktop e nel drawer mobile.

Le finestre di inserimento e modifica esplicitano connessione, database o schema e tabella o collezione nel titolo. Le modifiche pendenti richiedono conferma prima della chiusura; il bersaglio non viene dedotto dal pannello che acquisisce il focus dopo l'apertura.

Un'attività lunga mantiene il proprio contesto e lo stato reale anche se cambia la vista. Il restore raggruppa messaggi e avanzamento per singola operazione. Nel monitor delle sessioni «Leggi query» apre il testo completo in una finestra copiabile, anche quando la tabella lo abbrevia.

### Salute delle connessioni

Il pannello avvicina nome, motore, stato ed eventuale problema della connessione. Esito e orario dell'ultima verifica precedono i controlli; ping, tunnel SSH e pool completano la lettura in quattro colonne su desktop. Il ping usa cifre tabulari e unità distinte, mentre colori semantici, icone e testo rendono leggibili gli stati. Fino a 600px ogni riga si ricompone su due colonne; fino a 900px la finestra usa il BottomSheet Arc ad altezza naturale e controlli di almeno 44px. L'assenza di connessioni riusa lo stato vuoto Arc.

Gli aggiornamenti conservano i nodi e il punto di lettura: le nuove righe entrano in breve sequenza e solo i valori cambiati ricevono riscontro animato. La linea di verifica si muove soltanto durante una richiesta; il movimento ridotto elimina questi effetti. Un errore conserva valori e orario dell'ultima risposta riuscita, affiancandoli a un avviso esplicito. L'aggiornamento automatico attende quattro secondi dalla risposta, mantiene una sola richiesta in corso, si sospende a pannello chiuso o pagina in background e scarta le risposte delle aperture precedenti.

### Sessioni & Query attive

Il monitor presenta server e filtri, diagnosi e quattro colonne: sessione, attività, query e azioni. Il codice mostra un'anteprima di tre righe; «Leggi query» conserva il testo restituito al momento dell'apertura, copiabile e con avviso se il database lo ha troncato. Fino a 600px identità e attività restano affiancate, seguite da query e azioni a tutta larghezza. Fino a 900px monitor e lettore usano il BottomSheet Arc al 94%, con comandi di almeno 44px. La conferma di un intervento conserva connessione e identità della sessione scelta anche durante gli aggiornamenti.

«Mostra» include le sessioni CodeDB e i processi di servizio anche inattivi, indipendentemente da «Solo attive»; «Nascondi» li esclude. Scelta e focus del comando persistono al refresh, senza modificare le protezioni decise dal server. Lo stato vuoto Arc distingue assenza di attività e filtri senza risultati, offrendo «Mostra tutte» nel secondo caso. Un errore rimuove i dati su cui non è più affidabile agire e propone «Riprova».

Gli aggiornamenti conservano i nodi: entrano in breve sequenza solo le nuove righe e ricevono riscontro solo le celle cambiate. Le righe restano nello stato iniziale durante il ritardo dell'animazione, evitando lampeggi; la preferenza di movimento ridotto elimina questi effetti. Il refresh automatico attende cinque secondi dalla risposta, non sovrappone richieste, si sospende a pannello chiuso o pagina in background e scarta le risposte superate.

### Backup & Ripristino

Il pannello mette origine e tipo di backup al primo piano, seguiti dall'ambito facoltativo. Compressione, campo data, cloud e notifiche restano in «Opzioni avanzate», espandibili con un controllo nativo `details`; un campo non valido apre la sezione che lo contiene. Accanto ad «Avvia backup», il riepilogo segue tipo, gzip e destinazione scelti. Il catalogo distingue ultima copia e storico, riusando gli stati vuoti Arc per assenza di backup o di corrispondenze al filtro.

L'ambito usa una multiselezione ricercabile con checkbox Arc, espandibile dentro il form senza sovrapporre altri comandi. Il riepilogo mostra il nome scelto o il numero di selezioni; nessuna selezione include tutto il database. Filtrare e riaprire conserva le scelte, cambiare origine le azzera. L'elenco carica soltanto i nomi, senza conteggi, con stato vuoto ed errore riprovabile. Escape richiude prima la selezione e riporta il focus al riepilogo; su mobile le righe mantengono 44px e la lista scorre dentro il drawer.

Le due schede riusano l'indicatore animato del workspace; il contenuto entra con una breve dissolvenza e traslazione, disattivate con movimento ridotto. La finestra desktop arriva a 880px e dispone i campi su due colonne, ridotte a una fino a 600px. Fino a 900px apre il BottomSheet Arc al 94%, dopo aver chiuso l'eventuale drawer di navigazione; campi e comandi principali mantengono bersagli di almeno 44px anche in orizzontale. Superfici, indaco e controlli restano quelli CodeDB.

Nel catalogo database e data precedono gli identificativi tecnici. Icona del motore, origine e numero di copie completano l'identità; data assoluta e tempo trascorso rendono riconoscibile ogni versione. «Completo», «Incrementale» e «Differenziale» usano etichette neutre: il tipo non indica l'esito della verifica. «Verifica» è un'azione discreta senza fondo, «Ripristina» un pulsante con bordo; gli esiti rimangono accanto alla copia interessata. Fino a 600px database e ultima copia restano affiancati, con azioni sotto; le versioni precedenti scorrono verticalmente senza richiedere scorrimento orizzontale.

«Versioni precedenti» apre un elenco ordinato dentro lo stesso gruppo, con nome accessibile e stato espanso esplicito; quando è chiuso, i suoi controlli sono inerti. Apertura e chiusura conservano nodi, focus ed esiti. Lo storico si rivela tramite ritaglio, dissolvenza e breve traslazione (280ms in apertura, 150ms in chiusura); i gruppi vicini si ricompongono con trasformazioni FLIP (240ms). Invertire il gesto riparte dall'aspetto corrente; con movimento ridotto il cambiamento è immediato.

Durante «Aggiorna» il catalogo conserva le righe montate, l'altezza e lo scorrimento: uno skeleton segue le misure dei contenuti, compresi gli storici aperti. Al primo caricamento anticipa tre righe. Le azioni restano inerti fino alla risposta più recente; il filtro digitato durante l'attesa si applica ai nuovi dati. La pulsazione usa solo l'opacità ed è assente con movimento ridotto. Un errore compare sopra il catalogo senza cancellare le copie già lette.

### Temi

Il selettore confronta i temi con miniature del workspace nei colori derivati delle palette reali. Automatico, Scuro e Chiaro sono affiancati; Automatico mostra insieme base scura e chiara. I temi personali occupano righe con azioni separate dalla scelta; creazione e importazione rimangono in fondo. Sotto 600px anche i predefiniti diventano righe compatte; su mobile la finestra apre il BottomSheet Arc al 94%. Le azioni delle miniature hanno bersagli di 44px fino a 900px o con puntatore grossolano.

Ogni scelta è un pulsante con stato `aria-pressed`, utilizzabile anche con Spazio: spunta, superficie e cornice persistente identificano il tema attivo. La cornice passa fra le scelte con trasformazioni FLIP (320ms), ripartendo dalla posizione visibile se arriva una nuova selezione; con movimento ridotto si aggiorna senza animazione. Il tema scelto si applica e si memorizza subito; nell'editor le modifiche restano un'anteprima fino a «Salva». Chiudere senza salvare interrompe subito l'anteprima e ripristina i colori in uso, mantenendo visibile il contenuto dell'editor fino al termine dell'uscita Arc.

### Guida introduttiva

La guida presenta i cinque traguardi reali — connessione, esplorazione, query, grafico e backup — con stato esplicito e conteggio dei completati. Il giro guidato è l'azione principale, in una riga con superficie indaco; checklist e nuova connessione restano azioni secondarie compatte. Tipografia, icone e superfici appartengono al sistema CodeDB.

Aprendo la guida da Strumenti, il drawer di navigazione si chiude e rilascia il focus. Su mobile il tour indica Connessioni, Schede, Database e ricerca nei loro controlli effettivi; resta disponibile anche senza connessioni aperte.

Su desktop la finestra conserva una larghezza contenuta (560px); su mobile il solo hub usa il BottomSheet Arc ad altezza naturale, con azioni visibili insieme in ritratto e scorrimento verticale quando lo schermo è basso in orientamento orizzontale. La bussola si orienta all'apertura e i segmenti già completati si rivelano in sequenza mediante trasformazioni, senza animare la geometria del layout; hover e focus danno un piccolo riscontro su bussola e frecce. La preferenza di movimento ridotto disattiva questi effetti. Il tour parte dopo la chiusura completa della guida, quando il dialogo ha rilasciato focus e tastiera al workspace.

### Griglie e intestazioni

Griglia principale, risultati query, pannelli affiancati e campione dati UML condividono il ridimensionamento in [table-resize.js](public/js/table-resize.js). Le intestazioni usano il ruolo `column-header`, una superficie neutra distinta e un bordo inferiore leggibile; con puntatore grossolano o viewport fino a 600px diventano alte 44px. Il nome completo resta accessibile nel tooltip e nel menu della colonna.

Il bordo destro espone una presa visibile con area interattiva larga 24px. Trascinamento, frecce da tastiera e menu «Imposta larghezza…» sono vie equivalenti; «Adatta al contenuto» e «Copia nome completo» non richiedono hover o doppio clic. Le larghezze manuali appartengono al documento o pannello; non modificano ordinamento, query o valori. Il componente usa `colgroup` e layout fisso; lo scorrimento orizzontale rimane locale.

Le righe trattenute nella finestra virtuale conservano i propri nodi durante lo scorrimento. L'altezza effettiva e gli spaziatori seguono la densità condivisa; tema, viewport e puntatore non devono creare una geometria diversa da quella del motore virtuale. Hover, selezione, cella attiva e bozza restano distinguibili: selezione con fondo tenue, cella attiva contornata, bozza con segno e asterisco. L'abbreviazione di un valore è soltanto visiva e non cambia il contenuto copiato o inviato.

L'editor inline presenta «Applica» e «Annulla» vicino alla cella, con nomi accessibili espliciti. Sono uscite visibili aggiuntive: Invio ed Escape restano disponibili, e uscire dal campo continua a salvare secondo il comportamento esistente. Il passaggio ai pulsanti, al selettore Arc aperto, al calendario o al pannello FK non deve salvare prematuramente. «Annulla» scarta la bozza; un errore di validazione o salvataggio la conserva nel contesto originario.

### Dettagli della tabella o collezione

La vista mette lo schema al centro: database, nome e motore identificano l'oggetto, seguiti da una fascia di sei statistiche compatte e dagli indici laterali. Nomi di campi, tipi e chiavi usano il monospaziato; superfici e separatori restano neutri, con indaco nelle icone e nelle barre di presenza. SQL espone tipi e ammissibilità dei valori nulli; MongoDB distingue schema campionato e percentuale di presenza, riportata anche in testo. Chiavi degli indici, ordine e unicità restano leggibili accanto alle azioni Arc; i campi e gli indici di sistema protetti hanno un nome accessibile.

La disposizione segue il contenitore: fino a 960px schema e indici si susseguono e le statistiche formano tre colonne; fino a 600px ciascun campo dispone nome sopra tipo e presenza, mantenendo le azioni a lato. Con viewport fino a 900px o puntatore grossolano i comandi hanno bersagli di almeno 44px, anche in orizzontale. Caricamento, errore con «Riprova» e assenza di campi o indici hanno messaggi distinti; le azioni conservano il proprio bersaglio e una risposta superata non sostituisce i dettagli dell'oggetto corrente.

La comparsa anima soltanto le prime quattordici righe visibili, con dissolvenza e breve traslazione (320ms, ritardo massimo 108ms). Le barre di presenza si estendono mediante `scaleX` (440ms), mentre il riepilogo si rivela con dissolvenza e ritaglio (360ms). Un nuovo caricamento cancella il movimento precedente; la preferenza di movimento ridotto interrompe gli effetti in corso e salta quelli successivi.

### Workspace dati e query

L'unità caratteristica è il pannello operativo: contesto e comandi, editor o griglia, risultati e stato. Mantieni la riga condivisa con la virtualizzazione e le metriche comuni a textarea, evidenziazione e gutter. I canvas di Leaflet, ECharts, JointJS e Three.js conservano i propri motori; la cromatura intorno ad essi usa le stesse superfici delle altre viste. Gli stati vuoti spiegano il prossimo passo senza un involucro ornamentale.

Griglia Dati, risultati Query e pannelli affiancati riusano l'EmptyState Arc nel viewport dei risultati, fuori dalle celle: il messaggio resta centrato anche con colonne larghe e conserva le intestazioni SQL disponibili. Una piccola griglia decorativa nei colori del tema accompagna titolo, spiegazione e una sola azione contestuale, come modificare il filtro, raggiungere l'editor o aggiornare. Anche «Nessuna connessione aperta» riusa questa illustrazione con il simbolo database e l'azione primaria «Aggiungi connessione»; il placeholder «Esplora i dati» resta distinto. Stato iniziale, risultato vuoto, annullamento ed errore hanno testi distinti; l'assenza di righe non nasconde un errore diagnostico. Il messaggio lascia spazio al caricamento e scompare quando arrivano dati. Su mobile l'azione mantiene un bersaglio di almeno 44px.

Nell'area affiancata ogni pannello espone connessione, database o schema e documento, con Dati e Query immediatamente disponibili. Dettagli, UML, grafo e operazioni di disposizione restano nel menu del pannello. La parola «Attivo» accompagna il segno d'accento: il colore non è l'unico indizio del focus. Esecuzione, annullamento, errori e risultati rimangono nel pannello proprietario; filtri, selezioni, paginazione e bozze appartengono al documento. Le bozze di celle non salvate usano un segno inferiore e un asterisco.

I pannelli specializzati incorporano i controller reali in documenti isolati, con la stessa sessione Socket.IO della connessione e senza consumare ulteriori sessioni. Il runtime rimane montato durante riordino e cambio scheda; tema e focus sono coordinati con la shell. Questa scelta preserva gli editor e le interazioni Arc già presenti.

I controlli riusano i componenti reali in `ui/components/arc`, con CSS Modules e isole React. I controller del workspace restano moduli ESM vanilla. Gli esempi HTML/CSS del sidecar sono anteprime autonome del linguaggio visivo, non sostituti dei componenti o dei loro comportamenti.

Su mobile l'UML dedica tutta la larghezza al canvas. Tabelle, dettagli, dati e strumenti si aprono nei BottomSheet Arc, spostando i pannelli esistenti. I comandi di zoom stanno in una riga separata dal disegno; la vista si può espandere a schermo intero. Un dito sposta la vista anche partendo da un nodo, due dita ingrandiscono: questi gesti non modificano il diagramma. Nel contesto di una tabella l'inquadratura iniziale privilegia la sua leggibilità; «Adatta alla vista» mostra l'insieme delle relazioni.

L'editor geometrico dedica al disegno uno spazio libero da strumenti sovrapposti, anche su desktop. Tipo e modalità stanno sopra la mappa; cronologia e comandi del vertice occupano righe separate sotto il canvas. Il GeoJSON ha un pannello richiudibile con intestazione e stato di modifica, preservando il testo passando da una vista all'altra. Il selettore Disegna/Modifica usa un indicatore che scorre in 260ms; il pannello si rivela in 240ms con ritaglio e opacità, senza animare dimensioni o coordinate dei vertici. Entrambi rispettano il movimento ridotto. In sola lettura rimane disponibile Inquadra, senza comandi di scrittura.

Su mobile l'editor apre il BottomSheet Arc all'altezza massima (94%). In ritratto gli strumenti di forma e vertice occupano righe sotto il canvas; in orizzontale basso i comandi principali stanno a lato, senza coprire la geometria. Mappa e GeoJSON sono viste alternative su mobile e rimangono affiancabili su desktop. I controlli touch hanno bersagli di almeno 44px; un `ResizeObserver` aggiorna le dimensioni Leaflet quando cambiano drawer, orientamento o vista.

Per le geometrie modificabili, fino a 900px un mirino fisso al centro del canvas guida l'editing: spostare o ingrandire la mappa non modifica i vertici. L'azione esplicita è «Posiziona qui» per Point, «Aggiungi qui» in Disegna, «Seleziona» e poi «Sposta qui» in Modifica. Selezione di un altro vertice, inserimento ed eliminazione usano controlli compatti accanto all'azione principale; l'inserimento prende le coordinate del mirino. Le modifiche riusano Annulla e Ripeti; su desktop rimangono clic e trascinamento dei vertici.

La mappa della selezione multipla resta di sola lettura. Su desktop il canvas affianca un ispettore con Elenco e Riepilogo: le righe espongono campo, record, tipo e misura con il simbolo del colore della forma. Su mobile il drawer Arc apre al 94%, con Mappa, Elenco e Riepilogo alternativi; scegliere un record riporta alla mappa e trasferisce il focus alla relativa scheda. In orizzontale basso strumenti ed export stanno a lato. L'indicatore delle schede scorre con il motore condiviso; l'ispettore compare in 240ms, l'inquadratura dura 350ms e il movimento ridotto esclude entrambi. La selezione aggiorna solo i layer precedente e corrente. Riepilogo ed export includono tutte le geometrie, anche oltre i limiti dichiarati di disegno ed elenco.

La Mappa dei risultati Query riusa lo stesso ispettore e le stesse righe, con istanze indipendenti. La composizione segue la larghezza del contenitore: fino a 720px Mappa, Elenco e Riepilogo diventano viste alternative anche nei pannelli affiancati. Inquadra e sfondo stanno sopra il disegno; conteggio, copia ed export sotto. Espandi mappa usa lo schermo intero del browser per lavorare anche con risultati molto bassi. Il ritorno alla Mappa conserva layer, selezione e zoom; ingresso e schede usano rivelazioni di 240–280ms, senza animare dimensioni o ricostruire le geometrie. I dati non validi, l'assenza di risultati e gli errori cancellano i riferimenti precedenti.

Editor, Risultati ed Entrambi sono schede in tutte le dimensioni del workspace. Icona, testo e indicatore indaco identificano la vista; l'indicatore scorre in 280ms e il contenuto si rivela in 240ms. Frecce, Home ed End spostano il focus fra le schede. Editor e risultati restano montati, conservando testo, selezione e stato delle viste; Entrambi ripristina il divisorio ridimensionabile. Su mobile ogni scheda ha un bersaglio di almeno 44px. Il movimento ridotto interrompe gli effetti e mantiene il cambio immediato.

## Do's and Don'ts

### Do:

- **Do** usare i token CodeDB attraverso il bridge Arc anche nei temi personalizzati.
- **Do** distinguere accento di riempimento, accento di lettura e colori informativi.
- **Do** mantenere la radice a 16px e condividere l'altezza delle righe con la virtualizzazione.
- **Do** preservare focus visibile, etichette accessibili e movimento ridotto.
- **Do** ricomporre toolbar e form su schermi stretti mantenendo visibili bersaglio ed esecuzione.
- **Do** riusare i controlli Arc e la cromatura comune intorno ai motori specializzati.
- **Do** mostrare connessione, database o schema e documento vicino all'azione, anche nei pannelli affiancati.
- **Do** mantenere leggibili i nomi delle colonne e offrire ridimensionamento con puntatore, tastiera e menu.
- **Do** conservare selezioni, bozze e larghezze nel documento proprietario durante la navigazione.
- **Do** riusare gli stessi alberi fra navigatore desktop e BottomSheet mobile, conservando controller e scroll.

### Don't:

- **Don't** introdurre card decorative o composizioni marketing nel workspace.
- **Don't** ripristinare i default della foundation Arc che il tema CodeDB sovrascrive.
- **Don't** fondere sintassi, tipi dei dati, stati e identità dei database in un'unica palette decorativa.
- **Don't** ridurre il testo o tagliare le azioni per far stare una toolbar su una sola riga.
- **Don't** alterare separatamente le metriche di editor, evidenziazione e numeri di riga.
- **Don't** affidare al solo colore l'identificazione del pannello attivo.
- **Don't** usare i colori di errore per `false`, zero o `NULL`.
- **Don't** animare l'alternanza delle righe durante lo scorrimento virtuale.
- **Don't** far competere il trascinamento del BottomSheet con lo scorrimento o la selezione del suo contenuto.
- **Don't** trattare le rampe esplorative del sidecar o i valori locali non registrati come nuovi token dell'app.
