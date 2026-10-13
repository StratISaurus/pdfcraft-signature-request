import { prepareRequest, invitationFragment, openInvitation, submitApproval, collectApprovals, finalise, api } from '/src/approval-client.js';
import { syntheticPdf, inspectPdf } from '/src/approval-pdf.js';
import { getDocument, GlobalWorkerOptions } from '/vendor/pdf.mjs';
import { createResponseChecker } from '/src/response-checker.js';
GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
let responseChecker;
const $=id=>document.getElementById(id);
const show=id=>$(id).hidden=false, hide=id=>$(id).hidden=true;
let pdf, sender, opened, invitation, ownPdf, collected, bootstrap;
let reviewReady=false;
let fields=[],placementLabels=[];
let previewGeneration=0,previewRevision,creationPending=false,discardedRequest;
function routingIntent() {return JSON.stringify({labels:recipientLabels(),mode:$('mode').value,stages:$('stages').value,fields});}
function freezeRouting(frozen) {
  $('mode').disabled=frozen;$('stages').disabled=frozen;
  $('recipient-cards').querySelectorAll('input').forEach(n=>n.disabled=frozen);
  $('recipient-cards').querySelectorAll('button').forEach(n=>n.disabled=frozen || recipientLabels().length===1);
  $('add-signer').disabled=frozen || recipientLabels().length>=12;
}
async function discardPreparedRequest() {
  if(!discardedRequest)return;
  try {await api(origin,`/api/requests/${discardedRequest.id}`,discardedRequest.adminToken,'DELETE');}
  catch(e){if(e.message!=='not_found')throw Error('Previous changed request could not be revoked. Create again to retry cleanup before creating links.');}
  discardedRequest=undefined;
}
const colours=['#176f59','#3c57ae','#963f76','#95600b','#007785','#914133','#63519b','#496e18','#934b00','#1a6190','#9e3260','#58652a'];
const recipientLabels=()=>[...$('recipient-cards').querySelectorAll('input')].map(n=>n.value.trim());
function renderPeople(labels=['']) {
  $('recipient-cards').replaceChildren(...labels.map((value,i)=>{
    const card=document.createElement('div');card.className='recipient-card';card.style.setProperty('--signer',colours[i]);
    const label=document.createElement('label');label.htmlFor=i===0?'recipients':`person-${i}`;label.textContent=`Signer ${i+1} name`;
    const input=document.createElement('input');input.id=label.htmlFor;input.value=value;input.maxLength=80;input.autocomplete='off';
    input.addEventListener('input',clearFields);
    const remove=document.createElement('button');remove.className='secondary';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove signer ${i+1}`);remove.disabled=labels.length===1;
    remove.onclick=()=>{if(creationPending)return;const next=recipientLabels();next.splice(i,1);renderPeople(next);clearFields();$('recipient-cards').querySelector('input').focus();};
    card.append(label,input,remove);return card;
  }));
  $('add-signer').disabled=labels.length>=12;
}
renderPeople();
$('add-signer').onclick=()=>{if(creationPending)return;const labels=recipientLabels();if(labels.length>=12)return;renderPeople([...labels,'']);clearFields();$('recipient-cards').lastElementChild.querySelector('input').focus();};
$('workflow').addEventListener('click',e=>{const link=e.target.closest('a');if(!link)return;e.preventDefault();const target=document.querySelector(link.getAttribute('href'));target.scrollIntoView({block:'start'});target.focus({preventScroll:true});});
function canCreate() {
  const labels=recipientLabels();
  return !!pdf && !creationPending && previewRevision===documentGeneration && labels.length>0 && fields.length===labels.length && JSON.stringify(labels)===JSON.stringify(placementLabels);
}
function updateCreate() {$('create').disabled=!canCreate();$('preflight').textContent=`${pdf ? $('filename').textContent || 'PDF selected' : 'Choose a PDF'} · ${recipientLabels().length} signer(s) · ${fields.length} field(s) placed. ${canCreate() ? 'Ready to create private links.' : 'Place one field for every named signer before creating links.'}`;}
function resetReview() {
  reviewReady=false;opened=undefined;
  hide('consent-panel');hide('signing-navigation');$('approve').disabled=true;$('consent').checked=false;
}
const origin=location.origin;
const message=(text,error=false)=>{$('message').textContent=text;$('message').className=error?'error':'';};
function action(id,fn) {
  $(id).addEventListener('click',async()=>{
    $(id).disabled=true;message('Working locally…');
    try{await fn();}catch(e){message(e.message || 'Unable to complete this action',true);}
    finally{$(id).disabled=id==='approve' ? !reviewReady : id==='create' ? !canCreate() : false;}
  });
}
function download(bytes,name,type='application/pdf') {
  const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function render(bytes,target='pages',assigned=[],placing=false,isCurrent=()=>true) {
  $(target).replaceChildren();
  const document=await getDocument({data:bytes.slice(),useSystemFonts:true,isEvalSupported:false}).promise;
  try {
    for(let i=1;i<=document.numPages;i++) {
      if(!isCurrent())return;
      const page=await document.getPage(i),viewport=page.getViewport({scale:1});
      if(!isCurrent())return;
      if(viewport.width>2500 || viewport.height>2500 || viewport.width<1 || viewport.height<1) throw Error('Page dimensions exceed demo rendering limit');
      const canvas=window.document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;canvas.setAttribute('aria-label',`Document page ${i}`);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      if(!isCurrent())return;
      const label=window.document.createElement('p');label.className='page-label';label.textContent=`Page ${i} of ${document.numPages}`;
      const wrapper=window.document.createElement('div');wrapper.className='pdf-page';wrapper.style.maxWidth=viewport.width+'px';
      wrapper.append(canvas);$(target).append(label,wrapper);
      if(placing) {
        if(page.rotate!==0 || page.userUnit!==1 || page.view[0]!==0 || page.view[1]!==0) throw Error('Unsupported page geometry for field placement');
        const place=(left,top)=>{
          if(!isCurrent() || previewRevision!==documentGeneration)return;
          const recipientId=$('field-recipient').value;
          left=Math.max(0,Math.min(viewport.width-220,left));top=Math.max(0,Math.min(viewport.height-60,top));
          const [x,y]=viewport.convertToPdfPoint(left,top+60);
          fields=fields.filter(f=>f.recipientId!==recipientId);
          fields.push({id:'f-'+recipientId,recipientId,page:i,x,y,width:220,height:60});
          drawFields(target,fields);updateCreate();message('Field placed. Click another position to move it.');
        };
        canvas.tabIndex=0;canvas.setAttribute('aria-label',`Document page ${i}. Enter places a field; arrow keys move it by 10 points.`);
        canvas.addEventListener('click',e=>{const rect=canvas.getBoundingClientRect();place((e.clientX-rect.left)*viewport.width/rect.width,(e.clientY-rect.top)*viewport.height/rect.height);});
        canvas.addEventListener('keydown',e=>{
          if(!['Enter',' ','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
          e.preventDefault();const existing=fields.find(f=>f.recipientId===$('field-recipient').value && f.page===i);
          const left=existing?existing.x:(viewport.width-220)/2,top=existing?viewport.height-existing.y-existing.height:(viewport.height-60)/2;
          place(left+(e.key==='ArrowRight'?10:e.key==='ArrowLeft'?-10:0),top+(e.key==='ArrowDown'?10:e.key==='ArrowUp'?-10:0));
        });
      }
      wrapper.dataset.page=i;wrapper.dataset.width=viewport.width;wrapper.dataset.height=viewport.height;
      // Supported placement pages have the identity PDF-to-display transform except Y inversion.
      drawFields(target,assigned);
    }
  } finally {await document.destroy();}
}
function drawFields(target,assigned) {
  $(target).querySelectorAll('.signature-field').forEach(n=>n.remove());
  for(const f of assigned) {
    const wrapper=$(target).querySelector(`[data-page="${f.page}"]`);if(!wrapper)continue;
    const box=document.createElement('div');box.className='signature-field';box.textContent=`${f.recipientId} · Sign here`;box.style.setProperty('--signer',colours[Number(f.recipientId.slice(1))-1]);
    Object.assign(box.style,{left:100*f.x/wrapper.dataset.width+'%',top:100*(wrapper.dataset.height-f.y-f.height)/wrapper.dataset.height+'%',width:100*f.width/wrapper.dataset.width+'%',height:100*f.height/wrapper.dataset.height+'%'});
    if(target==='pages'){box.tabIndex=0;box.setAttribute('aria-label',`Signature field for ${f.recipientId}, page ${f.page}. Use Enter typed signature after reviewing.`);}
    wrapper.append(box);
  }
}
function clearFields() {previewGeneration++;previewRevision=undefined;fields=[];placementLabels=[];hide('placement');$('placement-pages').replaceChildren();updateCreate();}

action('preview-fields',async()=>{
  if(!pdf)throw Error('Choose a PDF first.');
  clearFields();placementLabels=recipientLabels();
  const generation=previewGeneration,revision=documentGeneration,bytes=pdf;
  const isCurrent=()=>generation===previewGeneration && revision===documentGeneration && bytes===pdf;
  if(!placementLabels.length || placementLabels.length>12 || placementLabels.some(label=>!label))throw Error('Enter a name for every signer (1 to 12 people).');
  $('field-recipient').replaceChildren(...placementLabels.map((label,i)=>{const option=document.createElement('option');option.value=`r${i+1}`;option.textContent=label;return option;}));
  show('placement');
  try {await render(bytes,'placement-pages',[],true,isCurrent);}
  catch(e){if(!isCurrent())return;clearFields();throw e;}
  if(!isCurrent())return;
  previewRevision=revision;updateCreate();message('Select a recipient and click a page to place their field.');
});
action('remove-field',async()=>{fields=fields.filter(f=>f.recipientId!==$('field-recipient').value);drawFields('placement-pages',fields);updateCreate();message('Selected field removed.');});
async function open() {
  resetReview();hide('locked');hide('review');
  try {
    opened=await openInvitation(origin,invitation);
    show('review');$('title').textContent='Review. Approve. Return.';$('subtitle').textContent='Your PDF is decrypted and displayed only in this browser.';
    const r=opened.manifest.recipients.find(r=>r.id===invitation.recipientId);
    $('review-for').textContent=`Prepared for ${r.label} · Stage ${r.stage+1} · ${opened.manifest.mode} order`;
    await render(opened.pdf,'pages',(opened.manifest.fields || []).filter(f=>f.recipientId===invitation.recipientId));
    if(opened.state!=='waiting'){hide('consent-panel');message('Approval already returned. Ask the sender to check responses.');}
    else {reviewReady=true;$('approve').disabled=false;show('consent-panel');show('signing-navigation');message('Review all pages, then enter your name and consent.');}
  }catch(e){resetReview();if(e.message==='stage_locked'){show('locked');message('This stage is not available yet.');}else throw e;}
}
let documentGeneration=0;
async function selectDocument(load,filename,readyMessage) {
  const generation=++documentGeneration;
  pdf=undefined;clearFields();$('create').disabled=true;$('filename').textContent='';
  try {
    const bytes=await load();
    if(generation!==documentGeneration)return;
    await inspectPdf(bytes);
    if(generation!==documentGeneration)return;
    // Publish only the validated bytes belonging to the latest selection intent.
    pdf=bytes;$('filename').textContent=filename;updateCreate();message(readyMessage);
  } catch(e) {
    if(generation!==documentGeneration)return;
    message(e.message,true);
  }
}
action('sample',()=>selectDocument(syntheticPdf,'synthetic-agreement.pdf · 2 pages','Sample PDF ready. No real personal data.'));
$('file').addEventListener('change',()=>{
  const f=$('file').files[0];
  return selectDocument(async()=>{
    if(!f)throw Error('Choose a PDF first.');
    if(f.size>180000)throw Error('Demo limit: 180 KB per PDF');
    return new Uint8Array(await f.arrayBuffer());
  },f?.name || '', 'PDF ready. Use only synthetic documents.');
});
$('mode').addEventListener('change',()=>{$('stage-wrap').hidden=$('mode').value!=='grouped';$('stage-wrap').open=$('mode').value==='grouped';});
action('create',async()=>{
  if(!canCreate())throw Error('Preview and place one field per recipient first.');
  creationPending=true;freezeRouting(true);
  try {
  await discardPreparedRequest();
  const labels=recipientLabels(),revision=documentGeneration,generation=previewGeneration,intent=routingIntent();
  const prepared=await prepareRequest(origin,bootstrap,pdf,labels,$('mode').value,$('stages').value.split(',').map(s=>Number(s.trim())-1),fields.map(f=>({...f})));
  if(revision!==documentGeneration || generation!==previewGeneration || intent!==routingIntent()) {
    discardedRequest=prepared;
    await discardPreparedRequest();
    message('Request details changed during creation. Review them and create again.',true);
    return;
  }
  sender=prepared;
  $('invitations').replaceChildren();
  sender.invitations.forEach((inv,i)=>{
    const row=document.createElement('div');row.className='invitation';row.dataset.recipient=inv.recipientId;row.style.setProperty('--signer',colours[i]);
    const name=document.createElement('strong');name.textContent=`${sender.manifest.recipients[i].label} · Stage ${sender.manifest.recipients[i].stage+1}`;
    const a=document.createElement('a');a.href=origin+'/'+invitationFragment(inv);a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open private invitation';a.className='invite-link';a.dataset.invitation='';
    const copy=document.createElement('button');copy.className='secondary';copy.textContent='Copy link';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(a.href);message('Private invitation copied. Share it directly, not through this relay.');}catch{message('Clipboard unavailable. Copy the invitation link using your browser.',true);}});
    copy.setAttribute('aria-label',`Copy link for ${sender.manifest.recipients[i].label}`);
    const status=document.createElement('span');status.className='status';
    const controls=document.createElement('div');controls.append(a,copy);row.append(name,status,controls);$('invitations').append(row);
  });
  hide('prepare');show('manage');$('progress').textContent=`0 of ${labels.length} accepted`;message('Request ready. Invitations stay in this tab.');
  updateStatuses(sender.manifest.recipients.map(r=>({...r,state:'waiting'})));
  responseChecker=createResponseChecker({collect:()=>collectApprovals(origin,sender),visible:()=>!document.hidden,isTerminal:value=>value.approvals.length===sender.manifest.recipients.length,onResult:displayCollected,onError:error=>{
    $('auto-status').textContent=error.message==='not_found'?'Request expired or revoked. Automatic checking stopped.':'Automatic checking paused after an error. Choose Check responses to retry.';
    if(error.message==='not_found')responseChecker.stop();
    message(error.message==='not_found'?'This request is no longer available. Previously downloaded copies cannot be recalled.':error.message,true);
  }});
  responseChecker.start();
  } finally {creationPending=false;freezeRouting(false);updateCreate();}
});
function updateStatuses(recipients){
  for(const r of recipients){
    const locked=recipients.some(other=>other.stage<r.stage && other.state!=='accepted');
    const status=$('invitations').querySelector(`[data-recipient="${r.id}"] .status`);
    status.textContent=r.state==='accepted'?'Accepted · validated by this sender':r.state==='submitted'?'Returned · awaiting validation':locked?'Waiting for earlier signers':'Ready to sign · awaiting response';
  }
}
function displayCollected(value){
  collected=value;updateStatuses(value.recipients);
  $('progress').textContent=`${collected.approvals.length} of ${sender.manifest.recipients.length} accepted`;
  $('download-final').disabled=collected.approvals.length!==sender.manifest.recipients.length;
  $('evidence').disabled=!collected.approvals.length;
  $('returned').replaceChildren();
  for(const artifact of collected.artifacts){const b=document.createElement('button');b.className='secondary';b.textContent=`Download ${artifact.recipientId} returned PDF`;b.onclick=()=>download(artifact.pdf,`approved-${artifact.recipientId}.pdf`);$('returned').append(b);}
  $('auto-status').textContent=collected.approvals.length===sender.manifest.recipients.length?'Request complete. Automatic checking stopped.':'Checked just now. Checking every 5 seconds while this tab is visible.';
}
$('refresh').addEventListener('click',async()=>{$('refresh').disabled=true;try{await responseChecker?.check();}finally{$('refresh').disabled=false;}});
document.addEventListener('visibilitychange',()=>{responseChecker?.visibilityChanged();});
action('download-final',async()=>{download(await finalise(sender,collected.approvals),'completed-approval.pdf');message('Completed PDF downloaded with separate approval receipt pages.');});
action('evidence',async()=>{download(JSON.stringify({version:sender.version,manifest:sender.manifest,approvals:collected.approvals},null,2),'approval-evidence.json','application/json');message('Evidence exported. It contains self-asserted names, not verified identities.');});
action('revoke',async()=>{await api(origin,`/api/requests/${sender.id}`,sender.adminToken,'DELETE');responseChecker?.stop();hide('manage');sender=undefined;message('Request revoked. Previously downloaded copies cannot be recalled.');});
action('approve',async()=>{
  if(!reviewReady || !opened || opened.state!=='waiting')throw Error('Every page must render successfully before approving.');
  if(!$('consent').checked)throw Error('Confirm that you reviewed every page before approving.');
  ownPdf=await submitApproval(origin,invitation,opened,$('name').value);
  resetReview();show('download-own');show('success-panel');
  $('completion-status').textContent='Other signers’ current status is not known in this recipient tab. The sender validates responses and can confirm when the complete PDF is ready.';
  $('success-panel').scrollIntoView({block:'center'});$('success-panel').focus({preventScroll:true});message('Approval returned. Your own copy is ready to download.');
});
$('start-signing').addEventListener('click',()=>{if(!reviewReady)return;const field=$('pages').querySelector('.signature-field');if(field){field.scrollIntoView({block:'center'});field.focus({preventScroll:true});}else{$('name').focus();}message('This is your assigned field. Review the document, then enter your typed signature.');});
$('enter-signature').addEventListener('click',()=>{if(reviewReady){$('name').scrollIntoView({block:'center'});$('name').focus({preventScroll:true});message('Type your name, check the preview, then confirm your consent.');}});
$('name').addEventListener('input',()=>{$('signature-preview').textContent=$('name').value.trim();});
action('download-own',async()=>{download(ownPdf,'my-electronic-approval.pdf');message('Your approved PDF downloaded.');});
action('retry',open);
try {
  const fragment=new URLSearchParams(location.hash.slice(1));
  history.replaceState(null,'',location.pathname);
  if(fragment.has('invite')){invitation=JSON.parse(fragment.get('invite'));await open();}
  else if(fragment.has('setup')){bootstrap=fragment.get('setup');show('prepare');}
  else show('no-access');
}catch(e){message(e.message,true);}
window.addEventListener('hashchange',()=>{if(location.hash)location.reload();});
window.addEventListener('beforeunload',e=>{if(sender){e.preventDefault();e.returnValue='';}});
