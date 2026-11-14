const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const project = resolve(__dirname, '../../../..');
if (existsSync(project)) process.chdir(project);
import(pathToFileURL(resolve(__dirname, 'dist/standalone/launch.js')).href).catch((error) => {
  console.error('Hayba could not start. Check the installation and Node runtime:', error.message);
  process.exitCode = 1;
});
