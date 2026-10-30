import type { Action, Priority } from './classify';
import type { Category } from './config';

export const STATUSES = ['New', 'Replied', 'Waiting', 'Closed'] as const;
export type Status = (typeof STATUSES)[number];

export const ACTIONS = ['Reply', 'Ignore', 'Escalate', 'Legal review', 'Spam'] as const;

export interface HistoryEntry {
  by: string; // Lark open_id of the person who clicked
  at: number; // epoch ms
  field: 'status' | 'action';
  to: string;
}

export interface Case {
  id: string; // X post id
  createdAt: number;
  postedAt: string;
  username: string;
  followers: number;
  likes: number;
  reposts: number;
  text: string;
  category: Category;
  priority: Priority;
  suggested: Action;
  status: Status;
  action: Action | '';
  history: HistoryEntry[];
}

export const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status);
export const isAction = (v: unknown): v is Action => ACTIONS.includes(v as Action);

const HISTORY_LIMIT = 8;

// A person clicked a button. Returns the updated case, or null if nothing would change.
// "Ignore" and "Spam" also close the case, as in the plan ("Mark ignored in Lark").
export function applyUpdate(c: Case, field: 'status' | 'action', value: string, by: string, now: number): Case | null {
  const next: Case = { ...c, history: [...c.history] };
  if (field === 'status') {
    if (!isStatus(value) || value === c.status) return null;
    next.status = value;
    next.history.push({ by, at: now, field, to: value });
  } else {
    if (!isAction(value) || value === c.action) return null;
    next.action = value;
    next.history.push({ by, at: now, field, to: value });
    if ((value === 'Ignore' || value === 'Spam') && c.status !== 'Closed') {
      next.status = 'Closed';
      next.history.push({ by, at: now, field: 'status', to: 'Closed' });
    }
  }
  next.history = next.history.slice(-HISTORY_LIMIT);
  return next;
}

export function lastUpdate(c: Case, field: 'status' | 'action'): HistoryEntry | undefined {
  for (let i = c.history.length - 1; i >= 0; i--) {
    const h = c.history[i];
    if (h && h.field === field) return h;
  }
  return undefined;
}
