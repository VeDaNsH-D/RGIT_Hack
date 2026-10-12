import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { McpAccessKey } from '../models/McpAccessKey.js';
import { ProjectMembership } from '../models/ProjectMembership.js';
import { User } from '../models/User.js';
import { oauthIdentity, publicMcpUrl } from './oauth.js';
export const keyHash = value => createHash('sha256').update(value).digest('hex');
export const keyRouter = Router();
keyRouter.use((req,res,next) => { res.set('Cache-Control','no-store'); if (!req.headers.authorization?.startsWith('Bearer ')) return res.status(401).json({message:'Sign in to manage MCP access keys.'}); next(); }, requireAuth);
const shape = z.object({ name: z.string().trim().min(1).max(80), projectIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(50), access: z.enum(['read','write']).default('read'), expiresInDays: z.number().int().min(1).max(90).default(30) }).strict();
const safe = row => ({ id:String(row._id), name:row.name, prefix:row.prefix, projectIds:row.projectIds.map(String), access:row.access, expiresAt:row.expiresAt, revokedAt:row.revokedAt, lastUsedAt:row.lastUsedAt, createdAt:row.createdAt });
keyRouter.get('/', async(req,res,next)=> { try { res.json({keys:(await McpAccessKey.find({userId:req.user._id}).sort({createdAt:-1}).limit(100).lean()).map(safe)}); } catch(error){next(error);} });
keyRouter.post('/', async(req,res,next)=> {
  try {
    const body=shape.parse(req.body);
    const projectIds=[...new Set(body.projectIds)];
    const memberships=await ProjectMembership.find({userId:req.user._id,projectId:{$in:projectIds}}).lean();
    if(memberships.length!==projectIds.length) return res.status(403).json({message:'Choose only projects you belong to.'});
    if(body.access==='write' && memberships.some(item=>item.role==='viewer')) return res.status(403).json({message:'Viewer projects can only use read-only keys.'});
    if(await McpAccessKey.countDocuments({userId:req.user._id,revokedAt:null,expiresAt:{$gt:new Date()}})>=20) return res.status(409).json({message:'Revoke an existing key before creating another (maximum 20 active keys).'});
    const token=`otm_${randomBytes(32).toString('hex')}`;
    const row=await McpAccessKey.create({userId:req.user._id,name:body.name,projectIds,access:body.access,expiresAt:new Date(Date.now()+body.expiresInDays*86400000),tokenHash:keyHash(token),prefix:token.slice(0,12)});
    res.status(201).json({key:safe(row),token});
  }catch(error){if(error.name==='ZodError')return res.status(400).json({message:'Enter a key name, valid projects, access level and expiry (1–90 days).'});next(error);}
});
keyRouter.delete('/:id',async(req,res,next)=> { try { if(!/^[a-f0-9]{24}$/i.test(req.params.id))return res.status(400).json({message:'Invalid key.'}); const row=await McpAccessKey.findOneAndUpdate({_id:req.params.id,userId:req.user._id},{$set:{revokedAt:new Date()}},{new:true});if(!row)return res.status(404).json({message:'Key not found.'});res.json({revoked:true}); }catch(error){next(error);} });
export async function requireMcpKey(req,res,next){
  try {
    res.set('WWW-Authenticate',`Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp',publicMcpUrl()).href}"`);
    const token=req.headers.authorization?.match(/^Bearer ((?:otm|oto)_[a-f0-9]{64})$/)?.[1];
    if(!token)return res.status(401).json({message:'Connect your AI client with OAuth or an Over2u MCP access key.'});
    const oauth=token.startsWith('oto_')?await oauthIdentity(token):null;
    const key=oauth?.key || (token.startsWith('otm_')?await McpAccessKey.findOne({tokenHash:keyHash(token),revokedAt:null,expiresAt:{$gt:new Date()}}).lean():null);
    const user=oauth?.user || (key?await User.findById(key.userId):null);
    if(!key||!user||user.disabled)return res.status(401).json({message:'The MCP access key is invalid, expired or revoked.'});
    req.mcpIdentity={key,user};
    res.removeHeader('WWW-Authenticate');
    await McpAccessKey.updateOne({_id:key._id},{$set:{lastUsedAt:new Date()}});
    next();
  }catch(error){next(error);}
}
