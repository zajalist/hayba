// Keep editor discovery and project-local state tied to the installed project.
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
process.chdir(resolve(__dirname, '../../../..'));
import(pathToFileURL(resolve(__dirname, 'dist/bootstrap.js')).href).catch(error => {
  console.error('Hayba could not start. Check the installation and Node runtime:', error.message);
  process.exitCode = 1;
});
