import assert from 'node:assert/strict';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
export const base = process.env.SMOKE_APP_URL || 'http://127.0.0.1:3000';
export async function sessionClient(email = process.env.DASHBOARD_ADMIN_EMAIL || 'admin@assetdesk.local', password = process.env.DASHBOARD_ADMIN_PASSWORD) {
  let cookie,csrf;
  async function request(path,{method='GET',body}={}) {
    const response=await fetch(`${base}/api/desk${path}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});
    const data=await response.json();assert.ok(response.ok,`${method} ${path}: HTTP ${response.status} ${data.error||''}`);
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];if(data.csrfToken)csrf=data.csrfToken;
    return data;
  }
  await request('/login',{method:'POST',body:{email,password}});
  return {request,get cookie(){return cookie;},logout:()=>request('/logout',{method:'POST',body:{}})};
}
