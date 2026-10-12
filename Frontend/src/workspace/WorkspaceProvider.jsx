import { useCallback, useEffect, useRef, useState } from 'react'
import { loadWorkspace } from '../api/client'
import { WorkspaceContext } from './WorkspaceContext'

export default function WorkspaceProvider({ children }) {
  const [state, setState] = useState({ projects: [], loading: true, error: '' })
  const sequence = useRef(0)
  const reload = useCallback(async signal => {
    const current = ++sequence.current
    try {
      const data = await loadWorkspace(signal)
      if (!signal?.aborted && current === sequence.current) setState({ ...data, loading: false, error: '' })
    } catch (err) {
      if (!signal?.aborted && current === sequence.current) setState(previous => ({ ...previous, loading: false, error: err.message }))
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal)
    return () => controller.abort()
  }, [reload])
  return <WorkspaceContext.Provider value={{ ...state, reload, tasks: state.projects.flatMap(project => project.tasks), handoffs: state.projects.flatMap(project => project.handoffs) }}>{children}</WorkspaceContext.Provider>
}
