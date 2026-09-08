export interface FileOffer {
  type: "file-offer";
  transferId: string;
  name: string;
  fileType: string;
  size: number;
}

export interface FileAccept {
  type: "file-accept";
  transferId: string;
}

export interface FileReject {
  type: "file-reject";
  transferId: string;
}

export interface FileEnd {
  type: "file-end";
  transferId: string;
}

export type FileControlMessage = FileOffer | FileAccept | FileReject | FileEnd;

export type PeerMessage = FileControlMessage | Uint8Array | Blob | string;

export interface IncomingFileOffer {
  transferId: string;
  peerId: string;
  name: string;
  fileType: string;
  size: number;
}

export interface ReceivedFile {
  id: string; // Unique ID for the received file (transferId)
  name: string;
  type: string;
  size: number;
  blob?: Blob; // present only when buffered in memory (fallback for browsers without File System Access API)
  savedToDisk?: boolean; // true when streamed directly to disk as it arrived
}

export enum ConnectionStatus {
    DISCONNECTED = "Desconectado",
    CONNECTING = "Conectando...",
    CONNECTED = "Conectado",
    WAITING = "Aguardando conexão...",
    ERROR = "Erro"
}
