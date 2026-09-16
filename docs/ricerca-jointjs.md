# Ricerca JointJS per UML interattivo

Verifica: 16 settembre 2026. Fonti ufficiali, documentazione corrente 4.3. Questa nota supporta il piano: nessuna dipendenza installata, nessuna prova di integrazione eseguita.

## Scelta proposta

Usare **JointJS Community (`@joint/core`)**, con versione fissata e distribuzione UMD vendorizzata in `public/vendor`, caricata solo quando serve UML. La guida ufficiale supporta esplicitamente JavaScript senza build e file locali; non occorre introdurre un framework. Il funzionamento offline in Electron è una conseguenza tecnica attesa degli asset locali, da verificare nel pacchetto desktop con rete disattivata. [Guida JavaScript](https://docs.jointjs.com/learn/integration/javascript/)

JointJS è una libreria di diagrammi: il comportamento applicativo in stile draw.io va costruito attorno al motore. Community usa MPL-2.0; JointJS+ è un'estensione commerciale separata. Conservare licenza e attribuzioni degli asset distribuiti. L'eventuale adozione Plus richiede una scelta esplicita sul prodotto e sui termini di distribuzione del repository; questa nota non formula conclusioni legali. [Licenze ufficiali](https://www.jointjs.com/license)

## Capacità e lavoro applicativo

| Esigenza | Disponibilità verificata | Conseguenza per CodeDB |
|---|---|---|
| Nodi, relazioni, geometria e interazione | Community: `dia.Graph`, `dia.Paper`, elementi SVG personalizzati, link, porte, routing e strumenti. [Repository ufficiale](https://github.com/clientIO/joint) | Una tabella/collezione diventa un elemento; ciascun campo ha una porta stabile. |
| Trascinamento e collegamenti tra campi | Porte e controlli del Paper, compresi `validateConnection` e `allowLink`. [Porte](https://docs.jointjs.com/learn/features/ports/), [Paper](https://docs.jointjs.com/api/dia/Paper/) | Validare il gesto sul client; una linea disegnata non deve modificare automaticamente il DB. |
| Salvataggio | `graph.toJSON()` e `graph.fromJSON()` preservano celle e proprietà personalizzate. [JSON](https://docs.jointjs.com/learn/features/export-import/json/) | Preferire un documento applicativo versionato: riferimenti allo schema, disposizioni, note e relazioni logiche. Non includere righe del database né caricare JSON arbitrario senza validazione. |
| Diagrammi grandi | Paper supporta rendering asincrono e controllo delle viste. La documentazione avverte che modello e DOM possono temporaneamente divergere. [Paper](https://docs.jointjs.com/api/dia/Paper/) | Separare aggiornamento dati e misure DOM; attendere il rendering per export e adattamento della vista. Non equivale a supporto illimitato: misurare su schemi realistici. |
| Layout automatico | `DirectedGraph` è un pacchetto separato `@joint/layout-directed-graph`, basato su Dagre. [API DirectedGraph](https://docs.jointjs.com/api/layout/DirectedGraph/) | Prima riusare il layout del progetto; aggiungere il pacchetto solo se il risultato richiede un layout gerarchico migliore. Non confondere routing dei link e posizionamento dei nodi. |
| Annulla/ripeti | Il plugin documentato `dia.CommandManager` viene da `@joint/plus`. [Undo/redo](https://docs.jointjs.com/learn/features/undo-redo/) | Con Community implementare una cronologia limitata delle operazioni del documento: un drag è una sola azione; refresh dello schema e letture dati non entrano nella cronologia. |
| Selezione multipla | `ui.Selection` è un plugin Plus. [Selection](https://docs.jointjs.com/learn/features/selection/) | Con Community selezione, rettangolo e movimento di gruppo sono lavoro applicativo da pianificare. |
| Minimap, palette, inspector | `ui.Navigator`, `ui.Stencil`, `ui.Inspector`, `ui.PaperScroller` appartengono all'interfaccia estesa; l'esempio di integrazione li usa nella variante Plus. [Guida JavaScript](https://docs.jointjs.com/learn/integration/javascript/), [Navigator](https://docs.jointjs.com/api/ui/Navigator/) | Costruire una palette HTML per le entità reali, riusare pannelli CodeDB; minimappa semplice applicativa. Non promettere i plugin Plus inclusi in Community. |
| Export immagini | Le API documentate `format.toSVG` e raster sono Plus. [SVG](https://docs.jointjs.com/learn/features/export-import/svg/), [Raster](https://docs.jointjs.com/learn/features/export-import/raster/) | Community: esportare JSON applicativo; per SVG/PNG prevedere serializzazione SVG e conversione Canvas controllate, includendo stili e vista completa, con test offline. Non chiamare API Plus. |

## Verifiche prima dell'integrazione definitiva

- Fissare versione esatta e verificare file distribuiti, licenze e packaging; non utilizzare un URL CDN variabile.
- Prototipo sulla vera pagina CodeDB: tema chiaro/scuro, cambio tab, ridimensionamento, porte su campi, distruzione Paper e listener alla chiusura.
- Dataset con nomi Unicode, campi lunghi, relazioni composite e cicli; non dedurre cardinalità o vincoli fisici dal solo disegno.
- Misurare caricamento e trascinamento con 100, 500 e 1.000 entità; definire una vista parziale esplicita quando il dettaglio completo non resta usabile.
- Provare salvataggio/riapertura, export completo anche delle entità fuori viewport, browser ed Electron offline. Queste sono prove previste, non risultati già ottenuti.
