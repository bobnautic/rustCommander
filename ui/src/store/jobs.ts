import { create } from 'zustand';
import type { Job, JobError, JobState } from '../api/types';

/** Browser-side transfers in web mode (uploads via PUT /api/upload, downloads via /api/download). */
export interface ClientJob {
  id: string;
  kind: 'upload' | 'download';
  title: string;
  state: JobState;
  session: string;
  dstDir?: string | null;
  bytesTotal: number;
  bytesDone: number;
  filesTotal: number;
  filesDone: number;
  currentFile?: string | null;
  speed: number;
  eta?: number | null;
  errors: JobError[];
  createdAt: number;
  finishedAt?: number | null;
  cancel?: () => void;
}

interface JobsStore {
  jobs: Record<string, Job>;
  client: Record<string, ClientJob>;
  /** Conflict ids the user already answered (avoid re-showing while the update is in flight). */
  answered: Record<string, true>;
}

export const useJobs = create<JobsStore>(() => ({ jobs: {}, client: {}, answered: {} }));

export const FINISHED: ReadonlySet<JobState> = new Set(['completed', 'failed', 'cancelled']);
export const isFinished = (s: JobState) => FINISHED.has(s);

export function setJobs(list: Job[]) {
  useJobs.setState({ jobs: Object.fromEntries(list.map((j) => [j.id, j])) });
}

export function upsertJob(j: Job) {
  useJobs.setState((s) => ({ jobs: { ...s.jobs, [j.id]: j } }));
}

export function removeJob(id: string) {
  useJobs.setState((s) => {
    if (!(id in s.jobs)) return s;
    const jobs = { ...s.jobs };
    delete jobs[id];
    return { jobs };
  });
}

export function markAnswered(conflictId: string) {
  useJobs.setState((s) => ({ answered: { ...s.answered, [conflictId]: true } }));
}

/** Shows the conflict dialog again for a conflict the user dismissed. */
export function reopenConflict(conflictId: string) {
  useJobs.setState((s) => {
    const answered = { ...s.answered };
    delete answered[conflictId];
    return { answered };
  });
}

let clientSeq = 1;
export function addClientJob(j: Omit<ClientJob, 'id' | 'createdAt' | 'errors' | 'speed'> & Partial<Pick<ClientJob, 'errors'>>): string {
  const id = `client-${clientSeq++}`;
  const job: ClientJob = { speed: 0, errors: [], createdAt: Math.floor(Date.now() / 1000), ...j, id };
  useJobs.setState((s) => ({ client: { ...s.client, [id]: job } }));
  return id;
}

export function patchClientJob(id: string, p: Partial<ClientJob>) {
  useJobs.setState((s) => (s.client[id] ? { client: { ...s.client, [id]: { ...s.client[id], ...p } } } : s));
}

export function removeClientJob(id: string) {
  useJobs.setState((s) => {
    const client = { ...s.client };
    delete client[id];
    return { client };
  });
}

export function clearFinishedClientJobs() {
  useJobs.setState((s) => ({ client: Object.fromEntries(Object.entries(s.client).filter(([, j]) => !isFinished(j.state))) }));
}

export interface JobSummary {
  active: number;
  waiting: number;
  bytesTotal: number;
  bytesDone: number;
  speed: number;
  failed: number;
}

export function summarize(jobs: Record<string, Job>, client: Record<string, ClientJob>): JobSummary {
  const sum: JobSummary = { active: 0, waiting: 0, bytesTotal: 0, bytesDone: 0, speed: 0, failed: 0 };
  for (const j of [...Object.values(jobs), ...Object.values(client)]) {
    if (j.state === 'failed') sum.failed++;
    if (isFinished(j.state)) continue;
    sum.active++;
    if (j.state === 'waiting') sum.waiting++;
    sum.bytesTotal += j.bytesTotal;
    sum.bytesDone += j.bytesDone;
    sum.speed += j.state === 'running' ? j.speed : 0;
  }
  return sum;
}
