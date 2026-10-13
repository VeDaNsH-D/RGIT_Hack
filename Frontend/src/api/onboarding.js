import { readSession } from '../auth/session';
import { request } from './client';

const base = () => (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
const root = (projectId) => `/projects/${encodeURIComponent(projectId)}/onboarding`;

export const createOnboarding = (projectId, payload) =>
  request(root(projectId), { method: 'POST', body: payload });

export const listOnboardings = (projectId, signal) =>
  request(root(projectId), { signal });

export const getMyOnboarding = (projectId, signal) =>
  request(`${root(projectId)}/me`, { signal });

export const getOnboarding = (projectId, onboardingId, signal) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}`, { signal });

export const updateOnboarding = (projectId, onboardingId, payload) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}`, { method: 'PATCH', body: payload });

export const regenerateOnboardingContext = (projectId, onboardingId) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}/generate-context`, {
    method: 'POST',
    body: {},
    signal: AbortSignal.timeout(60000),
  });

export const getOnboardingContext = (projectId, onboardingId, signal) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}/context`, { signal });

export const getOnboardingDocuments = (projectId, onboardingId, signal) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}/documents`, { signal });

export const getOnboardingDocumentPreview = (projectId, onboardingId, docId, signal) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}/documents/${encodeURIComponent(docId)}/preview`, { signal });

export async function downloadOnboardingDocument(projectId, onboardingId, docId, fallbackName = 'document') {
  const url = `${base()}${root(projectId)}/${encodeURIComponent(onboardingId)}/documents/${encodeURIComponent(docId)}/file`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${readSession()?.token}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Object.assign(
      new Error(response.status === 404 ? 'This document is no longer available.' : data?.message || 'The document could not be downloaded.'),
      { status: response.status }
    );
  }
  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);
}

export const reviewOnboardingSection = (projectId, onboardingId, payload) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}/review`, { method: 'POST', body: payload });

export const completeOnboarding = (projectId, onboardingId) =>
  request(`${root(projectId)}/${encodeURIComponent(onboardingId)}/complete`, { method: 'POST', body: {} });
