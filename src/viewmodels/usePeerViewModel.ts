import { useState, useEffect, useCallback, useRef } from "react";
import { PeerService, IPeerServiceCallbacks, supportsFileSystemAccess } from "../services/PeerService";
import { ConnectionStatus, ReceivedFile, IncomingFileOffer } from "../models/PeerData";
import { saveAs } from "file-saver";

export function usePeerViewModel() {
    const [myPeerId, setMyPeerId] = useState<string>("");
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
    const [connectionMessage, setConnectionMessage] = useState<string>(""); // Optional message with status
    const [connectedPeerId, setConnectedPeerId] = useState<string | null>(null);
    const [receivedFiles, setReceivedFiles] = useState<Map<string, ReceivedFile>>(new Map());
    const [transferProgress, setTransferProgress] = useState<number>(0);
    const [lastReceivedMessage, setLastReceivedMessage] = useState<string>("");
    const [incomingOffer, setIncomingOffer] = useState<IncomingFileOffer | null>(null);
    const [awaitingAcceptance, setAwaitingAcceptance] = useState<boolean>(false);
    const [transferNotice, setTransferNotice] = useState<{ message: string; id: number } | null>(null);

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
                setIncomingOffer(null);
                setAwaitingAcceptance(false);
            }
        },
        onDataReceived: (data, peerId) => {
            console.log("ViewModel: Data Received from", peerId, data);
            setLastReceivedMessage(`Mensagem de ${peerId}: ${data}`);
        },
        onFileOffer: (offer) => {
            console.log("ViewModel: File Offer Received", offer.name);
            setIncomingOffer(offer);
        },
        onFileReceived: (file) => {
            console.log("ViewModel: File Received", file.name);
            setReceivedFiles(prev => new Map(prev).set(file.id, file));
            setIncomingOffer(null);
            // Reset progress after a short delay to show completion
            setTransferProgress(100);
            setTimeout(() => setTransferProgress(0), 2500);
        },
        onFileRejected: (transferId) => {
            console.log("ViewModel: File Rejected", transferId);
            setAwaitingAcceptance(false);
            setTransferNotice({ message: "O destinatário recusou o arquivo.", id: Date.now() });
        },
        onTransferProgress: (progress) => {
            if (progress > 0) setAwaitingAcceptance(false);
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
            return;
        }
        console.log("ViewModel: Attempting to send file", file.name);
        setAwaitingAcceptance(true);
        peerServiceRef.current?.sendFile(file);
    }, []);

    // Must be called directly from a user-gesture handler (e.g. a button's onClick) so the
    // browser's native save-file picker is allowed to open.
    const acceptIncomingFile = useCallback(() => {
        if (!incomingOffer) return;
        console.log("ViewModel: Accepting incoming file", incomingOffer.name);
        void peerServiceRef.current?.acceptIncomingFile(incomingOffer.transferId);
        setIncomingOffer(null);
    }, [incomingOffer]);

    const rejectIncomingFile = useCallback(() => {
        if (!incomingOffer) return;
        console.log("ViewModel: Rejecting incoming file", incomingOffer.name);
        peerServiceRef.current?.rejectIncomingFile(incomingOffer.transferId);
        setIncomingOffer(null);
    }, [incomingOffer]);

    const downloadFile = useCallback((fileId: string) => {
        const fileInfo = receivedFiles.get(fileId);
        if (fileInfo?.blob) {
            console.log("ViewModel: Downloading file", fileInfo.name);
            saveAs(fileInfo.blob, fileInfo.name);
        } else {
            console.warn("ViewModel: DownloadFile called with invalid file ID or file already saved to disk", fileId);
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
        incomingOffer,
        awaitingAcceptance,
        transferNotice,
        supportsStreamingSave: supportsFileSystemAccess(),
        connect,
        disconnect,
        sendFile,
        acceptIncomingFile,
        rejectIncomingFile,
        downloadFile,
        sendMessage
    };
}
