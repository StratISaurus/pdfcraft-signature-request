import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startLocalApp } from './local-app.js';
const root=new URL('../',import.meta.url);
export async function startDemo({port=8788,writeLaunch=true,storageDir,trustedLocalAccount=false}={}) {
  const assets=new Map();
  const files={'/':'web/index.html','/app.js':'web/app.js','/style.css':'web/style.css',
    '/vendor/pdf-lib.js':'node_modules/pdf-lib/dist/pdf-lib.esm.js',
    '/vendor/pdf.mjs':'node_modules/pdfjs-dist/build/pdf.mjs',
    '/vendor/pdf.worker.mjs':'node_modules/pdfjs-dist/build/pdf.worker.mjs'};
  for(const f of ['client-crypto','workflow','approval-pdf','approval-client','response-checker']) files[`/src/${f}.js`]=`src/${f}.js`;
  for(const [url,path] of Object.entries(files)) {
    let bytes=await readFile(new URL(path,root));
    if(path==='src/approval-pdf.js') bytes=Buffer.from(bytes.toString().replace("from 'pdf-lib'", "from '/vendor/pdf-lib.js'"));
    assets.set(url,{bytes,type:path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});
  }
  const bundle=await build({entryPoints:[fileURLToPath(new URL('src/sender-vault.js',root))],bundle:true,write:false,format:'esm',platform:'browser',external:['./workflow.js','./approval-pdf.js']});
  assets.set('/src/sender-vault.js',{bytes:bundle.outputFiles[0].contents,type:'text/javascript; charset=utf-8'});
  const app=await startLocalApp({port,assets,storageDir,trustedLocalAccount});
  const launch=new URL('.local/open-sender.html',root);
  if(writeLaunch) {
    await mkdir(new URL('.local/',root),{recursive:true});
    await writeFile(launch,`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open local sender</title><a href="${app.url}/#setup=${app.launchToken}" rel="noreferrer">Open local sender (keep this file private)</a>`,{mode:0o600});
  }
  return {...app,launchPath:fileURLToPath(launch),close:async()=>{await app.close();if(writeLaunch)await rm(launch,{force:true});}};
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const app=await startDemo({port:Number(process.env.PORT || 8788),storageDir:process.env.LOCAL_RELAY_STORAGE_DIR,trustedLocalAccount:process.env.LOCAL_RELAY_TRUSTED_ACCOUNT==='1'});
  console.log(`Local approval demo at ${app.url}. Open ${app.launchPath} and click the sender link. No real documents. Keep the sender tab open.`);
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();process.exit(0);});
}
