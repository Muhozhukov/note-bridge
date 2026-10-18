import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/note-bridge',{recursive:true});
await build({entryPoints:['plugin/src/main.ts'],outfile:'dist/note-bridge/main.js',bundle:true,platform:'browser',format:'cjs',target:'es2022',external:['obsidian'],logLevel:'info'});
await copyFile('plugin/manifest.json','dist/note-bridge/manifest.json');
await copyFile('plugin/manifest.json','manifest.json');
await copyFile('plugin/styles.css','dist/note-bridge/styles.css');
await build({entryPoints:['auth-service/src/index.ts'],outfile:'dist/auth-worker.mjs',bundle:true,platform:'browser',format:'esm',target:'es2022',logLevel:'info'});
