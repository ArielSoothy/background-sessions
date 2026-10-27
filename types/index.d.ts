export type Status = 'yours' | 'working' | 'error' | 'closed' | 'unknown'
export type SessionRow = {
  id: string; job: string; name: string; state: string;
  projectId: string; projectName: string; projectSource: 'cwd' | 'Other';
  rawName?: string | null; projectShort?: string; jobColor?: string | null;
  tasks?: number | null; closed?: boolean; status?: Status; statusColor?: string;
  startedAt: number | null; lastWorkedAt: number | null; model: string;
  tokens: number | null; window: number | null; percent: number | null;
  contextSource: 'reported' | 'unknown';
}
export type Board = { at: number; rows: SessionRow[]; errors: string[]; inventoryComplete?: boolean }
export type Segment = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type BoardLine = { key: string; segments: Segment[] }
declare module 'claude-code' {
  interface PluginState { 'session-board': {
    board: Board | null
    /** Distinguishes fresh process startup from hook reload. */
    booted: boolean
  } }
}
