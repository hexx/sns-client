/** BFF (/api/*) を叩く薄い fetch クライアント */
import { API } from '../../shared/constants';
import type { Health, MediaUploadResponse, Post, PostInputWire, TimelineResponse } from '../../shared/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>(API.health),
  timeline: (cursor?: string) =>
    request<TimelineResponse>(
      `${API.timeline}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  uploadMedia: (bytes: ArrayBuffer, mimeType: string) =>
    request<MediaUploadResponse>(API.media, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': mimeType },
    }),
  post: (input: PostInputWire) =>
    request<Post>(API.post, { method: 'POST', body: JSON.stringify(input) }),
};
