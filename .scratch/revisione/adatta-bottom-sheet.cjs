const fs = require('node:fs');
const crypto = require('node:crypto');
const dir = 'ui/components/arc/bottom-sheet';
fs.mkdirSync(dir, {recursive:true});
let ts = fs.readFileSync('.scratch/revisione/bottom-sheet.tsx','utf8');
// Conserva la provenienza prima degli adattamenti locali.
const provenance = JSON.parse(fs.readFileSync('ui/components/arc/provenienza.json','utf8'));
for (const name of ['bottom-sheet.tsx','bottom-sheet.module.css']) {
  const raw = fs.readFileSync(`.scratch/revisione/${name}`);
  provenance.files.push({path:`${dir}/${name}`,sha256:crypto.createHash('sha256').update(raw).digest('hex'),source:'https://uiarc.dev/r/bottom-sheet.json',retrievedAt:'2026-10-10',adaptations:'Italiano, token CodeDB, viewport utile, trascinamento dalla testata e integrazione dei pannelli esistenti.'});
}
fs.writeFileSync('ui/components/arc/provenienza.json',JSON.stringify(provenance,null,2)+'\n');
// I commenti della distribuzione sono sostituiti dalle ragioni degli adattamenti locali.
ts = ts.replace(/\/\*\*[\s\S]*?\*\//g,'').replace(/\{\/\*[\s\S]*?\*\/\}/g,'').replace(/\/\/[^\n]*/g,'').replace(/\/\* The pointer is already gone\. \*\//g,'/* Il puntatore è già terminato. */');
ts = ts.replace('ReactNode, WheelEvent','ReactNode');
ts = ts.replace('  trigger?: ReactNode;', `  trigger?: ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: globalThis.KeyboardEvent) => void;`);
ts = ts.replace('closeLabel = "Close", className, children, onDismiss','closeLabel = "Chiudi", className, children, onDismiss, onCloseAutoFocus, onEscapeKeyDown');
ts = ts.replace('"Sheet expanded" : stop === 0 ? "Sheet collapsed" : `Sheet at ${Math.round(stops[stop]! * 100)} percent height`','"Pannello espanso" : stop === 0 ? "Pannello ridotto" : `Pannello al ${Math.round(stops[stop]! * 100)} per cento`');
ts = ts.replace('"Collapse sheet" : "Expand sheet"','"Riduci pannello" : "Espandi pannello"');
const start = ts.indexOf('  useEffect(() => {\n    const body = bodyRef.current;\n    if (!body) return;\n    let gesture:');
if(start<0)throw Error('Blocco touch assente');
const end = ts.indexOf('  }, [beginDrag, endDrag, moveDrag, top]);',start) + '  }, [beginDrag, endDrag, moveDrag, top]);'.length;
ts = ts.slice(0,start) + '// Gli alberi hanno scroll e selezione propri: si trascina soltanto la testata.\n' + ts.slice(end);
ts = ts.replace(/  function bodyWheel\([\s\S]*?\n  }\n/,'');
ts = ts.replace('  const expanded = detent === top;', `  // La parte traslata sotto lo schermo non sottrae spazio allo scroll dei contenuti.
  const hiddenBody = useTransform(y, value => Math.max(0, value));
  const expanded = detent === top;`);
ts = ts.replace('      onOpenAutoFocus=', '      onCloseAutoFocus={onCloseAutoFocus}\n      onEscapeKeyDown={onEscapeKeyDown}\n      onOpenAutoFocus=');
ts = ts.replace('<div ref={bodyRef} className={styles.body} onWheel={bodyWheel} onFocus={bodyFocus}>{children}</div>', '<motion.div ref={bodyRef} className={styles.body} style={{ marginBottom: hiddenBody }} onFocus={bodyFocus}>{children}</motion.div>');
ts = ts.replace(/\n[ \t]*\n[ \t]*\n/g,'\n\n');
fs.writeFileSync(`${dir}/bottom-sheet.tsx`,ts);
