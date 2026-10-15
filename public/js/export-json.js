// Conversione per l'export leggibile: i dati in memoria restano Extended JSON.
export function serializzaJsonStandard(valore) {
  return JSON.stringify(valore, (_chiave, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const chiavi = Object.keys(v);
    // Un documento con altri campi non è un wrapper e non va ridotto a uno scalare.
    if (chiavi.length === 2 && typeof v.$code === 'string' && chiavi.includes('$scope')) {
      return { code: v.$code, scope: v.$scope };
    }
    if (chiavi.length !== 1) return v;
    const tipo = chiavi[0];
    const dato = v[tipo];
    switch (tipo) {
      case '$oid':
      case '$symbol':
      case '$uuid':
      case '$code':
        return typeof dato === 'string' ? dato : v;
      case '$numberDecimal':
        // JSON non distingue i decimali esatti: il testo evita arrotondamenti.
        return typeof dato === 'string' ? dato : v;
      case '$numberInt':
      case '$numberLong': {
        if (typeof dato !== 'string' || !/^-?\d+$/.test(dato)) return v;
        const n = Number(dato);
        return Number.isSafeInteger(n) ? n : dato;
      }
      case '$numberDouble': {
        if (typeof dato !== 'string') return v;
        const n = Number(dato);
        return Number.isFinite(n) ? n : dato;
      }
      case '$date': {
        const canonico = dato && typeof dato === 'object'
          && Object.keys(dato).length === 1 && typeof dato.$numberLong === 'string';
        if (!canonico && typeof dato !== 'string' && typeof dato !== 'number') return v;
        const originale = canonico ? dato.$numberLong : dato;
        const data = new Date(canonico ? Number(originale) : originale);
        // Le date BSON possono superare l'intervallo ISO supportato da JavaScript.
        return Number.isNaN(data.getTime()) ? String(originale) : data.toISOString();
      }
      case '$binary':
        return dato && typeof dato.base64 === 'string' && typeof dato.subType === 'string'
          && Object.keys(dato).length === 2 ? dato.base64 : v;
      case '$regularExpression':
        return dato && typeof dato.pattern === 'string' && typeof dato.options === 'string'
          && Object.keys(dato).length === 2 ? dato : v;
      case '$timestamp':
        return dato && Number.isInteger(dato.t) && Number.isInteger(dato.i)
          && Object.keys(dato).length === 2 ? dato : v;
      case '$dbPointer':
        return dato && typeof dato.$ref === 'string' && Object.hasOwn(dato, '$id')
          && Object.keys(dato).length === 2 ? { namespace: dato.$ref, id: dato.$id } : v;
      case '$minKey':
        return dato === 1 ? 'MinKey' : v;
      case '$maxKey':
        return dato === 1 ? 'MaxKey' : v;
      case '$undefined':
        return dato === true ? null : v;
      default:
        return v;
    }
  }, 2);
}
