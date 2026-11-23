import {createServer} from 'node:http'
import {expect,it} from 'vitest'
import {resolveSetting} from '../../src/settings/settings.js'
import {queueModel,startApp} from '../support/app.js'

it('rejects stale scope writes and restores the inherited value through the owner API',async()=>{
  const host=createServer((req,res)=>{
    const ok=req.url==='/api/settings' && req.headers['x-tolongai-token']==='fixture-token'
    res.writeHead(ok?200:401,{'content-type':'application/json'}).end(JSON.stringify(ok?{markets:{}}:{}))
  })
  await new Promise<void>(done=>host.listen(0,'127.0.0.1',done))
  try{
    const address=host.address()
    if(!address || typeof address==='string')throw new Error('No host listener')
    const {app,chatId}=await startApp(queueModel([]),{env:{AIRA_OWNER_API_ORIGIN:'http://127.0.0.1:'+address.port}})
    const site=await app.listenSite(0,'127.0.0.1')
    const api='http://127.0.0.1:'+site.port+'/owner-api/core/settings'
    const headers={'x-tolongai-token':'fixture-token','content-type':'application/json'}
    const read=async(level:string,scope:string)=>(await fetch(api+'?'+new URLSearchParams({level,scope}),{headers})).json() as Promise<{revision:string;values:Record<string,unknown>;effective:Record<string,{level:string;value:unknown}>}>
    const write=(level:string,scope:string,value:unknown,expectedRevision?:string)=>fetch(api,{method:'PUT',headers,body:JSON.stringify({level,scope,key:'language',value,expectedRevision})})
    expect((await fetch(api+'?level=global')).status).toBe(401)
    const first=await read('chat',chatId)
    const parent=await read('type','group')
    expect((await write('type','group','fr',parent.revision)).status).toBe(200)
    expect((await write('chat',chatId,'ja',first.revision)).status).toBe(409)
    expect((await write('chat',chatId,'ja')).status).toBe(428)
    const inherited=await read('chat',chatId)
    expect(inherited.effective.language).toEqual({level:'type',value:'fr'})
    const [one,two]=await Promise.all([write('chat',chatId,'ja',inherited.revision),write('chat',chatId,'en',inherited.revision)])
    expect([one.status,two.status].sort()).toEqual([200,409])
    const local=await read('chat',chatId)
    expect(resolveSetting(app.storage,{type:'group',chatId},'language').value).toBe(local.values.language)
    expect(await (await write('chat',chatId,local.values.language,local.revision)).json()).toMatchObject({changed:false})
    expect((await write('chat',chatId,null,local.revision)).status).toBe(200)
    expect((await read('chat',chatId)).effective.language).toEqual({level:'type',value:'fr'})
    const audit=app.storage.read(db=>db.prepare("SELECT COUNT(*) FROM setting_change WHERE target='setting' AND key='language' AND actor='site'").pluck().get())
    expect(audit).toBe(3)
  }finally{host.closeAllConnections();await new Promise<void>(done=>host.close(()=>done()))}
})
