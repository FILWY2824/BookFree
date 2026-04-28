// Client-side wrappers for the highlights and notes API surface
// already exposed by the Go server (server/internal/notes).
//
// We model an annotation as a single Highlight with an optional Note
// attached — the schema separates the two (highlights table for the
// rectangle/underline, notes table for the textual body), but the UI
// almost always wants to render them together. The reader's selection
// toolbar therefore creates one row in each table when the user picks
// "highlight + note", which mirrors the legacy frontend's contract.

import { api } from './api';

export type HighlightStyle = 'highlight' | 'underline' | 'wavy' | 'strike';
export type HighlightColor = 'yellow' | 'red' | 'green' | 'blue' | 'purple' | 'orange';

export interface Highlight {
  id: string;
  bookId: string;
  chapterId?: string | null;
  pageNo?: number | null;
  locator: string;
  selectedText: string;
  color: HighlightColor;
  /** Annotation style — defaults to 'highlight' for rows created
   *  before the style column was added (migration 0019). */
  style?: HighlightStyle;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  bookId: string;
  highlightId?: string | null;
  chapterId?: string | null;
  pageNo?: number | null;
  locator: string;
  selectedText?: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export const COLORS: HighlightColor[] = ['yellow', 'red', 'green', 'blue', 'purple', 'orange'];
export const STYLES: HighlightStyle[] = ['highlight', 'underline', 'wavy', 'strike'];

export function listHighlights(bookId: string): Promise<Highlight[]> {
  return api.get<{ highlights: Highlight[] }>(`/api/books/${bookId}/highlights`)
    .then(d => d.highlights);
}

export function createHighlight(
  bookId: string,
  body: Omit<Highlight, 'id' | 'bookId' | 'createdAt' | 'updatedAt'>,
): Promise<Highlight> {
  return api.post<{ highlight: Highlight }>(`/api/books/${bookId}/highlights`, body)
    .then(d => d.highlight);
}

export function deleteHighlight(id: string): Promise<void> {
  return api.delete(`/api/highlights/${id}`).then(() => undefined);
}

export function listNotes(bookId: string): Promise<Note[]> {
  return api.get<{ notes: Note[] }>(`/api/books/${bookId}/notes`)
    .then(d => d.notes);
}

export function createNote(
  bookId: string,
  body: Omit<Note, 'id' | 'bookId' | 'createdAt' | 'updatedAt'>,
): Promise<Note> {
  return api.post<{ note: Note }>(`/api/books/${bookId}/notes`, body)
    .then(d => d.note);
}

export function updateNote(id: string, body: string): Promise<void> {
  return api.put(`/api/notes/${id}`, { body }).then(() => undefined);
}

export function deleteNote(id: string): Promise<void> {
  return api.delete(`/api/notes/${id}`).then(() => undefined);
}
