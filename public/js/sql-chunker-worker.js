import { indicizzaBlocco } from './sql-chunker.js';

self.onmessage = async ({ data: { id, params } }) => {
  try { self.postMessage({ id, chunk: await indicizzaBlocco(params) }); }
  catch (err) { self.postMessage({ id, error: err.message }); }
};
