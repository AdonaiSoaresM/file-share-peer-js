export {};

// Minimal ambient types for the File System Access API (Chromium browsers).
// Not yet part of TypeScript's lib.dom.d.ts.
declare global {
  interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string | string[]>;
    }>;
    excludeAcceptAllOption?: boolean;
  }

  interface Window {
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  }
}
