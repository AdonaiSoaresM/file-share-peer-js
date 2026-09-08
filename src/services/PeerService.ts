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

// Read in 1MB slices - large enough to keep FileReader/JS overhead low,
// small enough to keep at most a couple of slices in memory at once.
const CHUNK_SIZE = 1024 * 1024;
// Application-level backpressure: pause reading/sending more of the file
// once this many bytes are still queued in the underlying RTCDataChannel.
// Kept below PeerJS's own internal buffer cap so we throttle before it does.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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
    receivedBytes: number;
    writer: FileSystemWritableFileStream | null;
    bufferedChunks: Uint8Array[] | null;
}

// Interface for PeerService callbacks/events
export interface IPeerServiceCallbacks {
    onPeerIdGenerated: (peerId: string) => void;
    onConnectionStatusChanged: (status: ConnectionStatus, peerId?: string, message?: string) => void;
    onDataReceived: (data: string, peerId: string) => void;
    onFileOffer: (offer: IncomingFileOffer) => void;
    onFileReceived: (file: ReceivedFile) => void;
    onFileRejected: (transferId: string) => void;
    onTransferProgress: (progress: number) => void;
}

export class PeerService {
    private peer: Peer | null = null;
    private currentConnection: DataConnection | null = null;
    private callbacks: IPeerServiceCallbacks;
    private outgoingTransfer: OutgoingTransfer | null = null;
    private incomingTransfer: IncomingTransfer | null = null;

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
     */
    public async acceptIncomingFile(transferId: string): Promise<void> {
        const incoming = this.incomingTransfer;
        if (!incoming || incoming.transferId !== transferId || !this.currentConnection) return;

        if (supportsFileSystemAccess()) {
            try {
                const handle = await window.showSaveFilePicker!({ suggestedName: incoming.name });
                incoming.writer = await handle.createWritable();
            } catch (error) {
                console.warn("PeerService: Salvamento direto em disco indisponível ou cancelado, usando buffer em memória.", error);
                incoming.writer = null;
            }
        }
        if (!incoming.writer) {
            incoming.bufferedChunks = [];
        }

        const accept: FileAccept = { type: "file-accept", transferId };
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
        if (this.incomingTransfer?.writer) {
            void this.incomingTransfer.writer.abort().catch(() => undefined);
        }
        this.incomingTransfer = null;
    }

    // Reads the file in CHUNK_SIZE slices and streams them out, pausing whenever the
    // underlying RTCDataChannel's send buffer gets too full (so neither side has to hold
    // the whole file in memory to keep up).
    private beginSendingFile(transferId: string): void {
        const outgoing = this.outgoingTransfer;
        const connection = this.currentConnection;
        if (!outgoing || outgoing.transferId !== transferId || !connection) return;

        const { file } = outgoing;
        let offset = 0;

        console.log(`PeerService: Oferta aceita, iniciando envio de ${file.name}`);

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
                this.callbacks.onTransferProgress(Math.round((offset / file.size) * 100));
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

    private handleFileOffer(offer: FileOffer, peerId: string): void {
        if (this.incomingTransfer) {
            console.warn("PeerService: Oferta de arquivo recebida com uma transferência já pendente; ignorando.");
            return;
        }
        console.log(`PeerService: Oferta de arquivo recebida: ${offer.name} (${offer.size} bytes) de ${peerId}`);
        this.incomingTransfer = {
            transferId: offer.transferId,
            peerId,
            name: offer.name,
            fileType: offer.fileType,
            size: offer.size,
            receivedBytes: 0,
            writer: null,
            bufferedChunks: null
        };
        this.callbacks.onFileOffer({
            transferId: offer.transferId,
            peerId,
            name: offer.name,
            fileType: offer.fileType,
            size: offer.size
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

    private handleIncomingChunk(chunk: Uint8Array): void {
        const incoming = this.incomingTransfer;
        if (!incoming) {
            console.warn("PeerService: Chunk recebido sem transferência ativa; descartado.");
            return;
        }

        incoming.receivedBytes += chunk.byteLength;
        const progress = incoming.size > 0 ? Math.round((incoming.receivedBytes / incoming.size) * 100) : 0;
        this.callbacks.onTransferProgress(progress);

        if (incoming.writer) {
            incoming.writer.write(chunk).catch((error) => {
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
                await incoming.writer.close();
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
                this.handleFileOffer(message, peerId);
                break;
            case "file-accept":
                this.beginSendingFile(message.transferId);
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
