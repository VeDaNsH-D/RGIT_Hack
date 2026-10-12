import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteProjectDocument, downloadProjectDocument, getDocumentPreview, listProjectDocuments, replaceProjectDocument, retryDocument, uploadProjectDocument, DOCUMENT_ACCEPT } from '../api/documents'
import { formatDate } from './utils'
import { Icon } from './ui'
import { STATUS_BADGES, STATUS_LABELS, formatBytes, formatLabel, validateDocumentFile } from './documentHelpers'

function DocumentRow({ document, canManage, busy, confirming, onDownload, onPreview, onRetry, onReplace, onAskDelete, onCancelDelete, onDelete }) {
  const replaceInput = useRef(null)
  const status = document.status
  return <li className="ws-doc-row">
    <div className="ws-doc-main">
      <span className="ws-doc-icon" aria-hidden="true"><Icon name="notion" size={18}/></span>
      <div className="ws-doc-text">
        <strong title={document.filename}>{document.title}</strong>
        <small className="ws-muted">{[document.filename !== document.title && document.filename, formatLabel(document), formatBytes(document.size), document.pageCount ? `${document.pageCount} page${document.pageCount === 1 ? '' : 's'}` : '', `Uploaded ${formatDate(document.createdAt)}`].filter(Boolean).join(' · ')}</small>
      </div>
      <span className={`ws-badge ${STATUS_BADGES[status] || ''}`}>{STATUS_LABELS[status] || status}</span>
    </div>
    {status === 'indexed' && !document.noExtractableText && <p className="ws-muted ws-doc-note">{`${document.chunkCount} section${document.chunkCount === 1 ? '' : 's'} available to handoffs.`}</p>}
    {document.noExtractableText && <p className="ws-inline-error" role="status">No extractable text was found (scanned documents are not OCR’d), so handoffs cannot use this file.</p>}
    {document.error && <p className="ws-inline-error" role="alert">{document.error.message}</p>}
    <div className="ws-doc-actions">
      <button type="button" className="ws-text-button" onClick={onPreview}>Preview</button>
      <button type="button" className="ws-text-button" onClick={onDownload}>Download</button>
      {canManage && document.canRetry && <button type="button" className="ws-text-button" onClick={onRetry} disabled={busy}>Retry processing</button>}
      {canManage && <>
        <button type="button" className="ws-text-button" onClick={() => replaceInput.current?.click()} disabled={busy}>Replace</button>
        <input ref={replaceInput} type="file" accept={DOCUMENT_ACCEPT} hidden aria-label={`Replace ${document.title}`} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onReplace(file) }}/>
        {!confirming && <button type="button" className="ws-text-button ws-danger" onClick={onAskDelete} disabled={busy}>Delete</button>}
      </>}
    </div>
    {confirming && <div className="ws-repo-confirm" role="group" aria-label="Confirm delete"><p className="ws-muted">Delete this document? It is removed from the project’s knowledge and future handoffs. Reports already generated are kept.</p><div><button type="button" className="ws-button" onClick={onCancelDelete} disabled={busy}>Keep</button><button type="button" className="ws-button ws-button-danger" onClick={onDelete} disabled={busy}>{busy ? 'Deleting…' : 'Delete document'}</button></div></div>}
  </li>
}

// Presentational so every state renders without network access.
export function ProjectDocumentsView({ state, documents = [], error, canUpload, canManageDocument = () => false, uploading, busyId, confirmingId, notice, dragging, preview, onPick, onDrop, onDragState, onRetryLoad, onDownload, onPreview, onClosePreview, onRetry, onReplace, onAskDelete, onCancelDelete, onDelete, inputRef }) {
  return <section className="ws-panel ws-documents" aria-labelledby="project-documents">
    <div className="ws-section-heading"><div><h2 id="project-documents">Project documents <span className="ws-count">{documents.length}</span></h2><p>Upload requirements, designs and notes. Indexed documents are combined with your repository and activity when you generate a handoff.</p></div>
      {canUpload && <><button type="button" className="ws-button ws-button-primary" onClick={() => inputRef?.current?.click()} disabled={uploading}><Icon name="plus" size={16}/>{uploading ? 'Uploading…' : 'Upload document'}</button><input ref={inputRef} type="file" accept={DOCUMENT_ACCEPT} hidden aria-label="Choose a document to upload" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onPick(file) }}/></>}
    </div>
    {canUpload && <div className={`ws-dropzone${dragging ? ' ws-dropzone-active' : ''}`} onDragOver={event => { event.preventDefault(); onDragState(true) }} onDragLeave={() => onDragState(false)} onDrop={event => { event.preventDefault(); onDragState(false); const file = event.dataTransfer?.files?.[0]; if (file) onDrop(file) }}>
      <span>Drag a PDF, DOCX or TXT file here, or use Upload document.</span><small className="ws-muted">Up to 10 MB. Text is extracted and indexed for handoffs.</small>
    </div>}
    {error && <p className="ws-error" role="alert">{error}</p>}
    {notice && <p className="ws-notice" role="status">{notice}</p>}
    {state === 'loading' && <div className="ws-skeleton ws-skeleton-list" role="status" aria-label="Loading documents"/>}
    {state === 'error' && <div className="ws-integration-body"><button type="button" className="ws-button" onClick={onRetryLoad}>Try again</button></div>}
    {state === 'ready' && (documents.length
      ? <ul className="ws-doc-list">{documents.map(document => <DocumentRow key={document.id} document={document} canManage={canManageDocument(document)} busy={busyId === document.id} confirming={confirmingId === document.id} onDownload={() => onDownload(document)} onPreview={() => onPreview(document)} onRetry={() => onRetry(document)} onReplace={file => onReplace(document, file)} onAskDelete={() => onAskDelete(document.id)} onCancelDelete={onCancelDelete} onDelete={() => onDelete(document)}/>)}</ul>
      : <p className="ws-panel-empty">No documents yet. Upload a requirements document or meeting notes to give handoffs more context.</p>)}
    {preview && <div className="ws-doc-preview" role="dialog" aria-label={`Preview of ${preview.title}`}>
      <div className="ws-section-heading"><h3>{preview.title}</h3><button type="button" className="ws-text-button" onClick={onClosePreview}>Close preview</button></div>
      {preview.loading ? <p className="ws-muted">Loading preview…</p> : preview.error ? <p className="ws-inline-error" role="alert">{preview.error}</p> : <><pre>{preview.text || 'No extractable text.'}</pre>{preview.truncated && <p className="ws-muted">{`Showing the first part of ${preview.characterCount.toLocaleString()} characters. Download the file for the full document.`}</p>}</>}
    </div>}
  </section>
}

export default function ProjectDocuments({ projectId, canUpload, isOwner, userId, onChanged }) {
  const [result, setResult] = useState(null)
  const [tick, setTick] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [confirmingId, setConfirmingId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState(null)
  const inputRef = useRef(null)
  const lock = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    listProjectDocuments(projectId, controller.signal)
      .then(data => setResult({ projectId, documents: data.items }))
      .catch(failure => { if (failure.name !== 'AbortError') setResult(previous => ({ projectId, documents: previous?.projectId === projectId ? previous.documents : null, error: failure.message })) })
    return () => controller.abort()
  }, [projectId, tick])

  const documents = result?.projectId === projectId ? result.documents : null
  const state = !result || result.projectId !== projectId ? 'loading' : result.error && !documents ? 'error' : 'ready'
  const refresh = useCallback(() => { setTick(count => count + 1); onChanged?.() }, [onChanged])

  // A document processed elsewhere (or still finishing) is followed until it settles.
  const inFlight = documents?.some(item => item.status === 'processing')
  useEffect(() => {
    if (!inFlight) return undefined
    const timer = setTimeout(() => setTick(count => count + 1), 3000)
    return () => clearTimeout(timer)
  }, [inFlight, tick])

  async function guarded(task) {
    if (lock.current) return
    lock.current = true
    setError('')
    setNotice('')
    try { await task() } finally { lock.current = false }
  }

  const upload = file => guarded(async () => {
    const invalid = validateDocumentFile(file)
    if (invalid) { setError(invalid); return }
    setUploading(true)
    try {
      const data = await uploadProjectDocument(projectId, file)
      if (data.status === 'duplicate') setNotice(`“${data.duplicateOf?.title || file.name}” is already in this project; nothing was changed.`)
      else if (data.status === 'partial') setError('The file was saved but could not be fully indexed. Use “Retry processing”.')
      else if (data.warnings?.some(w => w.code === 'NO_EXTRACTABLE_TEXT')) setNotice('Uploaded, but no extractable text was found (scanned documents are not OCR’d).')
      else setNotice('Document uploaded and indexed.')
      refresh()
    } catch (failure) {
      setError(failure.message)
      if (failure.data?.status === 'partial') refresh()
    } finally { setUploading(false) }
  })

  const replace = (document, file) => guarded(async () => {
    const invalid = validateDocumentFile(file)
    if (invalid) { setError(invalid); return }
    setBusyId(document.id)
    try {
      const data = await replaceProjectDocument(projectId, document.id, file)
      setNotice(data.status === 'unchanged' ? 'That file is identical to the current version; nothing was changed.' : 'Document replaced. Future handoffs use the new version.')
      refresh()
    } catch (failure) { setError(failure.message); refresh() } finally { setBusyId(null) }
  })

  const retry = document => guarded(async () => {
    setBusyId(document.id)
    try { await retryDocument(projectId, document.id); setNotice('Document processed.') } catch (failure) { setError(failure.message) } finally { setBusyId(null); refresh() }
  })

  const remove = document => guarded(async () => {
    setBusyId(document.id)
    try { await deleteProjectDocument(projectId, document.id); setConfirmingId(null); setNotice('Document deleted.'); if (preview?.id === document.id) setPreview(null) } catch (failure) { setError(failure.message) } finally { setBusyId(null); refresh() }
  })

  async function download(document) {
    setError('')
    try { await downloadProjectDocument(projectId, document.id, document.filename) } catch (failure) { setError(failure.message) }
  }

  async function openPreview(document) {
    setPreview({ id: document.id, title: document.title, loading: true })
    try { setPreview({ id: document.id, title: document.title, ...(await getDocumentPreview(projectId, document.id)) }) } catch (failure) { setPreview({ id: document.id, title: document.title, error: failure.message }) }
  }

  return <ProjectDocumentsView state={state} documents={documents || []} error={error || (state === 'error' ? result.error : '')} notice={notice} canUpload={canUpload} canManageDocument={document => canUpload && (isOwner || document.uploadedBy === userId)} uploading={uploading} busyId={busyId} confirmingId={confirmingId} dragging={dragging} preview={preview} inputRef={inputRef}
    onPick={upload} onDrop={upload} onDragState={setDragging} onRetryLoad={() => { setResult(null); setTick(count => count + 1) }} onDownload={download} onPreview={openPreview} onClosePreview={() => setPreview(null)} onRetry={retry} onReplace={replace} onAskDelete={setConfirmingId} onCancelDelete={() => setConfirmingId(null)} onDelete={remove}/>
}
