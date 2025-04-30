export interface FileChunk {
  name: string;
  type: string;
  size: number;
  payload: ArrayBuffer;
  isChunk: true;
  chunkIndex: number;
  totalChunks: number;
}

export interface FileCompletionSignal {
  name: string;
  type: string;
  size: number;
  isComplete: true;
}

export interface SimpleFileData {
    name: string;
    type: string;
    size: number;
    payload: ArrayBuffer;
}

export type PeerMessage = FileChunk | FileCompletionSignal | SimpleFileData | string | ArrayBuffer | Blob;

export interface ReceivedFile {
    id: string; // Unique ID for the received file (e.g., peerId-fileName)
    name: string;
    type: string;
    size: number;
    blob: Blob;
}

export enum ConnectionStatus {
    DISCONNECTED = "Desconectado",
    CONNECTING = "Conectando...",
    CONNECTED = "Conectado",
    WAITING = "Aguardando conexão...",
    ERROR = "Erro"
}

