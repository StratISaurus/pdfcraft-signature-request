// Isolated test process: no launcher and never the live demo port.
import { startDemo } from '../src/local-demo.js';
process.once('message',async config=>{
  if(config.port===8788)throw Error('Live demo port forbidden');
  try {
    const app=await startDemo({...config,writeLaunch:false,trustedLocalAccount:true});
    process.send({url:app.url,launchToken:app.launchToken});
    process.once('message',async()=>{await app.close();process.exit(0);});
  }catch {process.send({error:'Isolated relay startup failed'});process.exit(1);}
});
