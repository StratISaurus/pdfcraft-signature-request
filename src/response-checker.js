// One collection at a time, including manual retries. No background-tab polling.
export function createResponseChecker({collect,onResult,onError,visible,isTerminal,interval=5000,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let timer,flight,active=false,paused=false,terminal=false;
  function cancel(){if(timer!==undefined){clearTimer(timer);timer=undefined;}}
  function schedule(){cancel();if(active && !paused && !terminal && !flight && visible())timer=setTimer(()=>{timer=undefined;return check(false);},interval);}
  function check(manual=true){
    if(flight)return flight;
    if(!active || terminal || (!manual && (paused || !visible())))return Promise.resolve();
    cancel();if(manual)paused=false;
    // Defer collection until flight is assigned, also protecting synchronous errors.
    flight=Promise.resolve().then(collect).then(value=>{
      if(!active)return;
      terminal=isTerminal(value);onResult(value);
    }).catch(error=>{if(active){paused=true;onError(error);}}).finally(()=>{flight=undefined;schedule();});
    return flight;
  }
  return {start(){if(terminal)return;active=true;schedule();},check,stop(){active=false;cancel();},visibilityChanged:schedule};
}
