export const TREE_NODE_WIDTH = 246
export const TREE_NODE_HEIGHT = 112
export function layoutWorkTree(project, nodes, lanes) {
  const active = lanes.filter(lane => nodes.some(node => node.category === lane.id))
  const columns = active.length ? active : [{ id: 'project', label: 'Project', color: '#d7b4ff' }]
  const width = Math.max(640, columns.length * 316 + 100)
  const root = { id: 'project-root', x: (width - 280) / 2, y: 35, width: 280, height: 112, label: project.name, kind: 'root', occurredAt: project.createdAt, color: '#c99cf5' }
  const placed = [], edges = []
  for (const [index, lane] of columns.entries()) {
    const x = 66 + index * 316
    const branch = { id: `lane:${lane.id}`, x, y: 225, width: TREE_NODE_WIDTH, height: 68, label: lane.label, kind: 'lane', color: lane.color, category: lane.id }
    placed.push(branch)
    edges.push({ id: `root:${lane.id}`, source: root, target: branch, branch: true })
    let previous = branch
    nodes.filter(node => node.category === lane.id).forEach((node, row) => {
      const card = { ...node, x: x + (row % 2 ? 12 : 0), y: 350 + row * 175, width: TREE_NODE_WIDTH, height: TREE_NODE_HEIGHT, color: lane.color }
      placed.push(card); edges.push({ id: `edge:${node.id}`, source: previous, target: card, branch: false }); previous = card
    })
  }
  return { root, nodes: placed, edges, width, height: Math.max(610, ...placed.map(node => node.y + node.height + 65)) }
}
export function treeEdgePath(edge) {
  const {source:s,target:t}=edge
  if(edge.branch){const sx=s.x+s.width/2,sy=s.y+s.height,tx=t.x+t.width/2,ty=t.y,mid=185;return `M ${sx} ${sy} V ${mid-12} Q ${sx} ${mid} ${sx+(tx>sx?12:-12)} ${mid} H ${tx+(tx>sx?-12:12)} Q ${tx} ${mid} ${tx} ${mid+12} V ${ty}`}
  const sx=s.x+s.width,sy=s.y+s.height/2,tx=t.x,ty=t.y+t.height/2,right=Math.max(sx,t.x+t.width)+24,left=Math.min(s.x,t.x)-22,mid=(s.y+s.height+t.y)/2
  return `M ${sx} ${sy} H ${right-12} Q ${right} ${sy} ${right} ${sy+12} V ${mid-12} Q ${right} ${mid} ${right-12} ${mid} H ${left+12} Q ${left} ${mid} ${left} ${mid+12} V ${ty-12} Q ${left} ${ty} ${left+12} ${ty} H ${tx}`
}
