'use strict';

// Mutazione limitata al processo server della fixture, mai al sorgente su disco.
const Module = require('node:module');
const path = require('node:path');
const gateway = path.resolve(__dirname, '../../mcp/McpGateway.js');
const compile = Module.prototype._compile;
Module.prototype._compile = function(source, filename) {
  if (path.resolve(filename) === gateway) {
    if (!source.includes('if (settings.readOnly && mutates)') || !source.includes('!deps.mcpSettings?.get().readOnly')) throw new Error('Mutante MCP non applicabile: aggiornare la fixture.');
    source = source.replace('if (settings.readOnly && mutates)', 'if (false && mutates)')
      .replaceAll('!deps.mcpSettings?.get().readOnly', 'true');
  }
  return compile.call(this, source, filename);
};
