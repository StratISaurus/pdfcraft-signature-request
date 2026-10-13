export const VERSION = 'pdfcraft-approval-v1';
export const toBase64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
export const fromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
}
export function validateManifest(m) {
  if (!m || m.version !== VERSION || !/^[a-f0-9]{64}$/.test(m.documentHash) ||
      !/^[a-f0-9-]{36}$/.test(m.requestId) || !['any','sequential','grouped'].includes(m.mode) ||
      !Array.isArray(m.recipients) || m.recipients.length < 1 || m.recipients.length > 12) throw Error('Invalid manifest');
  m.recipients.forEach((r,i) => {
    if (r.id !== `r${i+1}` || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 80 ||
        !Number.isInteger(r.stage) || r.stage < 0 || r.stage > i ||
        (i && r.stage < m.recipients[i-1].stage) ||
        (m.mode === 'any' && r.stage !== 0) || (m.mode === 'sequential' && r.stage !== i) ||
        (i && r.stage > m.recipients[i-1].stage + 1)) throw Error('Invalid recipient or stage');
  });
  if(m.fields!==undefined) {
    if(!Array.isArray(m.fields) || m.fields.length>12) throw Error('Invalid fields');
    const ids=new Set(),owners=new Set();
    for(const f of m.fields) {
      if(!f || typeof f.id!=='string' || !/^[a-zA-Z0-9-]{1,40}$/.test(f.id) || ids.has(f.id) || owners.has(f.recipientId) || !m.recipients.some(r=>r.id===f.recipientId) || !Number.isInteger(f.page) || f.page<1 || f.page>10 || !['x','y','width','height'].every(k=>Number.isFinite(f[k])) || f.x<0 || f.y<0 || f.width<160 || f.height<50) throw Error('Invalid signature field ownership or geometry');
      ids.add(f.id);owners.add(f.recipientId);
    }
    if(m.fields.length && owners.size!==m.recipients.length) throw Error('Every recipient requires a field');
  }
  return m;
}
export async function makeManifest(pdf, labels, mode, stages = [], fields = []) {
  return validateManifest({version:VERSION, requestId:crypto.randomUUID(), documentHash:await digest(pdf), mode, fields,
    recipients:labels.map((label,i) => ({id:`r${i+1}`,label:label.trim(),stage:mode === 'any' ? 0 : mode === 'sequential' ? i : stages[i]}))});
}
export async function manifestHash(m) { validateManifest(m); return digest(new TextEncoder().encode(JSON.stringify(m))); }
