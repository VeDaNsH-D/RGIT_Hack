import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import rateLimit from 'express-rate-limit';
import { requireMcpKey } from './keys.js';
import { createProjectMcpServer } from './server.js';
import { config } from '../config.js';
export function createMcpRouter({apiBaseUrl}={}){
  const router=Router();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    const hosts=new Set(['localhost','127.0.0.1','[::1]',new URL(config.apiBaseUrl).hostname]);
    let hostname;try{hostname=new URL(`http://${req.headers.host}`).hostname;}catch{return res.status(400).json({message:'Invalid host.'});}
    if(!hosts.has(hostname))return res.status(403).json({message:'MCP host is not allowed. Configure API_BASE_URL for this deployment.'});
    if(req.headers.origin&&!config.corsOrigins.includes(req.headers.origin))return res.status(403).json({message:'MCP origin is not allowed.'});
    next();
  });
  router.use(rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}));
  router.use(requireMcpKey);
  router.post('/',async(req,res,next)=>{
    const server=createProjectMcpServer({identity:req.mcpIdentity,apiBaseUrl:apiBaseUrl||`http://127.0.0.1:${req.socket.localPort}`});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
    try { await server.connect(transport);await transport.handleRequest(req,res,req.body); }
    catch(error){if(!res.headersSent)next(error);}
  });
  router.all('/',(req,res)=>res.status(405).set('Allow','POST').json({message:'This stateless MCP endpoint accepts POST requests.'}));
  return router;
}
export default createMcpRouter();
