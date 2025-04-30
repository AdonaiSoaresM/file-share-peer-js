import { useState, useEffect, useCallback, useRef } from "react";
import { PeerService, IPeerServiceCallbacks } from "../services/PeerService";
import { ConnectionStatus, ReceivedFile } from "../models/PeerData";
import { saveAs } from "file-saver";

export function usePeerViewModel() {
    const [myPeerId, setMyPeerId] = useState<string>("");
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
    const [connectionMessage, setConnectionMessage] = useState<string>(""); // Optional message with status
    const [connectedPeerId, setConnectedPeerId] = useState<string | null>(null);
    const [receivedFiles, setReceivedFiles] = useState<Map<string, ReceivedFile>>(new Map());
    const [transferProgress, setTransferProgress] = useState<number>(0);
    const [lastReceivedMessage, setLastReceivedMessage] = useState<string>("");

    // Use useRef to hold the PeerService instance to avoid re-creation on re-renders
    const peerServiceRef = useRef<PeerService | null>(null);

    // Callbacks for PeerService
    const peerServiceCallbacks = useRef<IPeerServiceCallbacks>({
        onPeerIdGenerated: (peerId) => {
            console.log("ViewModel: Peer ID Generated", peerId);
            setMyPeerId(peerId);
        },
        onConnectionStatusChanged: (status, peerId, message) => {
            console.log("ViewModel: Connection Status Changed", status, peerId, message);
            setConnectionStatus(status);
            setConnectedPeerId(peerId || null);
            setConnectionMessage(message || "");
            if (status === ConnectionStatus.DISCONNECTED || status === ConnectionStatus.ERROR) {
                // Clear related state on disconnect/error
                setConnectedPeerId(null);
                setTransferProgress(0);
                // Optionally clear received files or keep them?
                // setReceivedFiles(new Map());
            }
        },
        onDataReceived: (data, peerId) => {
            console.log("ViewModel: Data Received from", peerId, data);
            // Handle simple messages or other non-file data
            if (typeof data === "string") {
                setLastReceivedMessage(`Mensagem de ${peerId}: ${data}`);
            } else {
                setLastReceivedMessage(`Dados (tipo: ${typeof data}) recebidos de ${peerId}`);
            }
        },
        onFileReceived: (file) => {
            console.log("ViewModel: File Received", file.name);
            setReceivedFiles(prev => new Map(prev).set(file.id, file));
            // Reset progress after a short delay to show completion
            setTransferProgress(100);
            setTimeout(() => setTransferProgress(0), 2500);
        },
        onTransferProgress: (progress) => {
            // console.log("ViewModel: Transfer Progress", progress);
            setTransferProgress(progress);
        }
    }).current; // .current ensures the object identity is stable

    // Initialize PeerService on mount
    useEffect(() => {
        console.log("ViewModel: Initializing PeerService");
        peerServiceRef.current = new PeerService(peerServiceCallbacks);
        peerServiceRef.current.initializePeer();

        // Cleanup on unmount
        return () => {
            console.log("ViewModel: Cleaning up PeerService");
            peerServiceRef.current?.destroyPeer();
            peerServiceRef.current = null;
        };
    }, [peerServiceCallbacks]); // Dependency array includes stable callbacks ref

    // Actions callable from the View
    const connect = useCallback((targetPeerId: string) => {
        if (!targetPeerId) {
            console.warn("ViewModel: Connect called with empty target ID");
            // Optionally set an error state here
            return;
        }
        console.log("ViewModel: Attempting to connect to", targetPeerId);
        peerServiceRef.current?.connectToPeer(targetPeerId);
    }, []);

    const disconnect = useCallback(() => {
        console.log("ViewModel: Attempting to disconnect");
        peerServiceRef.current?.disconnect();
    }, []);

    const sendFile = useCallback((file: File | null) => {
        if (!file) {
            console.warn("ViewModel: SendFile called with no file selected");
            // Optionally set an error state here
            return;
        }
        console.log("ViewModel: Attempting to send file", file.name);
        peerServiceRef.current?.sendFile(file);
    }, []);

    const downloadFile = useCallback((fileId: string) => {
        const fileInfo = receivedFiles.get(fileId);
        if (fileInfo) {
            console.log("ViewModel: Downloading file", fileInfo.name);
            saveAs(fileInfo.blob, fileInfo.name);
        } else {
            console.warn("ViewModel: DownloadFile called with invalid file ID", fileId);
        }
    }, [receivedFiles]);

    const sendMessage = useCallback((message: string) => {
        if (!message) return;
        console.log("ViewModel: Sending message", message);
        peerServiceRef.current?.sendMessage(message);
    }, []);

    // Expose state and actions
    return {
        myPeerId,
        connectionStatus,
        connectionMessage,
        connectedPeerId,
        receivedFiles,
        transferProgress,
        lastReceivedMessage,
        connect,
        disconnect,
        sendFile,
        downloadFile,
        sendMessage
    };
}

