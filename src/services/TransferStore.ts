// Persists in-progress incoming downloads (their file handle + how many bytes are
// durably on disk) across page reloads/browser restarts, so a transfer can resume
// instead of restarting from zero. Only meaningful alongside the File System Access
// API - there's nothing durable to resume for the in-memory buffering fallback.

const DB_NAME = "p2p-file-share";
const DB_VERSION = 1;
const STORE_NAME = "incoming-transfers";

export interface StoredIncomingTransfer {
    key: string;
    name: string;
    size: number;
    fileType: string;
    bytesOnDisk: number;
    fileHandle: FileSystemFileHandle;
    updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "key" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return dbPromise;
}

// Files are matched by name+size+type across sessions (peer IDs are regenerated
// every page load, so there's no stable connection identity to key off instead).
export function makeTransferKey(name: string, size: number, fileType: string): string {
    return `${name}::${size}::${fileType}`;
}

export async function getStoredTransfer(key: string): Promise<StoredIncomingTransfer | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve((request.result as StoredIncomingTransfer | undefined) ?? null);
        request.onerror = () => reject(request.error);
    });
}

export async function putStoredTransfer(record: StoredIncomingTransfer): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function deleteStoredTransfer(key: string): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Chrome doesn't remember read/write grants forever - re-request on resume so the
// (user-gesture-driven) "Continuar" click can re-authorize access to the handle.
export async function ensureReadWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
    const descriptor: FileSystemHandlePermissionDescriptor = { mode: "readwrite" };
    if ((await handle.queryPermission(descriptor)) === "granted") return true;
    return (await handle.requestPermission(descriptor)) === "granted";
}
