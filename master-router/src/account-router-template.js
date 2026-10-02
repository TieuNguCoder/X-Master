export function renderAccountRouterSource() {
  return `
function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}

const enc=new TextEncoder();

async function hmacHex(secret,value){
  const key=await crypto.subtle.importKey(
    "raw",enc.encode(String(secret)),
    {name:"HMAC",hash:"SHA-256"},
    false,["sign"]
  );
  const sig=await crypto.subtle.sign("HMAC",key,enc.encode(String(value)));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function safeEqual(a,b){
  const aa=enc.encode(String(a||""));
  const bb=enc.encode(String(b||""));
  if(aa.length!==bb.length)return false;
  let diff=0;
  for(let i=0;i<aa.length;i++)diff|=aa[i]^bb[i];
  return diff===0;
}

async function verifyDispatch(request,env,action,body){
  const issued=Number(request.headers.get("x-router-issued")||0);
  const signature=request.headers.get("x-router-signature")||"";
  const now=Math.floor(Date.now()/1000);
  if(!Number.isFinite(issued)||Math.abs(now-issued)>300){
    throw Object.assign(new Error("dispatch_expired"),{status:401});
  }
  const eventId=String(body.event_id||"");
  const accountId=String(body.account_id||"");
  if(!eventId||!accountId){
    throw Object.assign(new Error("dispatch_payload_invalid"),{status:400});
  }
  const material=[env.ROUTER_SLOT_ID,eventId,accountId,action,String(issued)].join("|");
  const expected=await hmacHex(env.ROUTER_SECRET,material);
  if(!safeEqual(signature,expected)){
    throw Object.assign(new Error("dispatch_unauthorized"),{status:401});
  }
}

async function masterFetch(env,path,init={}){
  const headers=new Headers(init.headers||{});
  headers.set("content-type","application/json");
  headers.set("x-router-slot",env.ROUTER_SLOT_ID);
  headers.set("x-router-secret",env.ROUTER_SECRET);
  const target=new Request("https://x-master.internal"+path,{...init,headers});
  if(env.MASTER&&typeof env.MASTER.fetch==="function"){
    return env.MASTER.fetch(target);
  }
  return fetch(env.MASTER_ROOT.replace(/\\\/$/,"")+path,{...init,headers});
}

async function proxyBody(env,path,body){
  const response=await masterFetch(env,path,{
    method:"POST",
    body:JSON.stringify(body)
  });
  return new Response(await response.text(),{
    status:response.status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    try{
      if(url.pathname==="/health"&&request.method==="GET"){
        const response=await masterFetch(env,"/internal/router/health",{method:"GET"});
        const body=await response.json().catch(()=>({}));
        const ok=response.ok&&body.ok===true&&body.slot_id===env.ROUTER_SLOT_ID;
        return json({
          ok,
          slot_id:env.ROUTER_SLOT_ID,
          child_id:env.CHILD_ID,
          account_id:body.account_id||null,
          master:ok,
          service_binding:Boolean(env.MASTER)
        },ok?200:503);
      }

      if((url.pathname==="/process"||url.pathname==="/publish")&&request.method==="POST"){
        const body=await request.json().catch(()=>null);
        if(!body)return json({error:"invalid_json"},400);
        const action=url.pathname==="/process"?"process":"publish";
        await verifyDispatch(request,env,action,body);
        return proxyBody(
          env,
          action==="process"?"/internal/router/process":"/internal/router/publish",
          body
        );
      }

      return new Response("Not found",{status:404});
    }catch(error){
      return json({error:String(error?.message||error||"internal_error")},Number(error?.status||500));
    }
  }
};
`;
}
