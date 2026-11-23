import {createServer} from 'node:http'
import {expect, it} from 'vitest'
import {queueModel, startApp} from '../support/app.js'

it('edits a copy through the protected studio endpoint and rejects a stale draft',async()=>{
  const host=createServer((req,res)=>{
    const allowed=req.url==='/api/settings' && req.headers['x-tolongai-token']==='fixture-token'
    res.writeHead(allowed?200:401,{'content-type':'application/json'}).end(JSON.stringify(allowed?{markets:{}}:{}))
  })
  await new Promise<void>(resolve=>host.listen(0,'127.0.0.1',resolve))
  try {
    const address=host.address()
    if(!address||typeof address==='string')throw new Error('test listener unavailable')
    const {app}=await startApp(queueModel([]),{env:{AIRA_OWNER_API_ORIGIN:'http://127.0.0.1:'+address.port}})
    const site=await app.listenSite(0,'127.0.0.1')
    const origin='http://127.0.0.1:'+site.port
    const base=origin+'/owner-api/core/characters'
    const headers={'x-tolongai-token':'fixture-token','content-type':'application/json'}
    expect((await fetch(base+'/example/studio')).status).toBe(401)
    expect((await fetch(origin+'/api/characters/example/studio')).status).toBe(404)
    const copy=await fetch(base,{method:'POST',headers,body:JSON.stringify({sourceId:'example',id:'sample-copy'})})
    expect(copy.status).toBe(201)
    expect(copy.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
    const url=base+'/sample-copy/studio'
    const read=await fetch(url,{headers})
    expect(read.headers.get('cache-control')).toBe('no-store')
    const {revision}=await read.json() as {revision:string}
    const update=()=>fetch(url,{method:'PUT',headers,body:JSON.stringify({expectedRevision:revision,patch:{card:{displayName:'Blue Comet'}}})})
    expect((await update()).status).toBe(200)
    expect((await update()).status).toBe(409)
    expect(app.packs().packs.get('sample-copy')?.card.displayName).toBe('Blue Comet')
  } finally {
    host.closeAllConnections()
    await new Promise<void>(resolve=>host.close(()=>resolve()))
  }
})
