import { invoke, isTauri } from '@tauri-apps/api/core';

export interface Note { path: string; name: string; content?: string; revision?: string; modified: number; created: number }
export interface Document extends Note { content: string; revision: string }
export interface Workspace { root: string; folders: string[]; notes: Note[] }
export interface Settings {
  theme: 'system' | 'light' | 'dark'; language: string;
  editorFont: string; previewFont: string; interfaceFont: string; codeFont: string;
  fontSize: number; lineHeight: number; previewWidth: number; wrap: boolean;
  mode: 'edit' | 'wysiwyg' | 'split' | 'preview'; splitDirection: 'row' | 'column';
  showSidebar: boolean; showList: boolean; buttons: 'always' | 'hover' | 'never';
  sidebarWidth: number; listWidth: number; pinned: string[];
  sort: 'modified' | 'created' | 'name'; ascending: boolean;
  plantumlEnabled: boolean; plantumlEndpoint: string; uploadEndpoint: string; uploadEnabled: boolean;
  alwaysOnTop: boolean; activateShortcut: string; lastNote: string;
}
export const defaults: Settings = {
  theme: 'system', language: 'zh-Hans', editorFont: 'Microsoft YaHei', previewFont: 'Microsoft YaHei',
  interfaceFont: 'Segoe UI', codeFont: 'Cascadia Code, Consolas', fontSize: 20, lineHeight: 1.8,
  previewWidth: 860, wrap: true, mode: 'wysiwyg', splitDirection: 'row', showSidebar: true,
  showList: true, buttons: 'always', sidebarWidth: 230, listWidth: 358, pinned: [],
  sort: 'modified', ascending: false, plantumlEnabled: false, plantumlEndpoint: 'https://www.plantuml.com/plantuml/svg/',
  uploadEndpoint: 'http://127.0.0.1:36677/upload', uploadEnabled: false, alwaysOnTop: false,
  activateShortcut: 'Ctrl+Alt+M', lastNote: '',
};
export const desktop = isTauri();
export async function request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!desktop) throw new Error('请在 Windows 桌面应用中执行文件操作。浏览器仅用于界面预览。');
  return invoke<T>('request', { action, payload });
}
export const parentPath = (path: string) => path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
export const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop() || '';

/** Serialize operations without letting an earlier rejection poison the queue. */
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
