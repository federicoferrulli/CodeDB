// Stato condiviso dagli splitter server/client, chiamato dal lexer soltanto
// fuori da stringhe, commenti e identificatori quotati.
export function blocchiSql() {
  let parole = [], routine = false, iniziato = false, stack = [], dopoEnd = false, inizio = true, handler = false;
  return {
    parola(value) {
      const w = value.toUpperCase(); let prima = inizio;
      inizio = false;
      if (parole.length < 6) parole.push(w);
      if (parole[0] === 'CREATE' && ['PROCEDURE', 'FUNCTION', 'TRIGGER'].includes(w) && !iniziato) routine = true;
      if (!routine) return;
      if (w === 'HANDLER') handler = true;
      if (handler && ['IF', 'WHILE', 'LOOP', 'REPEAT', 'BEGIN', 'SET', 'INSERT', 'UPDATE', 'DELETE', 'SELECT', 'CALL', 'SIGNAL', 'RESIGNAL', 'OPEN', 'FETCH', 'CLOSE'].includes(w)) {
        handler = false; prima = true;
      }
      if (dopoEnd) { dopoEnd = false; if (['IF', 'WHILE', 'LOOP', 'REPEAT', 'CASE'].includes(w)) return; }
      if (w === 'BEGIN') { iniziato = true; stack.push(w); inizio = true; }
      else if (iniziato && (w === 'CASE' || (prima && ['IF', 'WHILE', 'LOOP', 'REPEAT'].includes(w)))) stack.push(w);
      else if (iniziato && w === 'END') { stack.pop(); dopoEnd = true; }
      if (['THEN', 'ELSE', 'DO', 'LOOP', 'REPEAT', 'ATOMIC'].includes(w)) inizio = true;
    },
    separa() {
      inizio = true;
      if (stack.length) { dopoEnd = false; return false; }
      parole = []; routine = false; iniziato = false; dopoEnd = false; handler = false;
      return true;
    },
  };
}
