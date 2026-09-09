import { Peer, DataConnection } from "peerjs";
import {
    ConnectionStatus,
    PeerMessage,
    ReceivedFile,
    FileControlMessage,
    FileOffer,
    FileAccept,
    FileReject,
    FileEnd,
    IncomingFileOffer
} from "../models/PeerData";
import {
    makeTransferKey,
    getStoredTransfer,
    putStoredTransfer,
    deleteStoredTransfer,
    ensureReadWritePermission
} from "./TransferStore";

// Read in 1MB slices - large enough to keep FileReader/JS overhead low,
// small enough to keep at most a couple of slices in memory at once.
const CHUNK_SIZE = 1024 * 1024;
// Application-level backpressure: pause reading/sending more of the file
// once this many bytes are still queued in the underlying RTCDataChannel.
// Kept below PeerJS's own internal buffer cap so we throttle before it does.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
// How often (in received bytes) the receiver commits progress to the real file
// and records it in IndexedDB. Smaller = less data lost if the tab closes
// unexpectedly, but more close/reopen overhead on the file handle.
const CHECKPOINT_INTERVAL_BYTES = 20 * 1024 * 1024;

export function supportsFileSystemAccess(): boolean {
    return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

function generateTransferId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Waits until the data channel has drained below `threshold` bytes of
// buffered-but-unsent data, using the native bufferedamountlow event
// instead of polling.
function waitForBufferDrain(dataChannel: RTCDataChannel, threshold: number): Promise<void> {
    if (dataChannel.bufferedAmount <= threshold) return Promise.resolve();
    return new Promise((resolve) => {
        const onLow = () => {
            dataChannel.removeEventListener("bufferedamountlow", onLow);
            resolve();
        };
        dataChannel.bufferedAmountLowThreshold = threshold;
        dataChannel.addEventListener("bufferedamountlow", onLow);
    });
}

// Tracks throughput in fixed time windows (rather than a running average since
// the transfer started) so the reported speed reflects the current rate.
class RateTracker {
    private windowStartMs = performance.now();
    private windowBytes = 0;
    private lastRateBytesPerSec = 0;

    addBytes(delta: number): number {
        this.windowBytes += delta;
        const elapsedMs = performance.now() - this.windowStartMs;
        if (elapsedMs >= 300) {
            this.lastRateBytesPerSec = this.windowBytes / (elapsedMs / 1000);
            this.windowBytes = 0;
            this.windowStartMs = performance.now();
        }
        return this.lastRateBytesPerSec;
    }

    reset(): void {
        this.windowStartMs = performance.now();
        this.windowBytes = 0;
        this.lastRateBytesPerSec = 0;
    }
}

interface OutgoingTransfer {
    transferId: string;
    file: File;
    cancelled: boolean;
}

interface IncomingTransfer {
    transferId: string;
    peerId: string;
    name: string;
    fileType: string;
    size: number;
    receivedBytes: number; // handed to the writer so far (may not be durable yet)
    checkpointedBytes: number; // durably committed to disk - safe to resume from
    bytesSinceCheckpoint: number;
    writer: FileSystemWritableFileStream | null;
    fileHandle: FileSystemFileHandle | null;
    bufferedChunks: Uint8Array[] | null;
    storedRecordKey: string | null;
    // Serializes writes/checkpoints against this transfer's file handle so a
    // periodic close+reopen never races with an in-flight chunk write.
    writeQueue: Promise<void>;
}

// Interface for PeerService callbacks/events
export interface IPeerServiceCallbacks {
    onPeerIdGenerated: (peerId: string) => void;
    onConnectionStatusChanged: (status: ConnectionStatus, peerId?: string, message?: string) => void;
    onDataReceived: (data: string, peerId: string) => void;
    onFileOffer: (offer: IncomingFileOffer) => void;
    onFileReceived: (file: ReceivedFile) => void;
    onFileRejected: (transferId: string) => void;
    onTransferProgress: (progress: number, bytesPerSecond?: number) => void;
}

export class PeerService {
    private peer: Peer | null = null;
    private currentConnection: DataConnection | null = null;
    private callbacks: IPeerServiceCallbacks;
    private outgoingTransfer: OutgoingTransfer | null = null;
    private incomingTransfer: IncomingTransfer | null = null;
    private outgoingRate = new RateTracker();
    private incomingRate = new RateTracker();

    constructor(callbacks: IPeerServiceCallbacks) {
        this.callbacks = callbacks;
    }

    public initializePeer(): void {
        // Cleanup existing peer if any
        this.destroyPeer();

        this.peer = new Peer();

        this.peer.on("open", (id) => {
            console.log("PeerService: Meu Peer ID é: " + id);
            this.callbacks.onPeerIdGenerated(id);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.WAITING);
        });

        this.peer.on("connection", (connection) => {
            console.log("PeerService: Conexão recebida de:", connection.peer);
            this.currentConnection = connection;
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.CONNECTED, connection.peer);
            this.setupConnectionHandlers(connection);
        });

        this.peer.on("error", (err) => {
            console.error("PeerService: Erro PeerJS:", err);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, undefined, err.message);
        });

        this.peer.on("disconnected", () => {
            console.log("PeerService: Desconectado do servidor PeerJS, tentando reconectar...");
            // PeerJS will attempt to reconnect automatically
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.CONNECTING, undefined, "Reconectando ao servidor PeerJS...");
        });

        this.peer.on("close", () => {
            console.log("PeerService: Instância Peer destruída.");
            // This is usually called when peer.destroy() is invoked
        });
    }

    public connectToPeer(targetPeerId: string): void {
        if (!this.peer || this.peer.disconnected) {
            console.error("PeerService: Instância PeerJS não inicializada ou desconectada.");
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, undefined, "PeerJS não inicializado.");
            return;
        }
        if (!targetPeerId) {
            console.error("PeerService: ID alvo não fornecido.");
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, undefined, "ID alvo inválido.");
            return;
        }
        if (this.currentConnection) {
            console.warn("PeerService: Já conectado a um peer. Desconecte primeiro.");
            return;
        }

        console.log(`PeerService: Tentando conectar a: ${targetPeerId}`);
        this.callbacks.onConnectionStatusChanged(ConnectionStatus.CONNECTING, targetPeerId);

        const connection = this.peer.connect(targetPeerId, {
            reliable: true // Use reliable connection for file transfer
        });

        connection.on("open", () => {
            console.log(`PeerService: Conexão estabelecida com ${targetPeerId}`);
            this.currentConnection = connection;
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.CONNECTED, targetPeerId);
            this.setupConnectionHandlers(connection);
        });

        // Error handler specifically for the connection attempt
        connection.on("error", (err) => {
            console.error("PeerService: Falha ao conectar:", err);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, targetPeerId, `Falha ao conectar: ${err.message}`);
            this.currentConnection = null; // Clear connection on error
        });
    }

    public disconnect(): void {
        if (this.currentConnection) {
            console.log(`PeerService: Fechando conexão com ${this.currentConnection.peer}`);
            this.currentConnection.close();
            // Status update will be handled by the 'close' event handler
        }
    }

    public destroyPeer(): void {
        if (this.peer) {
            console.log("PeerService: Destruindo instância Peer.");
            this.peer.destroy();
            this.peer = null;
            this.currentConnection = null;
            this.resetTransfers();
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.DISCONNECTED);
            this.callbacks.onPeerIdGenerated(""); // Clear peer ID
        }
    }

    /** Sends the initial offer for a file. The actual transfer only starts once the peer accepts it. */
    public sendFile(file: File): void {
        if (!this.currentConnection) {
            console.error("PeerService: Não conectado a nenhum peer.");
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, undefined, "Não conectado para enviar arquivo.");
            return;
        }
        if (this.outgoingTransfer) {
            console.warn("PeerService: Já existe um envio em andamento.");
            return;
        }

        const transferId = generateTransferId();
        this.outgoingTransfer = { transferId, file, cancelled: false };

        console.log(`PeerService: Oferecendo arquivo: ${file.name}, Tamanho: ${file.size}, Tipo: ${file.type}`);
        this.callbacks.onTransferProgress(0);

        const offer: FileOffer = {
            type: "file-offer",
            transferId,
            name: file.name,
            fileType: file.type || "application/octet-stream",
            size: file.size
        };
        this.currentConnection.send(offer);
    }

    /**
     * Called (from a user-gesture handler, e.g. a button click) to accept an incoming file offer.
     * On browsers that support it, opens a native save picker and streams the file straight to
     * disk as chunks arrive, so memory usage stays flat regardless of file size. Falls back to
     * buffering the whole file in memory (like before) on browsers without that API.
     *
     * Pass `resume: true` to continue a previously interrupted download of a matching file
     * instead of starting over (see `handleFileOffer`, which detects the match).
     */
    public async acceptIncomingFile(transferId: string, resume: boolean = false): Promise<void> {
        const incoming = this.incomingTransfer;
        if (!incoming || incoming.transferId !== transferId || !this.currentConnection) return;

        let resumeFromByte = 0;

        if (resume && incoming.storedRecordKey) {
            try {
                const stored = await getStoredTransfer(incoming.storedRecordKey);
                if (stored && (await ensureReadWritePermission(stored.fileHandle))) {
                    incoming.fileHandle = stored.fileHandle;
                    incoming.writer = await stored.fileHandle.createWritable({ keepExistingData: true });
                    await incoming.writer.seek(stored.bytesOnDisk);
                    incoming.receivedBytes = stored.bytesOnDisk;
                    incoming.checkpointedBytes = stored.bytesOnDisk;
                    resumeFromByte = stored.bytesOnDisk;
                } else {
                    console.warn("PeerService: Não foi possível retomar (permissão negada ou registro ausente); começando do zero.");
                }
            } catch (error) {
                console.warn("PeerService: Falha ao retomar transferência anterior, começando do zero.", error);
            }
        }

        if (!incoming.writer && supportsFileSystemAccess()) {
            try {
                const handle = await window.showSaveFilePicker!({ suggestedName: incoming.name });
                incoming.fileHandle = handle;
                incoming.writer = await handle.createWritable();
            } catch (error) {
                console.warn("PeerService: Salvamento direto em disco indisponível ou cancelado, usando buffer em memória.", error);
                incoming.writer = null;
                incoming.fileHandle = null;
            }
        }
        if (!incoming.writer) {
            incoming.bufferedChunks = [];
        } else if (incoming.fileHandle && incoming.storedRecordKey) {
            await putStoredTransfer({
                key: incoming.storedRecordKey,
                name: incoming.name,
                size: incoming.size,
                fileType: incoming.fileType,
                bytesOnDisk: incoming.checkpointedBytes,
                fileHandle: incoming.fileHandle,
                updatedAt: Date.now()
            }).catch((error) => console.error("PeerService: Erro ao registrar transferência para retomada:", error));
        }

        const accept: FileAccept = { type: "file-accept", transferId, resumeFromByte };
        this.currentConnection.send(accept);
    }

    public rejectIncomingFile(transferId: string): void {
        if (!this.incomingTransfer || this.incomingTransfer.transferId !== transferId) return;
        const reject: FileReject = { type: "file-reject", transferId };
        this.currentConnection?.send(reject);
        this.incomingTransfer = null;
    }

    public sendMessage(message: string): void {
         if (!this.currentConnection) {
            console.error("PeerService: Não conectado a nenhum peer.");
            return;
        }
        this.currentConnection.send(message);
    }

    // Private method to set up handlers for a new connection
    private setupConnectionHandlers(connection: DataConnection): void {
        connection.on("data", (data: unknown) => {
            this.handleReceivedData(data as PeerMessage, connection.peer);
        });

        connection.on("close", () => {
            console.log(`PeerService: Conexão com ${connection.peer} fechada.`);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.DISCONNECTED);
            this.currentConnection = null;
            this.resetTransfers();
            this.callbacks.onTransferProgress(0); // Reset progress on disconnect
        });

        connection.on("error", (err) => {
            console.error(`PeerService: Erro na conexão com ${connection.peer}:`, err);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, connection.peer, `Erro de conexão: ${err.message}`);
            this.callbacks.onTransferProgress(0);
            this.resetTransfers();
            if (this.currentConnection && this.currentConnection.peer === connection.peer) {
                this.currentConnection = null;
            }
        });
    }

    private resetTransfers(): void {
        this.outgoingTransfer = null;

        const incoming = this.incomingTransfer;
        this.incomingTransfer = null;
        if (incoming?.writer) {
            // Best-effort: commit whatever's been written so the download is resumable
            // later instead of throwing away partial progress.
            incoming.writeQueue = incoming.writeQueue
                .then(() => this.commitCheckpoint(incoming))
                .catch(() => incoming.writer?.abort().catch(() => undefined));
        }
    }

    // Reads the file in CHUNK_SIZE slices and streams them out, pausing whenever the
    // underlying RTCDataChannel's send buffer gets too full (so neither side has to hold
    // the whole file in memory to keep up).
    private beginSendingFile(transferId: string, resumeFromByte: number): void {
        const outgoing = this.outgoingTransfer;
        const connection = this.currentConnection;
        if (!outgoing || outgoing.transferId !== transferId || !connection) return;

        const { file } = outgoing;
        let offset = resumeFromByte;
        this.outgoingRate.reset();

        console.log(`PeerService: Oferta aceita, iniciando envio de ${file.name} a partir do byte ${offset}`);

        const sendNextChunk = async (): Promise<void> => {
            if (outgoing.cancelled || !this.currentConnection) return;

            const dataChannel = connection.dataChannel;
            if (dataChannel && dataChannel.bufferedAmount > MAX_BUFFERED_BYTES) {
                await waitForBufferDrain(dataChannel, MAX_BUFFERED_BYTES);
            }
            if (outgoing.cancelled || !this.currentConnection) return;

            if (offset >= file.size) {
                const endMessage: FileEnd = { type: "file-end", transferId };
                connection.send(endMessage);
                this.outgoingTransfer = null;
                console.log(`PeerService: Todos os chunks enviados para ${file.name}`);
                this.callbacks.onTransferProgress(100);
                setTimeout(() => this.callbacks.onTransferProgress(0), 1500);
                return;
            }

            try {
                const slice = file.slice(offset, offset + CHUNK_SIZE);
                const buffer = await slice.arrayBuffer();
                if (outgoing.cancelled || !this.currentConnection) return;
                // PeerJS's MsgPack serializer only recognizes typed-array views (ArrayBuffer.isView)
                // for efficient binary encoding; a raw ArrayBuffer gets encoded as a plain object.
                connection.send(new Uint8Array(buffer));
                offset += buffer.byteLength;
                const rate = this.outgoingRate.addBytes(buffer.byteLength);
                this.callbacks.onTransferProgress(Math.round((offset / file.size) * 100), rate);
                void sendNextChunk();
            } catch (error) {
                console.error("PeerService: Erro ao ler arquivo:", error);
                this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, connection.peer, `Erro ao ler arquivo: ${error}`);
                this.outgoingTransfer = null;
                this.callbacks.onTransferProgress(0);
            }
        };

        void sendNextChunk();
    }

    private async handleFileOffer(offer: FileOffer, peerId: string): Promise<void> {
        if (this.incomingTransfer) {
            console.warn("PeerService: Oferta de arquivo recebida com uma transferência já pendente; ignorando.");
            return;
        }
        console.log(`PeerService: Oferta de arquivo recebida: ${offer.name} (${offer.size} bytes) de ${peerId}`);
        this.incomingRate.reset();

        const storedRecordKey = supportsFileSystemAccess()
            ? makeTransferKey(offer.name, offer.size, offer.fileType)
            : null;
        let resumableBytes: number | undefined;
        if (storedRecordKey) {
            try {
                const stored = await getStoredTransfer(storedRecordKey);
                if (stored && stored.bytesOnDisk > 0 && stored.bytesOnDisk < offer.size) {
                    resumableBytes = stored.bytesOnDisk;
                }
            } catch (error) {
                console.warn("PeerService: Erro ao consultar transferências salvas:", error);
            }
        }

        this.incomingTransfer = {
            transferId: offer.transferId,
            peerId,
            name: offer.name,
            fileType: offer.fileType,
            size: offer.size,
            receivedBytes: 0,
            checkpointedBytes: 0,
            bytesSinceCheckpoint: 0,
            writer: null,
            fileHandle: null,
            bufferedChunks: null,
            storedRecordKey,
            writeQueue: Promise.resolve()
        };
        this.callbacks.onFileOffer({
            transferId: offer.transferId,
            peerId,
            name: offer.name,
            fileType: offer.fileType,
            size: offer.size,
            resumableBytes
        });
    }

    private handleFileReject(transferId: string): void {
        if (this.outgoingTransfer?.transferId === transferId) {
            this.outgoingTransfer.cancelled = true;
            this.outgoingTransfer = null;
        }
        this.callbacks.onFileRejected(transferId);
        this.callbacks.onTransferProgress(0);
    }

    // Closes the current writer to durably commit everything written so far, and
    // records that checkpoint in IndexedDB. Leaves `incoming.writer` null.
    private async commitCheckpoint(incoming: IncomingTransfer): Promise<void> {
        if (!incoming.writer || !incoming.fileHandle) return;
        const committedBytes = incoming.checkpointedBytes + incoming.bytesSinceCheckpoint;
        await incoming.writer.close();
        incoming.writer = null;
        incoming.checkpointedBytes = committedBytes;
        incoming.bytesSinceCheckpoint = 0;
        if (incoming.storedRecordKey) {
            await putStoredTransfer({
                key: incoming.storedRecordKey,
                name: incoming.name,
                size: incoming.size,
                fileType: incoming.fileType,
                bytesOnDisk: incoming.checkpointedBytes,
                fileHandle: incoming.fileHandle,
                updatedAt: Date.now()
            }).catch((error) => console.error("PeerService: Erro ao salvar checkpoint:", error));
        }
    }

    // Same as commitCheckpoint, but reopens the file (positioned at the end) so more
    // chunks can keep being written - used for periodic mid-transfer checkpoints.
    private async checkpointAndContinue(incoming: IncomingTransfer): Promise<void> {
        await this.commitCheckpoint(incoming);
        if (!incoming.fileHandle) return;
        incoming.writer = await incoming.fileHandle.createWritable({ keepExistingData: true });
        await incoming.writer.seek(incoming.checkpointedBytes);
    }

    private handleIncomingChunk(chunk: Uint8Array): void {
        const incoming = this.incomingTransfer;
        if (!incoming) {
            console.warn("PeerService: Chunk recebido sem transferência ativa; descartado.");
            return;
        }

        incoming.receivedBytes += chunk.byteLength;
        const progress = incoming.size > 0 ? Math.round((incoming.receivedBytes / incoming.size) * 100) : 0;
        const rate = this.incomingRate.addBytes(chunk.byteLength);
        this.callbacks.onTransferProgress(progress, rate);

        if (incoming.writer) {
            incoming.bytesSinceCheckpoint += chunk.byteLength;
            // Chain onto the same queue used for checkpoints so a close()/reopen() cycle
            // never runs concurrently with a write() on the handle it's replacing.
            incoming.writeQueue = incoming.writeQueue
                .then(() => incoming.writer!.write(chunk))
                .then(() => {
                    if (incoming.bytesSinceCheckpoint >= CHECKPOINT_INTERVAL_BYTES) {
                        return this.checkpointAndContinue(incoming);
                    }
                })
                .catch((error) => {
                    console.error("PeerService: Erro ao gravar chunk em disco:", error);
                    this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, incoming.peerId, "Erro ao salvar arquivo em disco.");
                });
        } else if (incoming.bufferedChunks) {
            incoming.bufferedChunks.push(chunk);
        }
    }

    private async handleFileEnd(transferId: string): Promise<void> {
        const incoming = this.incomingTransfer;
        if (!incoming || incoming.transferId !== transferId) return;

        this.incomingTransfer = null;

        if (incoming.writer) {
            try {
                await incoming.writeQueue;
                await incoming.writer.close();
                if (incoming.storedRecordKey) {
                    await deleteStoredTransfer(incoming.storedRecordKey).catch(() => undefined);
                }
                console.log(`PeerService: Arquivo ${incoming.name} salvo em disco (${incoming.receivedBytes} bytes).`);
                this.callbacks.onFileReceived({
                    id: incoming.transferId,
                    name: incoming.name,
                    type: incoming.fileType,
                    size: incoming.receivedBytes,
                    savedToDisk: true
                });
            } catch (error) {
                console.error("PeerService: Erro ao finalizar arquivo em disco:", error);
                this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, incoming.peerId, "Erro ao finalizar arquivo em disco.");
            }
        } else if (incoming.bufferedChunks) {
            const fileBlob = new Blob(incoming.bufferedChunks, { type: incoming.fileType });
            console.log(`PeerService: Arquivo ${incoming.name} recebido em memória (${fileBlob.size} bytes).`);
            this.callbacks.onFileReceived({
                id: incoming.transferId,
                name: incoming.name,
                type: incoming.fileType,
                size: fileBlob.size,
                blob: fileBlob
            });
        }

        this.callbacks.onTransferProgress(100);
        setTimeout(() => this.callbacks.onTransferProgress(0), 1500);
    }

    private handleControlMessage(message: FileControlMessage, peerId: string): void {
        switch (message.type) {
            case "file-offer":
                void this.handleFileOffer(message, peerId);
                break;
            case "file-accept":
                this.beginSendingFile(message.transferId, message.resumeFromByte ?? 0);
                break;
            case "file-reject":
                this.handleFileReject(message.transferId);
                break;
            case "file-end":
                void this.handleFileEnd(message.transferId);
                break;
            default:
                console.warn("PeerService: Mensagem de controle desconhecida recebida:", message);
        }
    }

    // Private method to process received data
    private handleReceivedData(data: PeerMessage, peerId: string): void {
        if (data instanceof Uint8Array) {
            this.handleIncomingChunk(data);
            return;
        }
        if (data instanceof ArrayBuffer) {
            this.handleIncomingChunk(new Uint8Array(data));
            return;
        }
        if (data instanceof Blob) {
            data.arrayBuffer()
                .then((buffer) => this.handleIncomingChunk(new Uint8Array(buffer)))
                .catch((error) => console.error("PeerService: Erro ao ler chunk recebido como Blob:", error));
            return;
        }
        if (typeof data === "string") {
            this.callbacks.onDataReceived(data, peerId);
            return;
        }
        if (data && typeof data === "object" && "type" in data) {
            this.handleControlMessage(data as FileControlMessage, peerId);
            return;
        }
        console.warn("PeerService: Mensagem de tipo desconhecido recebida:", data);
    }
}
