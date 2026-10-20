export type TaskStatus = 'idea' | 'ready' | 'implementing' | 'testing' | 'reviewing' | 'changes-requested'
  | 'awaiting-human' | 'awaiting-ci' | 'merging' | 'done' | 'delivered' | 'blocked' | 'cancelled';

export type Provenance = 'external-requirement' | 'user-decision' | 'agent-hypothesis' | 'observed-result';

export interface Task {
  id: string;               // stable internal id, e.g. "task-12" (Backlog.md id normalized lowercase)
  locator: string;          // backend locator, e.g. "backlogmd:task-12"
  title: string; description: string;
  acceptanceCriteria: { text: string; done: boolean }[];
  status: TaskStatus; priority: 'high' | 'medium' | 'low' | null;
  dependencies: string[]; parent: string | null; externalLinks: string[];
  labels: string[]; authorized: boolean;   // label 'minions:authorized' or profile allows startReady
  branch: string | null; commits: string[]; prUrl: string | null;
  provenance: Provenance; version: string; // content hash for conflict checks
  milestone?: string | null; // backend milestone, used by intake.scope.milestone
}

export interface CreateTaskInput {
  title: string; description?: string; acceptanceCriteria?: string[]; priority?: Task['priority'];
  dependencies?: string[]; parent?: string; labels?: string[]; status?: TaskStatus; provenance?: Provenance; idempotencyKey: string;
  /** Recorded in the minions meta block (e.g. the GitHub issue an intake sync imported). */
  externalLinks?: string[];
}

/** Mirrors config `intake.scope`; tasks outside it are not ready. */
export interface ScopeFilter { milestone: string | null; requiredLabels: string[]; allowedPaths: string[] }

export interface BacklogAdapter {
  capabilities(): Promise<{ backend: string; version: string; supports: string[] }>;
  listTasks(): Promise<Task[]>;
  listReady(limit: number, leasedIds: Set<string>, scope: ScopeFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<{ task: Task; created: boolean }>; // idempotent by key
  updateTask(id: string, expectedVersion: string, patch: Partial<Pick<Task, 'status' | 'title' | 'description' | 'priority' | 'labels' | 'branch' | 'prUrl'>>): Promise<Task>; // CONFLICT on version mismatch
  addDependency(id: string, dependsOn: string): Promise<Task>;  // rejects cycles with explanation
  addNote(id: string, text: string): Promise<void>;
  closeTask(id: string, status: 'done' | 'delivered' | 'cancelled'): Promise<Task>;
  exportTasks(): Promise<Task[]>;
}

/** Idempotency key -> task id (runtime DB table `idempotency` in production). */
export interface IdempotencyStore {
  get(key: string): string | undefined;
  put(key: string, taskId: string): void;
}
