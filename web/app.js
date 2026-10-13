import { prepareRequest, invitationFragment, openInvitation, submitApproval, collectApprovals, finalise, api } from '/src/approval-client.js';
import { syntheticPdf, inspectPdf } from '/src/approval-pdf.js';
import { getDocument, GlobalWorkerOptions } from '/vendor/pdf.mjs';
GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
const $=id=>document.getElementById(id);
const show=id=>$(id).hidden=false, hide=id=>$(id).hidden=true;
let pdf, sender, opened, invitation, ownPdf, collected, bootstrap;
let reviewReady=false;
let fields=[],placementLabels=[];
let previewGeneration=0,previewRevision,creationPending=false;
const recipientLabels=()=>$('recipients').value.split('\n').map(s=>s.trim()).filter(Boolean);
function canCreate() {
  const labels=recipientLabels();
  return !!pdf && !creationPending && previewRevision===documentGeneration && labels.length>0 && fields.length===labels.length && JSON.stringify(labels)===JSON.stringify(placementLabels);
}
function updateCreate() {$('create').disabled=!canCreate();}
function resetReview() {
  reviewReady=false;opened=undefined;
  hide('consent-panel');$('approve').disabled=true;$('consent').checked=false;
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
        canvas.addEventListener('click',e=>{
          if(!isCurrent() || previewRevision!==documentGeneration)return;
          const rect=canvas.getBoundingClientRect(),recipientId=$('field-recipient').value;
          const left=Math.max(0,Math.min(viewport.width-220,(e.clientX-rect.left)*viewport.width/rect.width));
          const top=Math.max(0,Math.min(viewport.height-60,(e.clientY-rect.top)*viewport.height/rect.height));
          const [x,y]=viewport.convertToPdfPoint(left,top+60);
          fields=fields.filter(f=>f.recipientId!==recipientId);
          fields.push({id:'f-'+recipientId,recipientId,page:i,x,y,width:220,height:60});
          drawFields(target,fields);updateCreate();message('Field placed. Click another position to move it.');
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
    const box=document.createElement('div');box.className='signature-field';box.textContent=`${f.recipientId} · Sign here`;
    Object.assign(box.style,{left:100*f.x/wrapper.dataset.width+'%',top:100*(wrapper.dataset.height-f.y-f.height)/wrapper.dataset.height+'%',width:100*f.width/wrapper.dataset.width+'%',height:100*f.height/wrapper.dataset.height+'%'});
    wrapper.append(box);
  }
}
function clearFields() {previewGeneration++;previewRevision=undefined;fields=[];placementLabels=[];hide('placement');$('placement-pages').replaceChildren();updateCreate();}
$('recipients').addEventListener('input',clearFields);
action('preview-fields',async()=>{
  if(!pdf)throw Error('Choose a PDF first.');
  clearFields();placementLabels=recipientLabels();
  const generation=previewGeneration,revision=documentGeneration,bytes=pdf;
  const isCurrent=()=>generation===previewGeneration && revision===documentGeneration && bytes===pdf;
  if(!placementLabels.length || placementLabels.length>12)throw Error('Enter 1 to 12 recipients.');
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
    else {reviewReady=true;$('approve').disabled=false;show('consent-panel');message('Review all pages, then enter your name and consent.');}
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
$('mode').addEventListener('change',()=>{$('stage-wrap').hidden=$('mode').value!=='grouped';});
action('create',async()=>{
  if(!canCreate())throw Error('Preview and place one field per recipient first.');
  const labels=recipientLabels(),revision=documentGeneration,generation=previewGeneration;
  creationPending=true;
  let prepared;
  try {prepared=await prepareRequest(origin,bootstrap,pdf,labels,$('mode').value,$('stages').value.split(',').map(s=>Number(s.trim())-1),fields.map(f=>({...f})));}
  finally {creationPending=false;updateCreate();}
  if(revision!==documentGeneration || generation!==previewGeneration)return;
  sender=prepared;
  $('invitations').replaceChildren();
  sender.invitations.forEach((inv,i)=>{
    const row=document.createElement('div');row.className='invitation';
    const name=document.createElement('strong');name.textContent=`${sender.manifest.recipients[i].label} · Stage ${sender.manifest.recipients[i].stage+1}`;
    const a=document.createElement('a');a.href=origin+'/'+invitationFragment(inv);a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open private invitation';a.className='invite-link';a.dataset.invitation='';
    const copy=document.createElement('button');copy.className='secondary';copy.textContent='Copy link';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(a.href);message('Private invitation copied. Share it directly, not through this relay.');}catch{message('Clipboard unavailable. Copy the invitation link using your browser.',true);}});
    const controls=document.createElement('div');controls.append(a,copy);row.append(name,controls);$('invitations').append(row);
  });
  hide('prepare');show('manage');$('progress').textContent=`0 of ${labels.length} accepted`;message('Request ready. Invitations stay in this tab.');
});
action('refresh',async()=>{
  collected=await collectApprovals(origin,sender);
  $('progress').textContent=`${collected.approvals.length} of ${sender.manifest.recipients.length} accepted`;
  $('download-final').disabled=collected.approvals.length!==sender.manifest.recipients.length;
  $('evidence').disabled=!collected.approvals.length;
  $('returned').replaceChildren();
  for(const artifact of collected.artifacts){const b=document.createElement('button');b.className='secondary';b.textContent=`Download ${artifact.recipientId} returned PDF`;b.onclick=()=>download(artifact.pdf,`approved-${artifact.recipientId}.pdf`);$('returned').append(b);}
  message('Encrypted responses checked locally. Eligible stages are now available.');
});
action('download-final',async()=>{download(await finalise(sender,collected.approvals),'completed-approval.pdf');message('Completed PDF downloaded with separate approval receipt pages.');});
action('evidence',async()=>{download(JSON.stringify({version:sender.version,manifest:sender.manifest,approvals:collected.approvals},null,2),'approval-evidence.json','application/json');message('Evidence exported. It contains self-asserted names, not verified identities.');});
action('revoke',async()=>{await api(origin,`/api/requests/${sender.id}`,sender.adminToken,'DELETE');hide('manage');sender=undefined;message('Request revoked. Previously downloaded copies cannot be recalled.');});
action('approve',async()=>{
  if(!reviewReady || !opened || opened.state!=='waiting')throw Error('Every page must render successfully before approving.');
  if(!$('consent').checked)throw Error('Confirm that you reviewed every page before approving.');
  ownPdf=await submitApproval(origin,invitation,opened,$('name').value);
  resetReview();show('download-own');message('Approval returned. Ask the sender to check responses.');
});
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
