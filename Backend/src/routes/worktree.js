import { Router } from 'express';
import { createHash } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { attachProject, requireRole } from '../middleware/access.js';
import { ActivityEvent } from '../models/ActivityEvent.js';
import { SourceRecord } from '../models/SourceRecord.js';
import { WORK_TREE_LANES, presentActivity, cleanText } from '../worktree/presentation.js';
const router = Router();
router.get('/:id/work-tree', requireAuth, attachProject(), requireRole('viewer'), async(req,res,next)=>{
  try {
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 300) return res.status(400).json({ message: 'Work tree limit must be between 1 and 300.' });
    const [events, total, sources] = await Promise.all([
      ActivityEvent.find({projectId:req.project._id}).sort({seq:-1}).limit(limit).populate('actorId','name').lean(),
      ActivityEvent.countDocuments({projectId:req.project._id}),
      SourceRecord.find({projectId:req.project._id}).select('provider type title createdAt updatedAt metadata.sourceCreatedAt metadata.author metadata.providerMetadata.sha metadata.providerMetadata.repositoryFullName').sort({createdAt:-1}).limit(40).lean(),
    ]);
    const represented = new Set(events.map(event => String(event.targetId || '')));
    const nodes = events.filter(event=>event.action!=='PROJECT_CREATED').map(presentActivity);
    const finishedRuns = new Map(nodes.filter(node=>/^REPOSITORY_SYNC_(COMPLETED|PARTIAL|FAILED)$/.test(node.action)&&node.details.runId).map(node=>[node.details.runId,node]));
    for(const node of nodes){
      const finished=finishedRuns.get(node.details.runId);
      if(node.action==='REPOSITORY_SYNC_STARTED'&&finished){node.status=finished.status;node.details.outcome=finished.action.replace('REPOSITORY_SYNC_','').toLowerCase();}
    }
    // Existing imported evidence is displayed as observed data, not invented trigger history.
    for(const source of sources){
      if(represented.has(String(source._id)) || source.provider==='manual') continue;
      const commit=source.provider==='github'&&source.type==='commit';
      nodes.push({id:`source:${source._id}`,category:source.provider==='github'?'development':'knowledge',action:commit?'COMMIT_IMPORTED':'SOURCE_IMPORTED',label:commit?'Commit synced':`${source.provider} source imported`,description:cleanText(source.title),actor:cleanText(source.metadata?.author)||'Integration',occurredAt:new Date(source.createdAt).toISOString(),entityId:String(source._id),kind:'source',status:'completed',details:{provider:source.provider,...(source.metadata?.providerMetadata?.sha?{sha:cleanText(source.metadata.providerMetadata.sha,40)}:{})}});
    }
    nodes.sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id));
    const project={id:String(req.project._id),name:req.project.name,createdAt:req.project.createdAt};
    const revision=createHash('sha256').update(JSON.stringify({project,nodes})).digest('hex');
    res.set('Cache-Control','no-store');
    if(req.query.revision===revision)return res.json({unchanged:true,revision});
    res.json({project,lanes:WORK_TREE_LANES,nodes,revision,hasOlder:total>limit,limit,totalEvents:total});
  }catch(error){next(error);}
});
export default router;
