export function renderAccountRouterSource() {
  return `
function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}

async function masterFetch(env,path,init={}){
  const headers=new Headers(init.headers||{});
  headers.set("content-type","application/json");
  headers.set("x-router-slot",env.ROUTER_SLOT_ID);
  headers.set("x-router-secret",env.ROUTER_SECRET);
  return fetch(env.MASTER_ROOT.replace(/\\\/$/,"")+path,{...init,headers});
}

async function proxy(request,env,path){
  const response=await masterFetch(env,path,{
    method:request.method,
    body:["GET","HEAD"].includes(request.method)?undefined:await request.text()
  });
  return new Response(await response.text(),{
    status:response.status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);

    if(url.pathname==="/health"&&request.method==="GET"){
      try{
        const response=await masterFetch(env,"/internal/router/health",{method:"GET"});
        const body=await response.json().catch(()=>({}));
        const ok=response.ok&&body.ok===true&&body.slot_id===env.ROUTER_SLOT_ID;
        return json({
          ok,
          slot_id:env.ROUTER_SLOT_ID,
          child_id:env.CHILD_ID,
          account_id:body.account_id||null,
          master:ok
        },ok?200:503);
      }catch{
        return json({ok:false,slot_id:env.ROUTER_SLOT_ID,child_id:env.CHILD_ID,master:false},503);
      }
    }

    if((url.pathname==="/process"||url.pathname==="/publish")&&request.method==="POST"){
      const provided=request.headers.get("x-master-router-secret")||"";
      if(!provided||provided!==env.ROUTER_SECRET) return json({error:"unauthorized"},401);
      return proxy(request,env,url.pathname==="/process"?"/internal/router/process":"/internal/router/publish");
    }

    return new Response("Not found",{status:404});
  }
};
`;
}
