import { Router } from 'express';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { McpOAuthClient, McpOAuthRequest, McpOAuthToken } from '../models/McpOAuth.js';
import { McpAccessKey } from '../models/McpAccessKey.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { User } from '../models/User.js';
import { keyHash } from './keys.js';
export const publicMcpUrl=()=>new URL('/mcp',config.apiBaseUrl).href;
const issuer=()=>new URL(config.apiBaseUrl).origin;
const encryptionKey=()=>createHash('sha256').update(`mcp-oauth-client:${config.jwtSecret}`).digest();
function seal(value){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');}
function unseal(value){const data=Buffer.from(value,'base64');const cipher=createDecipheriv('aes-256-gcm',encryptionKey(),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}
function checkResource(resource){if(resource&&resource.href!==publicMcpUrl())throw new InvalidTargetError('This authorization is only valid for the Over2u MCP resource.');}
const scopesFor=key=>key.oauthScopes?.length?key.oauthScopes:['projects:read'];
async function activeKey(id,client){const key=await McpAccessKey.findOne({_id:id,oauthClientId:client.client_id,revokedAt:null,expiresAt:{$gt:new Date()}}).lean();const user=key?await User.findById(key.userId):null;if(!key||!user||user.disabled)throw new InvalidGrantError('This connection was revoked or expired. Connect again.');return key;}
async function newAccessToken(key){const token=`oto_${randomBytes(32).toString('hex')}`;await McpOAuthToken.create({tokenHash:keyHash(token),keyId:key._id,expiresAt:new Date(Date.now()+3600000)});return token;}
async function tokens(key){const access_token=await newAccessToken(key);const refresh_token=`otr_${randomBytes(32).toString('hex')}`;await McpAccessKey.updateOne({_id:key._id},{$set:{refreshTokenHash:keyHash(refresh_token)}});return {access_token,refresh_token,token_type:'Bearer',expires_in:3600,scope:scopesFor(key).join(' ')};}
export const oauthProvider={
  clientsStore:{
    async getClient(clientId){const row=await McpOAuthClient.findOne({clientId}).select('+sealedSecret').lean();if(!row)return undefined;return {...row.metadata,...(row.sealedSecret?{client_secret:unseal(row.sealedSecret)}:{})};},
    async registerClient(client){
      if(!client.redirect_uris?.length||client.redirect_uris.length>10)throw new InvalidClientMetadataError('Provide 1–10 redirect URLs.');
      for(const raw of client.redirect_uris){const url=new URL(raw);if(raw.length>2000||url.hash||url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new InvalidClientMetadataError('Redirect URLs must use HTTPS or localhost HTTP.');}
      const metadata={...client,client_id:client.client_id||randomUUID(),client_id_issued_at:Math.floor(Date.now()/1000)};delete metadata.client_secret;
      if((metadata.client_name||'').length>100)throw new InvalidClientMetadataError('Client name is too long.');
      await McpOAuthClient.create({clientId:metadata.client_id,metadata,sealedSecret:client.client_secret?seal(client.client_secret):undefined});
      return {...metadata,...(client.client_secret?{client_secret:client.client_secret}:{})};
    },
  },
  async authorize(client,params,res){
    checkResource(params.resource);
    const scopes=params.scopes?.length?params.scopes:['projects:read'];
    if(scopes.some(scope=>!['projects:read','projects:write'].includes(scope)))throw new InvalidScopeError('Supported scopes are projects:read and projects:write.');
    if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)||(params.state||'').length>2048)throw new InvalidGrantError('Invalid PKCE challenge or state.');
    const requestId=randomBytes(32).toString('hex');
    await McpOAuthRequest.create({requestHash:keyHash(requestId),clientId:client.client_id,redirectUri:params.redirectUri,state:params.state,scopes,codeChallenge:params.codeChallenge,resource:publicMcpUrl(),expiresAt:new Date(Date.now()+600000)});
    const url=new URL('/mcp/authorize',config.frontendUrl);url.searchParams.set('request',requestId);res.redirect(url.href);
  },
  async challengeForAuthorizationCode(client,code){const request=await McpOAuthRequest.findOne({clientId:client.client_id,codeHash:keyHash(code),status:'approved',codeExpiresAt:{$gt:new Date()},expiresAt:{$gt:new Date()}}).lean();if(!request)throw new InvalidGrantError('Invalid or expired authorization code.');return request.codeChallenge;},
  async exchangeAuthorizationCode(client,code,_verifier,redirectUri,resource){
    checkResource(resource);
    const request=await McpOAuthRequest.findOne({clientId:client.client_id,codeHash:keyHash(code),status:'approved',codeExpiresAt:{$gt:new Date()},expiresAt:{$gt:new Date()}}).lean();
    if(!request||redirectUri!==request.redirectUri)throw new InvalidGrantError('Invalid authorization code or redirect URL.');
    const key=await activeKey(request.keyId,client);
    if(key.oauthResource!==publicMcpUrl())throw new InvalidTargetError('Resource mismatch.');
    const claimed=await McpOAuthRequest.updateOne({_id:request._id,status:'approved'},{$set:{status:'exchanged'}});if(!claimed.modifiedCount)throw new InvalidGrantError('Authorization code already used.');
    return tokens(key);
  },
  async exchangeRefreshToken(client,token,scopes,resource){
    checkResource(resource);
    const key=await McpAccessKey.findOne({oauthClientId:client.client_id,refreshTokenHash:keyHash(token),revokedAt:null,expiresAt:{$gt:new Date()}}).lean();
    if(!key)throw new InvalidGrantError('Invalid refresh token.');await activeKey(key._id,client);
    if(key.oauthResource!==publicMcpUrl())throw new InvalidTargetError('Resource mismatch.');
    if(scopes && [...scopes].sort().join(' ')!==[...scopesFor(key)].sort().join(' '))throw new InvalidScopeError('Reconnect to change scopes; refresh cannot change access.');
    const refresh_token=`otr_${randomBytes(32).toString('hex')}`;
    const claimed=await McpAccessKey.updateOne({_id:key._id,refreshTokenHash:keyHash(token),revokedAt:null},{$set:{refreshTokenHash:keyHash(refresh_token)}});
    if(!claimed.modifiedCount)throw new InvalidGrantError('Refresh token already used.');
    return {access_token:await newAccessToken(key),refresh_token,token_type:'Bearer',expires_in:3600,scope:scopesFor(key).join(' ')};
  },
  async verifyAccessToken(token){const identity=await oauthIdentity(token);if(!identity)throw new InvalidTokenError('Invalid access token.');return {token,clientId:identity.key.oauthClientId,scopes:scopesFor(identity.key),resource:new URL(identity.key.oauthResource)};},
  async revokeToken(client,request){
    const access=await McpOAuthToken.findOne({tokenHash:keyHash(request.token)}).lean();
    const filter=access?{_id:access.keyId}:{refreshTokenHash:keyHash(request.token)};
    await McpAccessKey.updateOne({...filter,oauthClientId:client.client_id},{$set:{revokedAt:new Date()}});
  },
};
export async function oauthIdentity(token){
  if(!/^oto_[a-f0-9]{64}$/.test(token||''))return null;
  const access=await McpOAuthToken.findOne({tokenHash:keyHash(token),expiresAt:{$gt:new Date()}}).lean();
  const key=access?await McpAccessKey.findOne({_id:access.keyId,revokedAt:null,expiresAt:{$gt:new Date()},oauthResource:publicMcpUrl()}).lean():null;
  const user=key?await User.findById(key.userId):null;return key&&user&&!user.disabled?{key,user}:null;
}
export const oauthRouter=mcpAuthRouter({provider:oauthProvider,issuerUrl:new URL(issuer()),resourceServerUrl:new URL(publicMcpUrl()),scopesSupported:['projects:read','projects:write'],resourceName:'Over2u projects'});
export const consentRouter=Router();
consentRouter.use((req,res,next)=>{if(!req.headers.authorization?.startsWith('Bearer '))return res.status(401).json({message:'Sign in before authorizing an AI connection.'});next();},requireAuth);
async function pending(req,res){const requestId=req.params.id;if(!/^[a-f0-9]{64}$/.test(requestId||'')){res.status(400).json({message:'Invalid connection request.'});return null;}const row=await McpOAuthRequest.findOne({requestHash:keyHash(requestId),status:'pending',expiresAt:{$gt:new Date()}}).lean();if(!row){res.status(410).json({message:'This connection request expired or was already completed. Start again from your AI client.'});return null;}return row;}
consentRouter.get('/:id',async(req,res,next)=>{try{res.set('Cache-Control','no-store');const row=await pending(req,res);if(!row)return;const client=await oauthProvider.clientsStore.getClient(row.clientId);res.json({clientName:client?.client_name||'AI client',redirectUri:row.redirectUri,requestedAccess:row.scopes.includes('projects:write')?'write':'read',expiresAt:row.expiresAt});}catch(error){next(error);}});
consentRouter.post('/:id',async(req,res,next)=>{
  try{
    res.set('Cache-Control','no-store');const row=await pending(req,res);if(!row)return;
    const redirect=new URL(row.redirectUri);if(row.state)redirect.searchParams.set('state',row.state);
    if(req.body?.decision==='deny'){const changed=await McpOAuthRequest.updateOne({_id:row._id,status:'pending'},{$set:{status:'denied'}});if(!changed.modifiedCount)return res.status(409).json({message:'Request already completed.'});redirect.searchParams.set('error','access_denied');return res.json({redirectUrl:redirect.href});}
    if(req.body?.decision!=='allow'||!Array.isArray(req.body.projectIds)||!req.body.projectIds.length||req.body.projectIds.length>50||req.body.projectIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{24}$/i.test(id)))return res.status(400).json({message:'Choose at least one project to connect.'});
    const projectIds=[...new Set(req.body.projectIds)];const memberships=await ProjectMembership.find({userId:req.user._id,projectId:{$in:projectIds}}).lean();
    if(memberships.length!==projectIds.length)return res.status(403).json({message:'You can only connect your own projects.'});
    if(req.body.access && !['read','write'].includes(req.body.access))return res.status(400).json({message:'Choose read or write access.'});
    if(req.body.access==='write'&&!row.scopes.includes('projects:write'))return res.status(400).json({message:'This client did not request write access.'});
    const write=req.body.access==='write';if(write&&memberships.some(item=>item.role==='viewer'))return res.status(403).json({message:'A viewer cannot grant write access. Connect with read access or choose other projects.'});
    const client=await oauthProvider.clientsStore.getClient(row.clientId);
    const key=await McpAccessKey.create({userId:req.user._id,name:`${client?.client_name||'AI client'} (OAuth)`.slice(0,80),tokenHash:keyHash(randomBytes(32).toString('hex')),prefix:'OAuth',projectIds,access:write?'write':'read',expiresAt:new Date(Date.now()+30*86400000),oauthClientId:row.clientId,oauthScopes:write?['projects:read','projects:write']:['projects:read'],oauthResource:row.resource});
    const code=randomBytes(32).toString('hex');const claimed=await McpOAuthRequest.updateOne({_id:row._id,status:'pending'},{$set:{status:'approved',keyId:key._id,codeHash:keyHash(code),codeExpiresAt:new Date(Date.now()+120000)}});
    if(!claimed.modifiedCount){await McpAccessKey.updateOne({_id:key._id},{$set:{revokedAt:new Date()}});return res.status(409).json({message:'Request already completed.'});}
    redirect.searchParams.set('code',code);res.json({redirectUrl:redirect.href});
  }catch(error){next(error);}
});
