import { Peer, DataConnection } from "peerjs";
import { ConnectionStatus, PeerMessage, ReceivedFile, FileChunk, FileCompletionSignal, SimpleFileData } from "../models/PeerData";
import { saveAs } from "file-saver";

// Interface for PeerService callbacks/events
export interface IPeerServiceCallbacks {
    onPeerIdGenerated: (peerId: string) => void;
    onConnectionStatusChanged: (status: ConnectionStatus, peerId?: string, message?: string) => void;
    onDataReceived: (data: PeerMessage, peerId: string) => void;
    onFileReceived: (file: ReceivedFile) => void;
    onTransferProgress: (progress: number) => void;
}

export class PeerService {
    private peer: Peer | null = null;
    private currentConnection: DataConnection | null = null;
    private fileChunks: Map<string, ArrayBuffer[]> = new Map(); // Store incoming file chunks
    private callbacks: IPeerServiceCallbacks;

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
            // connection.send("Olá do outro lado!"); // Test message
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
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.DISCONNECTED);
            this.callbacks.onPeerIdGenerated(""); // Clear peer ID
        }
    }

    public sendFile(file: File): void {
        if (!this.currentConnection) {
            console.error("PeerService: Não conectado a nenhum peer.");
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, undefined, "Não conectado para enviar arquivo.");
            return;
        }

        console.log(`PeerService: Enviando arquivo: ${file.name}, Tamanho: ${file.size}, Tipo: ${file.type}`);
        this.callbacks.onTransferProgress(0);

        const chunkSize = 64 * 1024; // 64KB chunks
        const totalChunks = Math.ceil(file.size / chunkSize);
        let chunkIndex = 0;
        let offset = 0;
        const fileReader = new FileReader();

        fileReader.onload = (e) => {
            if (!e.target?.result || !this.currentConnection) return;

            const chunk = e.target.result as ArrayBuffer;
            const fileChunkData: FileChunk = {
                name: file.name,
                type: file.type,
                size: file.size,
                payload: chunk,
                isChunk: true,
                chunkIndex: chunkIndex,
                totalChunks: totalChunks
            };

            console.log(`PeerService: Enviando chunk ${chunkIndex + 1}/${totalChunks}`);
            this.currentConnection.send(fileChunkData);
            chunkIndex++;
            this.callbacks.onTransferProgress(Math.round((chunkIndex / totalChunks) * 100));

            if (offset < file.size) {
                readNextChunk();
            } else {
                console.log(`PeerService: Todos os chunks enviados para ${file.name}`);
                // Send completion signal
                const completionSignal: FileCompletionSignal = {
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    isComplete: true
                };
                this.currentConnection.send(completionSignal);
            }
        };

        fileReader.onerror = (error) => {
            console.error("PeerService: Erro ao ler arquivo:", error);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, this.currentConnection?.peer, `Erro ao ler arquivo: ${error}`);
            this.callbacks.onTransferProgress(0);
        };

        const readNextChunk = () => {
            const slice = file.slice(offset, offset + chunkSize);
            fileReader.readAsArrayBuffer(slice);
            offset += chunkSize;
        };

        readNextChunk(); // Start reading the first chunk
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
            console.log("PeerService: Dados recebidos:", typeof data);
            this.handleReceivedData(data as PeerMessage, connection.peer);
        });

        connection.on("close", () => {
            console.log(`PeerService: Conexão com ${connection.peer} fechada.`);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.DISCONNECTED);
            this.currentConnection = null;
            this.callbacks.onTransferProgress(0); // Reset progress on disconnect
            this.fileChunks.clear(); // Clear any partial transfers
        });

        connection.on("error", (err) => {
            console.error(`PeerService: Erro na conexão com ${connection.peer}:`, err);
            this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, connection.peer, `Erro de conexão: ${err.message}`);
            this.callbacks.onTransferProgress(0);
            this.fileChunks.clear();
            // Consider closing the connection if it's still open
            if (this.currentConnection && this.currentConnection.peer === connection.peer) {
                this.currentConnection = null;
            }
        });
    }

    // Private method to process received data
    private handleReceivedData(data: PeerMessage, peerId: string): void {
        const fileId = `${peerId}-${(data as any).name}`; // Common identifier

        // Check if it's an object and potentially related to file transfer
        if (typeof data === "object" && !(data instanceof ArrayBuffer) && !(data instanceof Blob) && (data as any).name) {
            const fileData = data as Partial<FileChunk | FileCompletionSignal | SimpleFileData>;

            // Handle chunk data (must have payload)
            if (fileData.isChunk && fileData.payload) {
                if (!this.fileChunks.has(fileId)) {
                    this.fileChunks.set(fileId, new Array(fileData.totalChunks).fill(null));
                }
                const chunks = this.fileChunks.get(fileId)!;
                if (typeof fileData.chunkIndex === "number" && fileData.chunkIndex >= 0 && fileData.chunkIndex < chunks.length) {
                    chunks[fileData.chunkIndex] = fileData.payload as ArrayBuffer;
                } else {
                    console.error(`PeerService: Índice de chunk inválido recebido: ${fileData.chunkIndex} para ${fileData.name}`);
                }
                const receivedChunks = chunks.filter(c => c !== null).length;
                const progress = Math.round((receivedChunks / fileData.totalChunks!) * 100);
                this.callbacks.onTransferProgress(progress);
                console.log(`PeerService: Recebido chunk ${fileData.chunkIndex! + 1}/${fileData.totalChunks} para ${fileData.name} (${progress}%)`);

            // Handle completion signal
            } else if (fileData.isComplete) {
                console.log(`PeerService: Sinal de conclusão recebido para ${fileData.name}`);
                const chunks = this.fileChunks.get(fileId);
                if (chunks && chunks.every(c => c !== null)) {
                    const fileBlob = new Blob(chunks, { type: fileData.type });
                    console.log(`PeerService: Arquivo ${fileData.name} recebido completamente (chunked). Tamanho: ${fileBlob.size}`);
                    const receivedFile: ReceivedFile = {
                        id: fileId,
                        name: fileData.name!,
                        type: fileData.type!,
                        size: fileBlob.size,
                        blob: fileBlob
                    };
                    this.callbacks.onFileReceived(receivedFile);
                    this.fileChunks.delete(fileId);
                    this.callbacks.onTransferProgress(100);
                    setTimeout(() => this.callbacks.onTransferProgress(0), 2000);
                } else {
                    console.error(`PeerService: Erro ao remontar arquivo ${fileData.name}: chunks faltando ou inválidos.`);
                    this.callbacks.onConnectionStatusChanged(ConnectionStatus.ERROR, peerId, `Erro ao receber ${fileData.name}`);
                    this.fileChunks.delete(fileId);
                    this.callbacks.onTransferProgress(0);
                }
            // Handle non-chunked file data (simple transfer, must have payload)
            } else if (fileData.payload && !(fileData.isChunk || fileData.isComplete)) {
                const simpleFileData = fileData as SimpleFileData;
                const fileBlob = new Blob([simpleFileData.payload], { type: simpleFileData.type });
                console.log(`PeerService: Arquivo ${simpleFileData.name} recebido (transferência simples). Tamanho: ${fileBlob.size}`);
                 const receivedFile: ReceivedFile = {
                        id: fileId,
                        name: simpleFileData.name,
                        type: simpleFileData.type,
                        size: fileBlob.size,
                        blob: fileBlob
                    };
                this.callbacks.onFileReceived(receivedFile);
                this.callbacks.onTransferProgress(100);
                setTimeout(() => this.callbacks.onTransferProgress(0), 2000);
            } else {
                 console.warn("PeerService: Objeto de dados de arquivo inesperado recebido:", data);
            }
        // Handle raw binary data
        } else if (data instanceof ArrayBuffer || data instanceof Blob) {
            console.log("PeerService: Dados binários brutos recebidos.");
            try {
                const blob = data instanceof Blob ? data : new Blob([data]);
                // We don't have metadata, maybe notify ViewModel/UI to ask user for filename?
                // For now, just save with a generic name.
                saveAs(blob, "received_binary_data");
                console.log("PeerService: Tentativa de download iniciada para dados binários brutos.");
            } catch (error) {
                console.error("PeerService: Falha ao tentar baixar dados binários brutos:", error);
            }
        // Handle simple string messages or other types
        } else {
            console.log("PeerService: Mensagem ou tipo de dados desconhecido recebido:", data);
            // Pass non-file data up through the callback
            this.callbacks.onDataReceived(data, peerId);
        }
    }
}

